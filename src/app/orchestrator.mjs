// The pipeline: ticket in -> Flyo subscribe -> readiness -> chase traveller -> Flyo update -> boarding pass out.
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../shared/env.mjs';
import { airport, countryName, SCHENGEN } from '../shared/airports.mjs';
import { TRANSIT_RULES_IN } from './readiness/travelRules.mjs';
import { wallClockToUtc } from '../shared/time.mjs';
import { validateJourney } from '../shared/journey.mjs';
import { extractTicket, splitJourneys } from './extract/ticket.mjs';
import { extractDocument } from './extract/documents.mjs';
import { evaluateReadiness } from './readiness/evaluate.mjs';
import { bestPassengerMatch } from './readiness/names.mjs';
import { createFlyoClient, FlyoError } from './flyoClient.mjs';
import { sendToTraveller } from './messaging.mjs';
import { insertBooking, touch, activity, getBooking, listBookings, findBookingByCheckin, saveFile, readStoredFile, markEventSeen } from './store.mjs';

const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/;
const TERMINAL = new Set(['FAILED', 'CANCELLED']);

const flyo = createFlyoClient({
  onCall: (entry) => {
    const b = entry.context && getBooking(entry.context);
    if (!b) return;
    touch(b, (x) => {
      const last = x.api[x.api.length - 1];
      const response = truncate(entry.response);
      // Collapse identical consecutive polls so the log stays readable.
      if (last && entry.method === 'GET' && last.method === 'GET' && last.path === entry.path && last.status === entry.status
        && JSON.stringify(last.response) === JSON.stringify(response)) {
        last.repeat = (last.repeat || 1) + 1;
        last.at = new Date().toISOString();
        return;
      }
      x.api.push({ at: new Date().toISOString(), ...entry, response });
      if (x.api.length > 60) x.api.splice(0, x.api.length - 60);
    });
  },
});

const truncate = (v) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 6000 ? { _truncated: true, preview: s.slice(0, 6000) } : v;
};

const paxName = (p) => `${p.first_name} ${p.last_name}`;
const firstName = (b) => b.contact?.name?.split(' ')[0] || b.passengers[0]?.first_name || 'there';
const passengerHash = (b) => createHash('sha1').update(JSON.stringify(b.passengers)).digest('hex');
const toUtc = (code, wall) => { const a = airport(code); return a ? wallClockToUtc(wall, a.tz) : null; };
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '?');

function withUtc(legs) {
  return legs.map((l) => ({
    ...l,
    departure_utc: toUtc(l.origin, l.departure_datetime)?.toISOString() || null,
    arrival_utc: l.arrival_datetime ? toUtc(l.destination, l.arrival_datetime)?.toISOString() || null : null,
  }));
}

// A ticket with a return flight becomes several one-way bookings (a "group"), because Flyo only supports
// one-way journeys. The traveller has ONE conversation, stored on the group's first booking.
const groupOf = (b) => listBookings().filter((x) => x.group === b.group).sort((x, y) => x.journey_index - y.journey_index);
const primaryOf = (b) => groupOf(b)[0] || b;
const convoOf = (b) => primaryOf(b).convo;
const say = (b, msg) => sendToTraveller(primaryOf(b), msg);
/** The booking in the group the traveller should answer next: the first one that still needs something. */
const conversationTarget = (b) => groupOf(b).find((x) => x.readiness?.needs.length) || primaryOf(b);

function alertAgent(b, level, text) {
  touch(b, (x) => x.alerts.push({ id: randomUUID(), at: new Date().toISOString(), level, text, resolved: false }));
  activity(b, 'alert', text, { level });
}

// ================================================================== ingest
export async function ingestTicket({ file, text, contact, sourceKind }) {
  const stored = file ? await saveFile(file) : null;
  const draft = await extractTicket({ text, file });
  if (!draft.flights.length) throw Object.assign(new Error(`Couldn't find any flights in that ticket. ${draft.warnings.join('; ')}`), { status: 422 });
  if (!draft.passengers.length) throw Object.assign(new Error(`Couldn't find passenger names in that ticket. ${draft.warnings.join('; ')}`), { status: 422 });

  const journeys = splitJourneys(draft.flights, toUtc);
  const group = randomUUID().slice(0, 8);
  const created = [];
  for (const [ji, legs] of journeys.entries()) {
    const b = insertBooking({
      id: randomUUID().slice(0, 12),
      group, journey_index: ji, journey_count: journeys.length,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      source: { kind: sourceKind || (file ? (file.mime === 'application/pdf' ? 'pdf' : 'image') : 'text'), name: file?.name || 'Pasted text', fileId: stored?.id || null, extractor: draft.source, warnings: draft.warnings },
      pnr: draft.pnr,
      flights: withUtc(legs),
      passengers: draft.passengers.map((p) => ({ ...p, passport: null, documents: [], declined: {} })),
      contact: { name: contact?.name || paxName(draft.passengers[0]), phone: contact?.phone || draft.passengers[0]?.phone || '' },
      readiness: null,
      flyo: { checkin_id: null, booking_id: null, status: 'NOT_SUBSCRIBED', sub_status: '', checkin_message: '', missing_info: [], boarding_passes: [], history: [], lastPushedHash: null, lastEventAt: null, error: null },
      override: false, alerts: [], thread: [], activity: [], api: [], convo: { asked: null, told: {}, greeted: false }, delivered: { passes: false },
    });
    activity(b, 'ingest', `Ticket read by ${draft.source === 'llm' ? 'vision LLM' : 'built-in parser'}: PNR ${draft.pnr || '?'}, ${legs.length} leg(s), ${draft.passengers.length} passenger(s)${journeys.length > 1 ? `. Journey ${ji + 1} of ${journeys.length}: Flyo supports one-way only, so each direction gets its own check-in` : ''}`);
    if (draft.warnings.length) activity(b, 'warn', `Extraction notes: ${draft.warnings.join('; ')}`);
    created.push(b);
  }
  for (const b of created) { recompute(b); await subscribe(b); recompute(b); }
  await greetTraveller(created[0], created.length);
  for (const b of created) await afterChange(b, { quiet: true });
  return created;
}

function recompute(b) {
  touch(b, (x) => { x.readiness = evaluateReadiness(x); });
  return b.readiness;
}

// ================================================================== Flyo: subscribe
async function subscribe(b) {
  const journey = validateJourney(b.flights);
  if (!journey.ok) {
    // Pre-flight the documented journey rules locally so we never spend quota on a guaranteed 422.
    touch(b, (x) => { x.flyo.status = 'NOT_SUBSCRIBED'; x.flyo.error = `${journey.reason_code || journey.error}: ${journey.message}`; });
    alertAgent(b, 'fail', `Not sent to Flyo: ${journey.message}${journey.reason_code === 'DEPARTURE_TOO_CLOSE' ? '. Do this check-in manually.' : ''}`);
    return;
  }
  try {
    const res = await flyo.subscribe({
      pnr: b.pnr, legs: journey.legs, passengers: b.passengers,
      callbackUrl: `${config.app.publicUrl}/webhooks/flyo`, context: b.id,
    });
    touch(b, (x) => {
      x.flyo.checkin_id = res.checkin_id;
      x.flyo.booking_id = res.booking_id;
      x.flyo.quota = res.quota || x.flyo.quota || null;
      x.flyo.lastPushedHash = passengerHash(x);
      x.flyo.error = null;
    });
    activity(b, 'flyo', `Subscribed to Flyo: ${res.message} (checkin_id ${res.checkin_id}, booking_id ${res.booking_id})${res.quota ? `; quota ${res.quota.consumed_units}/${res.quota.included_units}` : ''}`);
    applyStatus(b, { status: res.status, sub_status: res.sub_status, checkin_message: res.status_message, missing_info: res.missing_info || [], boarding_passes: [] }, 'subscribe');
  } catch (err) {
    await handleFlyoError(b, err, 'subscribe');
  }
}

async function handleFlyoError(b, err, op) {
  if (!(err instanceof FlyoError)) throw err;
  const msg = `${err.code || err.status}${err.reason ? `/${err.reason}` : ''}: ${err.message}`;
  touch(b, (x) => { x.flyo.error = `${op} failed: ${msg}`; });
  if (err.uncertain || err.status >= 500 || err.status === 0) {
    // Docs: a 500/timeout does not prove nothing was saved. Reconcile before any retry.
    activity(b, 'flyo', `${op} result uncertain (${msg}); reconciling with Flyo before retrying`);
    if (op === 'subscribe') await reconcileSubscription(b);
    else await refreshStatus(b);
    return;
  }
  if (err.status === 402) alertAgent(b, 'fail', `Flyo entitlement/quota problem (${err.code}). Check the partner dashboard.`);
  else if (err.status === 409) { activity(b, 'flyo', `Flyo says ${err.code}; stopped updating and fetched the latest status`); await refreshStatus(b); }
  else if (err.reason === 'DEPARTURE_TOO_CLOSE') { alertAgent(b, 'fail', 'Details saved at Flyo, but departure is under 6 hours away so automation cannot resume. Check in manually.'); await refreshStatus(b); }
  else if (err.status === 401) alertAgent(b, 'fail', 'Flyo rejected the API key (401). Check FLYO_API_KEY.');
  else alertAgent(b, 'fail', `Flyo ${op} rejected: ${msg}`);
}

/** After an uncertain subscribe, look for the booking in /requests (PNR + first-leg local departure). */
async function reconcileSubscription(b) {
  try {
    const want = b.flights[0].departure_datetime;
    for (let page = 0; page < 5; page++) {
      const res = await flyo.requests({ page, limit: 100, context: b.id });
      // departure_datetime in summaries carries a legacy Z suffix but is still origin-local wall clock.
      const hit = res.data.find((r) => r.pnr === b.pnr && String(r.departure_datetime).replace(/Z$/, '').slice(0, 19) === want);
      if (hit) {
        touch(b, (x) => { x.flyo.checkin_id = hit.checkin_id; x.flyo.booking_id = hit.booking_id; x.flyo.error = null; });
        applyStatus(b, hit, 'reconcile');
        activity(b, 'flyo', `Found existing Flyo attempt ${hit.checkin_id}; not resubscribing`);
        return;
      }
      if (page + 1 >= res.pagination.totalPages) break;
    }
    alertAgent(b, 'warn', 'Subscribe outcome unknown and no matching attempt found. Use "Retry subscribe" once Flyo is reachable.');
  } catch (e) {
    alertAgent(b, 'warn', `Could not reconcile with Flyo (${e.message}). Retry later.`);
  }
}

// ================================================================== Flyo: status, webhooks, polling
export async function refreshStatus(b) {
  if (!b.flyo.checkin_id) return;
  try {
    const s = await flyo.status({ checkinId: b.flyo.checkin_id, context: b.id });
    applyStatus(b, s, 'status');
  } catch (err) {
    if (err instanceof FlyoError) touch(b, (x) => { x.flyo.error = `status: ${err.message}`; });
  }
}

function applyStatus(b, s, source) {
  const before = `${b.flyo.status}/${b.flyo.sub_status}/${(b.flyo.boarding_passes || []).length}`;
  touch(b, (x) => {
    x.flyo.status = s.status;
    x.flyo.sub_status = s.sub_status || '';
    x.flyo.checkin_message = s.checkin_message || '';
    x.flyo.missing_info = s.missing_info || [];
    x.flyo.boarding_passes = s.boarding_passes || [];
    x.flyo.last_updated = s.last_updated || new Date().toISOString();
  });
  const after = `${b.flyo.status}/${b.flyo.sub_status}/${b.flyo.boarding_passes.length}`;
  if (before !== after) {
    touch(b, (x) => x.flyo.history.push({ at: new Date().toISOString(), status: s.status, sub_status: s.sub_status || '', source }));
    if (source !== 'subscribe') activity(b, 'flyo', `Flyo status ${s.status}${s.sub_status ? ` / ${s.sub_status}` : ''} (via ${source})${s.checkin_message ? `: ${s.checkin_message}` : ''}`);
    onStatusTransition(b).catch((e) => console.error('[preflight] transition handler', e));
  }
}

async function onStatusTransition(b) {
  const f = b.flyo;
  const told = convoOf(b).told;
  const route = `${b.flights[0].origin} → ${b.flights[b.flights.length - 1].destination}`;
  if (f.status === 'COMPLETED' && f.boarding_passes.length && !b.delivered.passes) {
    touch(b, (x) => { x.delivered.passes = true; });
    // Flyo's boarding_passes is a flat array with no passenger/segment mapping, so passes are not labelled per person.
    await say(b, {
      text: `You're checked in for ${route} (${b.flights.map((l) => `${l.airline} ${l.flight_number}`).join(' + ')}). Here ${f.boarding_passes.length === 1 ? 'is your boarding pass' : `are your ${f.boarding_passes.length} boarding passes`}. Have a great trip! ✈️`,
      media: f.boarding_passes.map((url, i) => ({ url, mime: 'image/svg+xml', name: `Boarding pass ${i + 1}` })),
    });
    activity(b, 'traveller', `Boarding passes delivered to traveller (${f.boarding_passes.length})`);
  } else if (f.status === 'COMPLETED' && !f.boarding_passes.length && !told[`nopass:${b.id}`]) {
    told[`nopass:${b.id}`] = true;
    await say(b, { text: `You're checked in for ${route}! The airline hasn't released the boarding pass yet. I'll send it here as soon as it's ready.` });
  } else if (f.status === 'FAILED' && !told[`failed:${f.checkin_id}`]) {
    told[`failed:${f.checkin_id}`] = true;
    alertAgent(b, 'fail', `Flyo check-in FAILED: ${(f.checkin_message || f.sub_status).replace(/\.$/, '')}. Inspect it before retrying; a new attempt may use quota.`);
    await say(b, { text: `Automatic check-in for ${route} hit a snag with the airline. Your travel agent has been alerted and will sort it out. Nothing for you to do right now.` });
  } else if (f.status === 'IN_PROGRESS' && f.sub_status === 'MISSING_INFO') {
    alertAgent(b, 'warn', `Check-in window opened but Flyo is still missing: ${f.missing_info.map((m) => m.type).join(', ')}. Chase the traveller now.`);
    await askNext(b, { force: true });
  }
}

/** Webhook from Flyo. The auth header has already been verified by the caller. */
export async function handleFlyoWebhook(event) {
  if (!event?.event_id) return { ok: false, reason: 'missing event_id' };
  const b = findBookingByCheckin(event.checkin_id);
  if (!markEventSeen(event.event_id)) {
    if (b) activity(b, 'webhook', `Duplicate webhook ${event.event_id} ignored (event_id de-duplication)`);
    return { ok: true, duplicate: true };
  }
  if (!b) return { ok: true, unknown: true };
  activity(b, 'webhook', `Webhook ${event.event_id}: ${event.changes?.status}${event.changes?.sub_status ? ` / ${event.changes.sub_status}` : ''}`);
  // Events can be repeated or arrive out of order: only apply a snapshot that is newer than the state we
  // already hold (from any source), then reconcile with the authoritative status endpoint.
  if (event.changes && (!b.flyo.last_updated || event.occurredAt >= b.flyo.last_updated)) {
    applyStatus(b, { ...event.changes, last_updated: event.occurredAt }, 'webhook');
  } else if (event.changes) {
    activity(b, 'webhook', `Out-of-order webhook ${event.event_id} is older than the current state; not applied`);
  }
  setTimeout(() => refreshStatus(b), 250);
  return { ok: true };
}

/** Polling backstop for when webhooks can't reach us (e.g. running on a laptop behind NAT). */
export function startPolling() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const b of listBookings()) {
        const f = b.flyo;
        if (!f.checkin_id || TERMINAL.has(f.status) || (f.status === 'COMPLETED' && f.boarding_passes.length)) continue;
        await refreshStatus(b);
      }
    } finally { running = false; }
  };
  setTimeout(tick, 2000);
  return setInterval(tick, config.app.pollIntervalMs);
}

// ================================================================== push passenger data to Flyo
async function pushPassengers(b, reason) {
  const f = b.flyo;
  const updatableLooking = f.status === 'SCHEDULED' || (f.status === 'IN_PROGRESS' && f.sub_status === 'MISSING_INFO');
  if (!f.checkin_id || !updatableLooking) return;
  try {
    const res = await flyo.updatePassengers({ checkinId: f.checkin_id, passengers: b.passengers, loadFile: readStoredFile, context: b.id });
    touch(b, (x) => { x.flyo.lastPushedHash = passengerHash(x); x.flyo.error = null; });
    activity(b, 'flyo', `Sent the full passenger list to Flyo (${reason})`);
    if (res.data?.status) applyStatus(b, res.data, 'update');
  } catch (err) {
    await handleFlyoError(b, err, 'update');
  }
}

/** After any data change: re-evaluate, decide whether to push to Flyo, then continue the conversation. */
async function afterChange(b, { quiet = false } = {}) {
  const r = recompute(b);
  if (b.flyo.checkin_id && passengerHash(b) !== b.flyo.lastPushedHash) {
    const completes = r.flyoReady;
    if (completes && r.holdReasons.length && !b.override) {
      // The completing update would start automation, so it waits until the traveller is actually ready to fly.
      const key = `hold:${r.holdReasons.join('|')}`;
      if (!b.convo.told[key]) {
        touch(b, (x) => { x.convo.told[key] = true; });
        activity(b, 'hold', `Holding the completing Flyo update until readiness issues are resolved: ${r.holdReasons.join(' | ')}`);
      }
    } else {
      // Partial updates are safe: they don't complete missing_info, so they can't start automation.
      await pushPassengers(b, completes ? (b.override ? 'agent override' : 'all details complete') : 'partial details');
    }
  }
  if (!quiet || r.needs.length) await askNext(b);
}

// ================================================================== traveller conversation
async function greetTraveller(b, journeys) {
  const r = b.readiness;
  const route = `${b.flights[0].origin} → ${b.flights[b.flights.length - 1].destination}`;
  const list = r.needs.map((n, i) => `${i + 1}. ${n.label}`).join('\n');
  const ret = journeys > 1 ? ' (with your return flight)' : '';
  const text = r.needs.length
    ? `Hi ${firstName(b)}! 👋 This is the Sunrise Holidays travel assistant. Your trip ${route}${ret} is booked, PNR ${b.pnr}.\n\nTo check you in automatically and make sure you're ready to fly, I need:\n${list}\n\nLet's start with the first one.`
    : `Hi ${firstName(b)}! 👋 This is the Sunrise Holidays travel assistant. Your trip ${route}${ret} is booked, PNR ${b.pnr}. I already have everything I need, so I'll check you in automatically and send your boarding pass right here.`;
  touch(b, (x) => { x.convo.greeted = true; if (!r.needs.length) x.convo.told.allSet = true; });
  await say(b, { text });
}

async function askNext(b, { force = false } = {}) {
  const convo = convoOf(b);
  if (!convo.greeted) return;
  for (const x of groupOf(b)) recompute(x); // data may have been synced across journeys
  const target = conversationTarget(b);
  const need = target.readiness.needs[0];
  if (!need) {
    // No open questions: tell the traveller (once) about blocking problems, else confirm they're all set.
    let blocked = false;
    for (const x of groupOf(b)) {
      for (const c of x.readiness.checks.filter((c) => c.level === 'fail')) {
        blocked = true;
        const key = `fail:${x.id}:${c.id}:${c.detail}`;
        if (convo.told[key]) continue;
        convo.told[key] = true;
        alertAgent(x, 'fail', `${c.passenger != null ? `${paxName(x.passengers[c.passenger])}: ` : ''}${c.label}: ${c.detail}`);
        await say(x, { text: `Heads-up${c.passenger != null && x.passengers.length > 1 ? ` about ${x.passengers[c.passenger].first_name}'s documents` : ''}: ${c.detail}\n\nI've flagged this to your travel agent, who will call you to sort it out.` });
      }
    }
    const held = groupOf(b).some((x) => x.readiness.holdReasons.length && !x.override);
    if (!blocked && !held && !convo.told.allSet) {
      convo.told.allSet = true;
      const notes = target.readiness.checks.filter((c) => (c.level === 'warn' || c.level === 'info') && c.group !== 'timing').map((c) => `• ${c.detail}`);
      await say(b, { text: `All set! ✅ Everything checks out. I'll check you in automatically when the airline opens check-in and send your boarding pass here.${notes.length ? `\n\nGood to know:\n${notes.join('\n')}` : ''}` });
    }
    touch(primaryOf(b));
    return;
  }
  const key = `${target.id}:${need.pi}:${need.item}:${need.country || ''}`;
  if (!force && convo.asked?.key === key) return;
  convo.asked = { ...need, key, bookingId: target.id };
  convo.told.allSet = false;
  const p = target.passengers[need.pi];
  const multi = target.passengers.length > 1;
  const whose = multi ? `${p.first_name}'s` : 'your';
  const transitDetail = target.readiness.checks.find((c) => c.id.startsWith(`transit-${need.pi}-`) && c.level === 'pending')?.detail || '';
  const prompts = {
    email: 'Could you share an email address for this booking? The airline sends check-in confirmations there.',
    passport: `Please send a clear photo of ${whose} passport front page (the page with the photo and the two lines of <<< at the bottom).`,
    visa: `${need.country === 'SCHENGEN' ? 'The Schengen area' : countryName(need.country)} requires a visa for Indian passport holders. Please send a photo of ${whose} visa, or reply NO if ${multi ? `${p.first_name} doesn't` : "you don't"} have one yet.`,
    transit: `${multi ? `${p.first_name}'s` : 'Your'} route connects through ${countryName(need.country)}. ${transitDetail}\n\nPlease send a photo of the transit visa or an exempting visa (for example a US visa), or reply NO.`,
  };
  touch(primaryOf(b));
  await say(b, { text: `${force ? '⏰ Check-in is opening now. ' : ''}${prompts[need.item]}` });
}

/** Inbound traveller message (text and/or a file), from the simulator or Twilio. */
export async function handleTravellerMessage(bookingId, { text, file }) {
  const any = getBooking(bookingId);
  if (!any) throw Object.assign(new Error('Booking not found'), { status: 404 });
  const primary = primaryOf(any);
  const stored = file ? await saveFile(file) : null;
  touch(primary, (x) => x.thread.push({
    id: randomUUID(), dir: 'in', text: text || '', at: new Date().toISOString(),
    media: stored ? [{ url: `/api/files/${stored.id}`, mime: stored.mime, name: stored.name }] : [],
  }));

  const convo = primary.convo;
  const b = (convo.asked?.bookingId && getBooking(convo.asked.bookingId)) || conversationTarget(primary);
  const asked = convo.asked?.bookingId === b.id ? convo.asked : null;
  const trimmed = (text || '').trim();
  const replies = [];
  let progressed = false;

  if (/^status\b/i.test(trimmed) && !stored) {
    const lines = groupOf(primary).map((x) => `• ${x.flights[0].origin} → ${x.flights[x.flights.length - 1].destination}: ${x.readiness.summary}; check-in ${x.flyo.status.replace(/_/g, ' ').toLowerCase()}${x.flyo.sub_status ? ` (${x.flyo.sub_status.replace(/_/g, ' ').toLowerCase()})` : ''}`);
    await say(primary, { text: `Status for PNR ${primary.pnr}:\n${lines.join('\n')}` });
    return;
  }

  // Documents: a photo/PDF, or MRZ lines typed or pasted as text
  let doc = null;
  if (stored || /^[PV][A-Z<][A-Z<]{3}/m.test(trimmed.toUpperCase())) {
    try {
      doc = await extractDocument({ text: stored ? undefined : trimmed, file: file || undefined });
    } catch (e) {
      doc = { kind: 'unknown', reason: e.message };
    }
  }
  if (doc && doc.kind !== 'unknown') {
    replies.push(applyDocument(b, doc, stored?.id, asked));
    progressed = true;
  } else if (doc) {
    alertAgent(b, 'warn', `Traveller sent a file I couldn't read (${doc.reason}). Review it and enter the details manually.`);
    replies.push("Thanks! I couldn't read that one automatically, so I've passed it to your travel agent to check.");
    progressed = true;
  }

  // Email address
  const email = !doc && trimmed.match(EMAIL_RE)?.[0]?.toLowerCase();
  if (email) {
    const pi = asked?.item === 'email' ? asked.pi : 0;
    for (const x of groupOf(b)) touch(x, (y) => { if (x === b || !y.passengers[pi].email) y.passengers[pi].email = email; });
    replies.push(`Thanks, saved ${email} ✅`);
    activity(b, 'traveller', `Email received for ${paxName(b.passengers[pi])}`);
    progressed = true;
  }

  // "No" to a visa / transit-visa question
  if (!doc && !email && asked && ['visa', 'transit'].includes(asked.item) && /^(no|nope|nahi|na|don'?t have|do not have|not yet)\b/i.test(trimmed)) {
    const key = asked.item === 'visa' ? asked.country : `transit:${asked.country}`;
    for (const x of groupOf(b)) touch(x, (y) => { if (y.passengers[asked.pi]) y.passengers[asked.pi].declined = { ...y.passengers[asked.pi].declined, [key]: true }; });
    replies.push("Noted. I've told your travel agent so they can help you arrange it.");
    progressed = true;
  }

  if (!progressed) {
    const need = b.readiness.needs[0];
    replies.push(need ? `I'm still waiting for: ${need.label}. You can also reply STATUS anytime.` : 'Thanks! Nothing else is needed right now. Reply STATUS anytime.');
  }
  await say(primary, { text: replies.join('\n\n') });
  // convo.asked is left as-is: askNext only sends a new question when the top outstanding need changes.
  for (const x of groupOf(primary)) await afterChange(x, { quiet: x !== b });
}

function applyDocument(b, doc, fileId, asked) {
  const holder = { surname: doc.surname || '', given_names: doc.given_names || '' };
  let pi = bestPassengerMatch(b.passengers, holder);
  if (pi === -1) pi = asked && ['passport', 'visa', 'transit'].includes(asked.item) ? asked.pi : b.passengers.length === 1 ? 0 : -1;
  if (pi === -1) {
    alertAgent(b, 'warn', `Received a ${doc.kind} for ${holder.given_names} ${holder.surname}, who doesn't match any passenger on PNR ${b.pnr}.`);
    return `I received a ${doc.kind} for ${holder.given_names} ${holder.surname}, but that name isn't on this booking. I've asked your travel agent to check.`;
  }
  const p = b.passengers[pi];
  const group = groupOf(b);

  if (doc.kind === 'passport') {
    const passport = {
      number: doc.number, date_of_issue: doc.date_of_issue, expiry_date: doc.expiry_date, place_of_issue: doc.place_of_issue,
      nationality: doc.nationality, surname: doc.surname, given_names: doc.given_names, date_of_birth: doc.date_of_birth, sex: doc.sex,
      mrz_valid: doc.mrz_valid, mrz_checks: doc.mrz_checks, source: doc.source, fileId: fileId || null,
    };
    for (const x of group) {
      touch(x, (y) => {
        const q = y.passengers[pi];
        if (!q) return;
        q.passport = passport;
        q.nationality = doc.nationality || q.nationality || null;
        q.date_of_birth = doc.date_of_birth || q.date_of_birth || null;
      });
    }
    activity(b, 'traveller', `Passport received for ${paxName(p)} (${doc.source}; MRZ ${doc.mrz_valid === false ? 'check digits FAILED' : doc.mrz_valid ? 'verified' : 'n/a'})`);
    const missing = ['date_of_issue', 'place_of_issue'].filter((k) => !passport[k]);
    let msg = `Got ${p.first_name}'s passport ✅ No. ${doc.number}, valid until ${fmtDate(doc.expiry_date)}.`;
    if (doc.mrz_valid === false) msg += "\n\n⚠️ The photo looks unclear: the code at the bottom doesn't add up, so a number may have been misread. Could you send a sharper photo, flat and without glare?";
    if (missing.length) msg += `\n\nI couldn't read the ${missing.join(' and ').replace(/_/g, ' ')}. Please send a clearer photo, or your agent can add ${missing.length > 1 ? 'them' : 'it'}.`;
    return msg;
  }

  const visa = {
    type: 'VISA', document_number: doc.document_number, issuing_country: doc.issuing_country, expiry_date: doc.expiry_date,
    valid_from: doc.valid_from, visa_type: doc.visa_type, holder, mrz_valid: doc.mrz_valid, source: doc.source, fileId: fileId || null,
  };
  for (const x of group) {
    touch(x, (y) => {
      const q = y.passengers[pi];
      if (!q) return;
      q.documents = [...(q.documents || []).filter((d) => !(d.type === 'VISA' && d.issuing_country === visa.issuing_country)), visa];
    });
  }
  activity(b, 'traveller', `${countryName(doc.issuing_country)} visa received for ${paxName(p)}`);
  // Mention when this visa also clears a transit requirement (e.g. a US visa exempts Indians from the UK DATV).
  const visaKey = SCHENGEN.has(doc.issuing_country) ? 'SCHENGEN' : doc.issuing_country;
  const covers = b.flights.slice(0, -1)
    .map((l) => airport(l.destination)?.country)
    .filter((cc) => cc && cc !== 'IN')
    .map((cc) => [cc, TRANSIT_RULES_IN[SCHENGEN.has(cc) ? 'SCHENGEN' : cc]])
    .filter(([cc, rule]) => rule?.exemptVisas?.includes(visaKey) && cc !== doc.issuing_country);
  const transitNote = covers.length ? ` It also covers your transit through ${covers.map(([cc]) => countryName(cc).replace(/^(United|Netherlands)/, 'the $1')).join(' and ')}, so no transit visa is needed.` : '';
  return `Got ${p.first_name}'s ${countryName(doc.issuing_country)} visa ✅ ${doc.visa_type ? `(${doc.visa_type}) ` : ''}valid until ${fmtDate(doc.expiry_date)}.${transitNote}`;
}

// ================================================================== agent actions
export async function agentUpdatePassenger(bookingId, pi, patch) {
  const b = getBooking(bookingId);
  if (!b || !b.passengers[pi]) throw Object.assign(new Error('Not found'), { status: 404 });
  const clean = (v) => (typeof v === 'string' ? v.trim() || null : v ?? null);
  touch(b, (x) => {
    const p = x.passengers[pi];
    for (const k of ['first_name', 'last_name', 'email', 'phone', 'country_code']) if (k in patch) p[k] = clean(patch[k]);
    if (patch.passport) {
      const pp = Object.fromEntries(Object.entries(patch.passport).map(([k, v]) => [k, clean(v)]));
      p.passport = { ...(p.passport || {}), ...pp, source: 'entered by agent' };
      if (pp.number && pp.number !== x.passengers[pi].passport?.number) p.passport.mrz_valid = null;
      if (pp.nationality) p.nationality = pp.nationality;
    }
  });
  activity(b, 'agent', `Agent edited ${paxName(b.passengers[pi])}`);
  await afterChange(b);
  return b;
}

export async function agentOverride(bookingId, on) {
  const b = getBooking(bookingId);
  if (!b) throw Object.assign(new Error('Not found'), { status: 404 });
  touch(b, (x) => { x.override = Boolean(on); });
  activity(b, 'agent', on ? 'Agent overrode the readiness hold: sending to Flyo anyway' : 'Agent re-enabled the readiness hold');
  await afterChange(b, { quiet: true });
  return b;
}

export async function agentRetrySubscribe(bookingId) {
  const b = getBooking(bookingId);
  if (!b) throw Object.assign(new Error('Not found'), { status: 404 });
  if (b.flyo.checkin_id && !TERMINAL.has(b.flyo.status)) {
    // An active attempt exists: resubscribing would only return ALREADY_SUBSCRIBED. Refresh instead.
    await refreshStatus(b);
    return b;
  }
  touch(b, (x) => { x.delivered.passes = false; });
  await subscribe(b);
  await afterChange(b, { quiet: true });
  return b;
}

export async function agentRefresh(bookingId) {
  const b = getBooking(bookingId);
  if (!b) throw Object.assign(new Error('Not found'), { status: 404 });
  await refreshStatus(b);
  recompute(b);
  return b;
}

export function resolveAlert(bookingId, alertId) {
  const b = getBooking(bookingId);
  if (!b) throw Object.assign(new Error('Not found'), { status: 404 });
  touch(b, (x) => { const a = x.alerts.find((y) => y.id === alertId); if (a) a.resolved = true; });
  return b;
}
