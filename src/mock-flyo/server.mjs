// Contract-faithful mock of the Flyo partner Web Check-in API.
// Implements the documented behaviour of:
//   POST /extPartner/api/webcheckin/subscribe   (JSON or multipart)
//   POST /extPartner/api/webcheckin/update      (JSON or multipart)
//   GET  /extPartner/api/webcheckin/status
//   GET  /extPartner/api/webcheckin/requests
// plus the legacy JSON routes under /extPartner/webcheckin/* and webhook delivery.
// Anything not specified by the public docs (internal sub_status names, reason codes other than
// DEPARTURE_TOO_CLOSE / AIRLINE_MISMATCH, check-in timing) is a reasonable guess and marked as such.
import http from 'node:http';
import { randomUUID, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../shared/env.mjs';
import { createRouter, sendJson, sendText, readJson, readForm, HttpError } from '../shared/http.mjs';
import { validateJourney, isInternational, MIN_HOURS_BEFORE_DEPARTURE } from '../shared/journey.mjs';
import { AIRLINES } from './airlines.mjs';
import { renderBoardingPass } from './boardingPass.mjs';

const BASE = `http://${config.mock.host}:${config.mock.port}`;
const STATE_FILE = path.join(config.app.dataDir, 'mock-flyo.json');
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const PUBLIC_STATUSES = new Set(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PNR_RE = /^[A-Z0-9]{6}$/;

// ---------------------------------------------------------------- state
let db = { nextBookingId: 48201, quota: { included_units: config.mock.quotaUnits, consumed_units: 0 }, bookings: [] };
if (existsSync(STATE_FILE)) {
  try { db = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* start fresh */ }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdirSync(config.app.dataDir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(db, null, 2));
  }, 100);
}

const findByCheckin = (id) => db.bookings.find((b) => b.attempts.some((a) => a.checkin_id === id));
const findByBookingId = (id) => db.bookings.find((b) => String(b.booking_id) === String(id));
const currentAttempt = (b) => b.attempts[b.attempts.length - 1] || null;
const now = () => new Date();

// ---------------------------------------------------------------- auth + rate limit
const hits = new Map();
function authenticate(req) {
  const key = req.headers['x-api-key'];
  if (!key || key !== config.mock.apiKey) {
    throw new HttpError(401, { success: false, error: 'UNAUTHORIZED', message: 'Missing, invalid, disabled, or revoked API key.' });
  }
  const windowStart = Date.now() - 60_000;
  const list = (hits.get(key) || []).filter((t) => t > windowStart);
  list.push(Date.now());
  hits.set(key, list);
  if (list.length > 120) {
    const retryAfter = Math.ceil((list[0] + 60_000 - Date.now()) / 1000);
    throw new HttpError(429, { success: false, error: 'RATE_LIMITED', message: 'Rate limit exceeded.', retryAfter });
  }
}

// ---------------------------------------------------------------- body parsing (JSON or multipart)
async function readPayload(req, { allowMultipart }) {
  const type = req.headers['content-type'] || '';
  if (type.startsWith('multipart/form-data')) {
    if (!allowMultipart) throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'Multipart uploads are only supported on the canonical /extPartner/api/webcheckin/* routes.' });
    let form;
    try { form = await readForm(req); } catch {
      throw new HttpError(500, { success: false, error: 'INTERNAL_ERROR', message: 'Multipart parser failure.' });
    }
    const body = {};
    const files = new Map();
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') body[name] = value;
      else files.set(name, value);
    }
    for (const k of ['flights', 'passengers', 'callbackData', 'payload']) {
      if (typeof body[k] === 'string') {
        try { body[k] = JSON.parse(body[k]); } catch {
          throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: `${k} must be a JSON-stringified value in multipart requests` });
        }
      }
    }
    if (files.size > 30) throw new HttpError(500, { success: false, error: 'INTERNAL_ERROR', message: 'Upload limit exceeded (30 files).' });
    for (const f of files.values()) {
      if (f.size > 10 * 1024 * 1024) throw new HttpError(500, { success: false, error: 'INTERNAL_ERROR', message: 'Upload limit exceeded (10 MiB per file).' });
    }
    return { body, files };
  }
  return { body: await readJson(req), files: new Map() };
}

// ---------------------------------------------------------------- validation helpers
function validatePassengers(passengers) {
  if (!Array.isArray(passengers) || passengers.length === 0) {
    throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'passengers must be a non-empty array' });
  }
  passengers.forEach((p, i) => {
    if (!p?.first_name?.trim() || !p?.last_name?.trim()) {
      throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: `passengers[${i}].first_name and last_name are required` });
    }
    for (const [j, d] of (p.documents || []).entries()) {
      if (!['VISA', 'IQAMA', 'PR_CARD', 'GREEN_CARD'].includes(d?.type)) {
        throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: `passengers[${i}].documents[${j}].type must be VISA, IQAMA, PR_CARD or GREEN_CARD` });
      }
    }
  });
}

function validateCallback(cb) {
  if (cb == null) return null;
  if (!cb.callbackUrl || !cb.auth_header) {
    throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'callbackData.callbackUrl and callbackData.auth_header are required when callbackData is supplied' });
  }
  try { new URL(cb.callbackUrl); } catch {
    throw new HttpError(422, { success: false, error: 'VALIDATION_ERROR', message: 'callbackUrl is not a valid URL' });
  }
  const h = String(cb.auth_header);
  const colonCount = (h.match(/:/g) || []).length;
  const [name, ...rest] = h.split(':');
  const value = rest.join(':').trim();
  if (colonCount !== 1 || /[\r\n]/.test(h) || !value || !['x-api-key', 'authorization'].includes(name.trim().toLowerCase())) {
    throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: "auth_header must be 'X-API-Key: value' or 'Authorization: Bearer value' with exactly one colon" });
  }
  return { clientId: cb.clientId || 'demo-enterprise', clientName: cb.clientName || 'Demo Enterprise', callbackUrl: cb.callbackUrl, auth_header: h };
}

/** Bind multipart file parts to passengers[].passport.file_field / documents[].file_field. */
function bindFiles(booking, passengers, files) {
  const bound = new Set();
  const store = (field, owner) => {
    const file = files.get(field);
    if (!file) throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: `file_field "${field}" does not match any uploaded file part` });
    bound.add(field);
    if (!(file.type === 'application/pdf' || file.type.startsWith('image/'))) return; // unsupported MIME types are ignored
    const url = `${BASE}/mock-files/doc/${randomUUID()}`;
    booking.uploads.push({ url, field, owner, mime: file.type, size: file.size, received_at: now().toISOString() });
    // Per the docs, these endpoints do NOT return storage URLs; we keep them internal.
  };
  passengers.forEach((p, i) => {
    if (p.passport?.file_field) store(p.passport.file_field, `passengers[${i}].passport`);
    (p.documents || []).forEach((d, j) => d.file_field && store(d.file_field, `passengers[${i}].documents[${j}]`));
  });
}

function passportComplete(p) {
  const pp = p.passport || {};
  return Boolean(pp.number && pp.date_of_issue && pp.expiry_date && pp.place_of_issue && (pp.nationality || p.nationality));
}

function computeMissingInfo(booking) {
  const missing = [];
  if (!booking.pnr || !PNR_RE.test(booking.pnr)) missing.push({ type: 'MISSING_PNR' });
  if (!booking.passengers.some((p) => p.email && EMAIL_RE.test(p.email))) missing.push({ type: 'MISSING_EMAIL' });
  if (isInternational(booking.flights) && !booking.passengers.every(passportComplete)) missing.push({ type: 'MISSING_PASSPORT' });
  return missing;
}

// ---------------------------------------------------------------- attempt lifecycle
function publicView(b, a) {
  // Internal FAILED/MISSING_INFO is exposed as IN_PROGRESS/MISSING_INFO; MANUAL_INTERVENTION_REQUIRED as SCHEDULED.
  let status = a.internal_status;
  if (a.internal_status === 'FAILED' && a.internal_sub_status === 'MISSING_INFO') status = 'IN_PROGRESS';
  if (a.internal_status === 'MANUAL_INTERVENTION_REQUIRED') status = 'SCHEDULED';
  return {
    checkin_id: a.checkin_id,
    booking_id: b.booking_id,
    status,
    sub_status: a.internal_sub_status || '',
    checkin_message: a.checkin_message || '',
    missing_info: a.missing_info,
    boarding_passes: a.boarding_passes,
    last_updated: a.last_updated,
  };
}

function isUpdatable(a) {
  if (!a) return true;
  return (a.internal_status === 'SCHEDULED') || (a.internal_status === 'FAILED' && a.internal_sub_status === 'MISSING_INFO');
}

function windowOpensAt(b) {
  const airline = AIRLINES[b.flights[0].airline];
  if (!airline || airline.windowHours == null) return null;
  return new Date(new Date(b.flights[0].departure_utc).getTime() - airline.windowHours * 36e5);
}

/** (Re)plan an attempt after create / resume. */
function plan(b, a) {
  a.missing_info = computeMissingInfo(b);
  const airline = AIRLINES[b.flights[0].airline];
  if (airline && airline.windowHours == null) {
    set(b, a, 'MANUAL_INTERVENTION_REQUIRED', 'MANUAL_FULFILLMENT', 'No automated check-in timing for this airline; the Flyo team will fulfil it manually.');
    a.next = null;
    return;
  }
  const opens = windowOpensAt(b) || now();
  a.scheduled_time = new Date(opens.getTime() + 15 * 60000).toISOString(); // 15 min after window opens
  if (a.missing_info.length) {
    set(b, a, 'SCHEDULED', 'MISSING_INFO', `Waiting for: ${a.missing_info.map((m) => m.type).join(', ')}`);
    a.next = null;
    return;
  }
  const windowOpenNow = config.mock.fastForward || now() >= opens;
  set(b, a, 'SCHEDULED', windowOpenNow ? 'QUEUED' : 'AWAITING_CHECKIN_WINDOW',
    windowOpenNow ? 'Check-in window open; automation queued.' : `Check-in automation scheduled for ${a.scheduled_time}.`);
  a.next = { at: windowOpenNow ? Date.now() + 2500 : new Date(a.scheduled_time).getTime(), step: 'START' };
}

function set(b, a, status, sub, message, { notify = true } = {}) {
  const changed = a.internal_status !== status || a.internal_sub_status !== sub || a.checkin_message !== message;
  a.internal_status = status;
  a.internal_sub_status = sub;
  a.checkin_message = message;
  a.last_updated = now().toISOString();
  if (changed && notify) queueWebhook(b, a);
  save();
}

function advance(b, a) {
  const step = a.next?.step;
  a.next = null;
  if (step === 'START') {
    // At window open, missing info flips the attempt into FAILED/MISSING_INFO (public IN_PROGRESS/MISSING_INFO).
    a.missing_info = computeMissingInfo(b);
    if (a.missing_info.length) {
      set(b, a, 'FAILED', 'MISSING_INFO', 'Check-in window opened but required information is missing.');
      return;
    }
    set(b, a, 'IN_PROGRESS', 'CHECKIN_RUNNING', `Checking in on the ${b.flights[0].airline} website.`);
    a.next = { at: Date.now() + 4000, step: 'FINISH' };
  } else if (step === 'FINISH') {
    if (b.pnr === 'FAILED') {
      set(b, a, 'FAILED', 'AIRLINE_REJECTED', 'Airline website rejected the check-in (mock failure scenario for PNR FAILED).');
      return;
    }
    const delayedPass = isInternational(b.flights);
    if (delayedPass) {
      set(b, a, 'COMPLETED', 'BOARDING_PASS_NOT_AVAILABLE', 'Checked in. The airline has not issued the boarding pass yet.');
      a.next = { at: Date.now() + 5000, step: 'PASS' };
    } else {
      issuePasses(b, a);
      set(b, a, 'COMPLETED', 'BOARDING_PASS_AVAILABLE', 'Checked in. Boarding passes available.', { notify: false });
      queueWebhook(b, a, { final: true });
    }
  } else if (step === 'PASS') {
    issuePasses(b, a);
    set(b, a, 'COMPLETED', 'BOARDING_PASS_AVAILABLE', 'Checked in. Boarding passes available.', { notify: false });
    queueWebhook(b, a, { final: true });
  }
  save();
}

function issuePasses(b, a) {
  const urls = [];
  let seq = randomInt(20, 140);
  b.flights.forEach((leg, li) => b.passengers.forEach((p, pi) => {
    const row = { front: 4, middle: 18, rear: 29 }[p.seat_preference?.row_preference] || 12 + li;
    const col = { window: 'A', middle: 'B', aisle: 'C' }[p.seat_preference?.column_preference] || 'ABCDEF'[pi % 6];
    const token = randomUUID().slice(0, 8);
    b.passes[token] = { pi, li, seat: `${row}${col}`, seq: seq++ };
    urls.push(`${BASE}/mock-files/boarding-pass/${a.checkin_id}/${token}.svg`);
  }));
  a.boarding_passes = urls; // flat array: Flyo does not map URLs to passenger/segment
}

setInterval(() => {
  const t = Date.now();
  for (const b of db.bookings) {
    const a = currentAttempt(b);
    if (a?.next && a.next.at <= t) advance(b, a);
  }
}, 500).unref();

// ---------------------------------------------------------------- webhooks
const outbox = [];
function queueWebhook(b, a, { final = false } = {}) {
  if (!b.callbackData) return;
  const v = publicView(b, a);
  const event = {
    event_id: `evt_${randomUUID()}`,
    event_type: 'webcheckin.status_changed',
    occurredAt: now().toISOString(),
    checkin_id: a.checkin_id,
    booking_id: b.booking_id,
    changes: { status: v.status, sub_status: v.sub_status, checkin_message: v.checkin_message, missing_info: v.missing_info, boarding_passes: v.boarding_passes },
  };
  outbox.push({ cb: b.callbackData, event, tries: 0, at: Date.now() + 300 });
  if (final && config.mock.duplicateFinalWebhook) outbox.push({ cb: b.callbackData, event, tries: 0, at: Date.now() + 1500 });
}

async function deliver(item) {
  const idx = item.cb.auth_header.indexOf(':');
  const headerName = item.cb.auth_header.slice(0, idx).trim();
  const headerValue = item.cb.auth_header.slice(idx + 1).trim();
  try {
    const res = await fetch(item.cb.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [headerName]: headerValue },
      body: JSON.stringify(item.event),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'done';
    return res.status >= 500 || res.status === 429 ? 'retry' : 'drop';
  } catch {
    return 'retry';
  }
}

setInterval(async () => {
  const t = Date.now();
  const due = outbox.filter((i) => i.at <= t && !i.inFlight);
  for (const item of due) {
    item.inFlight = true;
    const result = await deliver(item);
    item.inFlight = false;
    item.tries++;
    if (result === 'retry' && item.tries < 6) {
      item.at = Date.now() + 1000 * 2 ** item.tries;
    } else {
      outbox.splice(outbox.indexOf(item), 1);
      if (result !== 'done') console.warn(`[mock-flyo] webhook ${item.event.event_id} ${result === 'drop' ? 'dropped (4xx)' : 'gave up'}`);
    }
  }
}, 300).unref();

// ---------------------------------------------------------------- handlers
async function subscribe(req, res, { legacy }) {
  authenticate(req);
  const { body, files } = await readPayload(req, { allowMultipart: !legacy });
  validatePassengers(body.passengers);
  const callbackData = validateCallback(body.callbackData);
  const journey = validateJourney(body.flights);
  if (!journey.ok) {
    const { status, ok, ...err } = journey;
    throw new HttpError(status, { success: false, ...err });
  }
  if (db.quota.consumed_units >= db.quota.included_units) {
    throw new HttpError(402, { success: false, error: 'QUOTA_EXHAUSTED', message: 'Web check-in quota exhausted.' });
  }
  const pnr = body.pnr ? String(body.pnr).trim().toUpperCase() : null;
  const firstDeparture = journey.legs[0].departure_datetime;
  const existing = pnr && db.bookings.find((b) => b.pnr === pnr && b.flights[0].departure_datetime === firstDeparture);

  if (existing) {
    if (existing.flights[0].airline !== journey.legs[0].airline) {
      throw new HttpError(422, { success: false, error: 'REJECTED', reason_code: 'AIRLINE_MISMATCH', message: 'Existing booking for this PNR and departure uses a different airline.' });
    }
    const a = currentAttempt(existing);
    // Subscribe upserts passenger and flight data before detecting the duplicate.
    existing.passengers = body.passengers;
    existing.flights = journey.legs;
    bindFiles(existing, body.passengers, files);
    if (a && !TERMINAL.has(a.internal_status)) {
      a.missing_info = computeMissingInfo(existing);
      save();
      return sendJson(res, 200, {
        success: true, message: 'ALREADY_SUBSCRIBED', booking_id: existing.booking_id, checkin_id: a.checkin_id,
        status: publicView(existing, a).status, sub_status: a.internal_sub_status, missing_info: a.missing_info,
        status_message: 'An active check-in attempt already exists for this PNR and departure; no additional unit consumed.',
      });
    }
    if (a?.internal_status === 'COMPLETED') {
      throw new HttpError(422, { success: false, error: 'REJECTED', reason_code: 'ALREADY_COMPLETED', message: 'A completed check-in attempt already exists for this booking.' });
    }
    // failed / cancelled -> new charged attempt
    return createAttempt(res, existing, callbackData || existing.callbackData);
  }

  const booking = {
    booking_id: db.nextBookingId++, pnr, flights: journey.legs, passengers: body.passengers,
    callbackData, attempts: [], uploads: [], passes: {}, created_at: now().toISOString(),
  };
  bindFiles(booking, body.passengers, files);
  db.bookings.push(booking);
  return createAttempt(res, booking, callbackData);
}

function createAttempt(res, booking, callbackData) {
  booking.callbackData = callbackData;
  db.quota.consumed_units++;
  const a = {
    checkin_id: `CHK-${randomInt(100000, 999999)}`, internal_status: 'SCHEDULED', internal_sub_status: '',
    checkin_message: '', missing_info: [], boarding_passes: [], scheduled_time: null,
    created_at: now().toISOString(), last_updated: now().toISOString(), next: null,
  };
  booking.attempts.push(a);
  plan(booking, a);
  save();
  return sendJson(res, 200, {
    success: true, message: 'SCHEDULED', booking_id: booking.booking_id, checkin_id: a.checkin_id,
    status: publicView(booking, a).status, sub_status: a.internal_sub_status, missing_info: a.missing_info,
    status_message: a.checkin_message, quota: { ...db.quota },
  });
}

async function update(req, res, { legacy }) {
  authenticate(req);
  const { body, files } = await readPayload(req, { allowMultipart: !legacy });
  const checkinId = body.checkin_id || body.webcheckin_id;
  if (files.size && !checkinId) {
    throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'Uploads require checkin_id (or webcheckin_id); booking_id alone is insufficient.' });
  }
  if (!checkinId && !body.booking_id) throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'checkin_id or booking_id is required' });
  if (body.operation && body.operation !== 'update') throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'Only operation "update" is supported' });
  const type = body.type || (Array.isArray(body.passengers) ? 'passengers' : null);
  if (!['passengers', 'pnr'].includes(type)) throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'type must be passengers or pnr' });

  const booking = checkinId ? findByCheckin(checkinId) : findByBookingId(body.booking_id);
  if (!booking) throw new HttpError(404, { success: false, error: 'NOT_FOUND', message: 'The check-in or booking does not exist.' });
  const a = currentAttempt(booking);
  if (!isUpdatable(a)) throw new HttpError(409, { success: false, error: 'NOT_UPDATABLE', message: 'The check-in can no longer be modified in its current state.' });

  if (type === 'pnr') {
    const newPnr = String(body.payload?.pnr || '').trim().toUpperCase();
    if (!newPnr) throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'payload.pnr is required for type pnr (top-level pnr is not read)' });
    if (db.bookings.some((b) => b !== booking && b.pnr === newPnr)) {
      throw new HttpError(409, { success: false, error: 'DUPLICATE_PNR', message: 'Another booking for this partner already uses that PNR.' });
    }
    booking.pnr = newPnr;
    if (a) { a.missing_info = computeMissingInfo(booking); a.last_updated = now().toISOString(); } // refresh only, no resume
    save();
    return sendJson(res, 200, { success: true, type, operation: 'update', data: a ? publicView(booking, a) : { booking_id: booking.booking_id } });
  }

  validatePassengers(body.passengers);
  bindFiles(booking, body.passengers, files);
  booking.passengers = body.passengers; // full replacement, never merged
  if (!a) { save(); return sendJson(res, 200, { success: true, type, operation: 'update', data: { booking_id: booking.booking_id } }); }

  const wasMissing = a.internal_sub_status === 'MISSING_INFO';
  a.missing_info = computeMissingInfo(booking);
  a.last_updated = now().toISOString();
  if (wasMissing && a.missing_info.length === 0) {
    const hoursAway = (new Date(booking.flights[0].departure_utc) - now()) / 36e5;
    if (hoursAway < MIN_HOURS_BEFORE_DEPARTURE) {
      save(); // passenger changes are already committed
      throw new HttpError(422, { success: false, error: 'REJECTED', reason_code: 'DEPARTURE_TOO_CLOSE', message: 'Passenger changes were saved, but departure is under 6 hours away so automation cannot resume.' });
    }
    plan(booking, a); // resume
  } else if (wasMissing) {
    set(booking, a, a.internal_status, 'MISSING_INFO', `Waiting for: ${a.missing_info.map((m) => m.type).join(', ')}`);
  }
  save();
  return sendJson(res, 200, { success: true, type, operation: 'update', data: publicView(booking, a) });
}

function status(req, res, url) {
  authenticate(req);
  const id = url.searchParams.get('checkin_id') || url.searchParams.get('checkinId');
  if (!id) throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'checkin_id is missing.' });
  const b = findByCheckin(id);
  if (!b) throw new HttpError(404, { success: false, error: 'NOT_FOUND', message: 'The check-in does not exist.' });
  const a = b.attempts.find((x) => x.checkin_id === id);
  sendJson(res, 200, { success: true, ...publicView(b, a) });
}

function requests(req, res, url) {
  authenticate(req);
  const rawPage = parseInt(url.searchParams.get('page'), 10);
  const rawLimit = parseInt(url.searchParams.get('limit'), 10);
  const page = Number.isFinite(rawPage) && rawPage >= 0 ? rawPage : 0;
  const limit = !Number.isFinite(rawLimit) || rawLimit === 0 ? 25 : Math.min(100, Math.max(1, rawLimit));
  const filter = url.searchParams.get('status');
  let rows = db.bookings.flatMap((b) => b.attempts.map((a) => ({ b, a, v: publicView(b, a) })));
  if (filter && PUBLIC_STATUSES.has(filter.toUpperCase())) rows = rows.filter((r) => r.v.status === filter.toUpperCase());
  rows.sort((x, y) => new Date(y.a.created_at) - new Date(x.a.created_at));
  const total = rows.length;
  const data = rows.slice(page * limit, page * limit + limit).map(({ b, a, v }) => ({
    ...v,
    pnr: b.pnr, origin: b.flights[0].origin, destination: b.flights[b.flights.length - 1].destination,
    departure_datetime: `${b.flights[0].departure_datetime}Z`, // legacy Z suffix; still origin-local wall clock
    airline: b.flights[0].airline, flight_number: b.flights[0].flight_number,
    scheduled_time: a.scheduled_time, created_at: a.created_at,
  }));
  sendJson(res, 200, { success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

function boardingPass(res, params) {
  const b = findByCheckin(params.checkinId);
  const token = params.file.replace(/\.svg$/, '');
  const pass = b?.passes[token];
  if (!pass) return sendText(res, 404, 'Not found');
  const svg = renderBoardingPass({ passenger: b.passengers[pass.pi] || b.passengers[0], leg: b.flights[pass.li], pnr: b.pnr, seat: pass.seat, seq: pass.seq });
  sendText(res, 200, svg, 'image/svg+xml; charset=utf-8', { 'Access-Control-Allow-Origin': '*' });
}

// ---------------------------------------------------------------- routing
const router = createRouter();
for (const legacy of [false, true]) {
  const prefix = legacy ? '/extPartner/webcheckin' : '/extPartner/api/webcheckin';
  router.add('POST', `${prefix}/subscribe`, (req, res) => subscribe(req, res, { legacy }));
  router.add('POST', `${prefix}/update`, (req, res) => update(req, res, { legacy }));
  router.add('GET', `${prefix}/status`, (req, res, _p, url) => status(req, res, url));
}
router.add('GET', '/extPartner/api/webcheckin/requests', (req, res, _p, url) => requests(req, res, url));
router.add('GET', '/mock-files/boarding-pass/:checkinId/:file', (_req, res, p) => boardingPass(res, p));
router.add('GET', '/__mock/state', (_req, res) => sendJson(res, 200, { quota: db.quota, bookings: db.bookings.length, outbox: outbox.length, fastForward: config.mock.fastForward }));
router.add('GET', '/', (_req, res) => sendJson(res, 200, { service: 'mock-flyo', note: 'Contract-faithful mock of the Flyo partner Web Check-in API', docs: 'https://www.flyo.ai/en/api-docs' }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const m = router.match(req.method, url.pathname);
  const started = Date.now();
  try {
    if (!m) throw new HttpError(404, { success: false, error: 'NOT_FOUND', message: 'Route not found' });
    await m.handler(req, res, m.params, url);
  } catch (err) {
    if (err instanceof HttpError) sendJson(res, err.status, err.body, err.status === 429 ? { 'Retry-After': String(err.body.retryAfter) } : {});
    else { console.error(err); sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR', message: 'Unexpected error' }); }
  } finally {
    if (url.pathname.startsWith('/extPartner')) console.log(`[mock-flyo] ${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
  }
});

server.listen(config.mock.port, config.mock.host, () => {
  console.log(`[mock-flyo] listening on ${BASE} (fast-forward=${config.mock.fastForward}, quota=${db.quota.consumed_units}/${db.quota.included_units})`);
});
