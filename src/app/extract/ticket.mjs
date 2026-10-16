// E-ticket / itinerary extraction: PDF, image or pasted email text -> Flyo-shaped booking draft.
// Uses the configured vision LLM when available; otherwise a deterministic parser that handles
// the common Indian OTA / airline e-ticket layouts (and the bundled samples).
import { extractText, getDocumentProxy } from 'unpdf';
import { AIRPORTS } from '../../shared/airports.mjs';
import { normalizeWallClock } from '../../shared/time.mjs';
import { llmEnabled, llmJson } from './llm.mjs';

const AIRLINE_CODES = new Set(['6E', 'AI', 'IX', 'QP', 'SG', 'EK', 'QR', 'EY', 'SQ', 'TG', 'BA', 'LH', 'UL', 'UK', 'G8', '9W', 'FZ', 'WY', 'GF', 'KU', 'SV', 'MH', 'AK', 'CX', 'TK', 'AF', 'KL', 'LX', 'VS', 'UA', 'AA', 'DL', 'AC', 'JL', 'NH', 'QF', 'MU', 'CA', 'BG']);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*';
const STOP = new Set(['ADULT', 'CHILD', 'INFANT', 'ECONOMY', 'BUSINESS', 'SEAT', 'PASSENGER', 'TICKET', 'ETICKET', 'FLIGHT', 'PNR', 'BOOKING', 'FARE', 'MEAL', 'BAGGAGE', 'CONFIRMED', 'TYPE', 'STATUS', 'E']);

const pad = (n) => String(n).padStart(2, '0');
const year4 = (y) => (String(y).length === 2 ? 2000 + +y : +y);
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

export async function pdfToText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : text;
}

function findDateTimes(text) {
  const out = [];
  const push = (index, length, y, mo, d, h, mi) => {
    const wall = normalizeWallClock(`${year4(y)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00`);
    if (wall) out.push({ index, end: index + length, wall });
  };
  const patterns = [
    // 18 Oct 2026, 06:10 | 20Oct26 04:25 | Sat, 18 Oct 26 at 06:10
    [new RegExp(`\\b(\\d{1,2})\\s*-?\\s*${MON}\\s*-?\\s*,?\\s*(\\d{4}|\\d{2})\\b[ ,]*(?:at\\s*)?(\\d{1,2}):(\\d{2})`, 'gi'),
      (m) => [m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], m[1], m[4], m[5]]],
    // 2026-10-18 06:10 / 2026-10-18T06:10
    [/\b(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/g, (m) => [m[1], m[2], m[3], m[4], m[5]]],
    // 18/10/2026 06:10 (Indian dd/mm/yyyy)
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})/g, (m) => [m[3], m[2], m[1], m[4], m[5]]],
    // Oct 18, 2026 06:10
    [new RegExp(`\\b${MON}\\s+(\\d{1,2}),?\\s+(\\d{4})[ ,]+(?:at\\s*)?(\\d{1,2}):(\\d{2})`, 'gi'),
      (m) => [m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], m[2], m[4], m[5]]],
    // 06:10 hrs, 18 Oct 2026 (time first)
    [new RegExp(`\\b(\\d{1,2}):(\\d{2})\\s*(?:hrs)?[ ,]+(?:[A-Za-z]{3},?\\s*)?(\\d{1,2})\\s*${MON}\\s*,?\\s*(\\d{4}|\\d{2})\\b`, 'gi'),
      (m) => [m[5], MONTHS[m[4].slice(0, 3).toLowerCase()], m[3], m[1], m[2]]],
  ];
  for (const [re, pick] of patterns) {
    for (const m of text.matchAll(re)) push(m.index, m[0].length, ...pick(m));
  }
  out.sort((a, b) => a.index - b.index || b.end - a.end);
  const kept = [];
  for (const x of out) if (!kept.length || x.index >= kept[kept.length - 1].end) kept.push(x); // drop overlaps
  return kept;
}

function findPassengers(text) {
  const names = [];
  const seen = new Set();
  const addName = (first, last) => {
    const f = titleCase(first.trim().replace(/\s+/g, ' '));
    const l = titleCase(last.trim());
    const key = `${f} ${l}`.toUpperCase();
    if (!f || !l || seen.has(key)) return;
    seen.add(key);
    names.push({ first_name: f, last_name: l });
  };
  // SHARMA/PRIYA MS
  for (const m of text.matchAll(/\b([A-Z][A-Z'-]{1,})\/([A-Z][A-Z' ]*?[A-Z])(?=\s+(?:MR|MRS|MS|MISS|MSTR|DR)\b|\s{2,}|\s*$|\s*\n|\s+[A-Z][a-z])/gm)) {
    if (STOP.has(m[1])) continue;
    const given = m[2].split(/\s+/).filter((t) => !STOP.has(t) && !['MR', 'MRS', 'MS', 'MISS', 'MSTR', 'DR'].includes(t)).join(' ');
    if (given) addName(given, m[1]);
  }
  // Mr Arjun Reddy
  for (const m of text.matchAll(/\b(?:Mr|Mrs|Ms|Miss|Mstr|Master|Dr)\.?\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/g)) {
    const tokens = [];
    for (const t of m[1].split(/\s+/)) {
      if (STOP.has(t.toUpperCase())) break;
      tokens.push(t);
    }
    if (tokens.length >= 2) addName(tokens.slice(0, -1).join(' '), tokens[tokens.length - 1]);
  }
  return names;
}

function heuristicParse(text) {
  const warnings = [];
  const t = text.replace(/\u2192|\u2013|\u2014/g, ' - ');
  const pnr = (t.match(/\b(?:PNR|Booking\s*Ref(?:erence)?|Record\s*Locator|Airline\s*Ref(?:erence)?)\b[^A-Z0-9]{0,30}?([A-Z0-9]{6})\b/i) || [])[1]?.toUpperCase() || null;
  if (!pnr) warnings.push('No PNR found');

  const flightMatches = [...t.matchAll(/\b([A-Z0-9]{2})\s?-?\s?(\d{1,4})\b/g)]
    .filter((m) => AIRLINE_CODES.has(m[1]) && !/^\d{2}$/.test(m[1]));
  const flights = [];
  flightMatches.forEach((m, i) => {
    const end = i + 1 < flightMatches.length ? flightMatches[i + 1].index : Math.min(t.length, m.index + 400);
    const win = t.slice(m.index + m[0].length, end);
    const airports = [...win.matchAll(/\b([A-Z]{3})\b/g)].map((x) => x[1]).filter((c) => AIRPORTS[c]);
    const uniq = airports.filter((c, j) => airports.indexOf(c) === j);
    const times = findDateTimes(win);
    if (uniq.length < 2 || !times.length) return;
    const flight_number = String(+m[2]);
    if (flights.some((f) => f.airline === m[1] && f.flight_number === flight_number)) return;
    flights.push({
      airline: m[1], flight_number, origin: uniq[0], destination: uniq[1],
      departure_datetime: times[0].wall, arrival_datetime: times[1]?.wall || null,
    });
  });
  if (!flights.length) warnings.push('No flight segments found');

  const passengers = findPassengers(t);
  if (!passengers.length) warnings.push('No passenger names found');

  // Only take contact details explicitly labelled as the passenger's (agency/airline contacts are common on tickets)
  const email = (t.match(/Passenger\s*(?:e-?mail|email\s*id)\s*[:\-]?\s*([^\s@]+@[^\s@]+\.[A-Za-z]{2,})/i) || [])[1];
  const phone = (t.match(/Passenger\s*(?:mobile|phone|contact)\s*[:\-]?\s*(\+\d{1,3})?[\s-]*(\d[\d\s-]{7,14}\d)/i) || []);
  if (passengers[0]) {
    if (email) passengers[0].email = email;
    if (phone[2]) { passengers[0].country_code = phone[1] || '+91'; passengers[0].phone = phone[2].replace(/\D/g, ''); }
  }
  return { pnr, passengers, flights, warnings };
}

const TICKET_SYSTEM = `You extract airline booking data from e-tickets and itinerary emails for an Indian travel agency.
Return JSON: {"pnr": string|null, "passengers": [{"first_name": string, "last_name": string, "email": string|null, "phone": string|null, "country_code": string|null}], "flights": [{"airline": string, "flight_number": string, "origin": string, "destination": string, "departure_datetime": string, "arrival_datetime": string|null}], "warnings": string[]}
Rules:
- airline is the 2-character IATA code of the operating/marketing carrier shown with the flight number (e.g. 6E, AI, EK). flight_number is digits only without leading zeros.
- origin/destination are 3-letter IATA airport codes.
- departure_datetime is the ORIGIN airport local time and arrival_datetime the DESTINATION airport local time, formatted YYYY-MM-DDTHH:mm:ss with no timezone suffix. Never convert to UTC.
- Include every flight segment on the ticket in chronological order, including return flights.
- For "SURNAME/GIVEN MR" names, last_name is SURNAME. Drop titles (Mr, Mrs, Ms, Mstr, Dr).
- Only fill email/phone when they clearly belong to the passenger; ignore agency, airline and helpline contacts.
- pnr is the airline booking reference (6 alphanumeric characters), not the e-ticket number.
- Put anything ambiguous in warnings. Do not invent data.`;

/**
 * @param {{ text?: string, file?: { data: Buffer, mime: string, name?: string } }} input
 * @returns {Promise<{ pnr: string|null, passengers: object[], flights: object[], warnings: string[], source: string }>}
 */
export async function extractTicket({ text, file }) {
  let plain = text || '';
  if (file?.mime === 'application/pdf') {
    try { plain = await pdfToText(file.data); } catch (e) { if (!llmEnabled()) throw new Error(`Could not read PDF: ${e.message}`); }
  } else if (file && !file.mime.startsWith('image/') && !plain) {
    plain = file.data.toString('utf8');
  }

  if (llmEnabled()) {
    try {
      const out = await llmJson({
        system: TICKET_SYSTEM,
        prompt: plain && !file?.mime?.startsWith('image/') ? `Ticket text:\n"""\n${plain.slice(0, 20000)}\n"""` : 'Extract the booking from the attached ticket.',
        files: file && (file.mime === 'application/pdf' || file.mime.startsWith('image/')) ? [file] : [],
      });
      return normaliseDraft(out, 'llm');
    } catch (e) {
      if (!plain) throw e;
      const parsed = heuristicParse(plain);
      parsed.warnings.unshift(`LLM extraction failed (${e.message}); used the built-in parser`);
      return normaliseDraft(parsed, 'parser');
    }
  }
  if (!plain) throw new Error('Image tickets need a vision LLM (set LLM_PROVIDER and LLM_API_KEY), or paste the ticket text instead.');
  return normaliseDraft(heuristicParse(plain), 'parser');
}

function normaliseDraft(d, source) {
  const flights = (d.flights || []).map((f) => ({
    airline: String(f.airline || '').toUpperCase().trim(),
    flight_number: String(f.flight_number || '').replace(/\D/g, '').replace(/^0+(?=\d)/, ''),
    origin: String(f.origin || '').toUpperCase().trim(),
    destination: String(f.destination || '').toUpperCase().trim(),
    departure_datetime: normalizeWallClock(f.departure_datetime),
    arrival_datetime: f.arrival_datetime ? normalizeWallClock(f.arrival_datetime) : null,
  }));
  const passengers = (d.passengers || []).map((p) => ({
    first_name: String(p.first_name || '').trim(),
    last_name: String(p.last_name || '').trim(),
    email: p.email || null,
    country_code: p.country_code || (p.phone ? '+91' : null),
    phone: p.phone ? String(p.phone).replace(/\D/g, '') : null,
  })).filter((p) => p.first_name || p.last_name);
  return { pnr: d.pnr ? String(d.pnr).toUpperCase().trim() : null, passengers, flights, warnings: d.warnings || [], source };
}

/** Split legs into one-way journeys (Flyo only supports one-way): a new journey starts on a break in
 *  connectivity, a revisited airport, or a stopover longer than 24h. */
export function splitJourneys(legs, toUtc) {
  const withUtc = legs.map((l) => ({ ...l, _dep: toUtc(l.origin, l.departure_datetime), _arr: l.arrival_datetime ? toUtc(l.destination, l.arrival_datetime) : null }));
  withUtc.sort((a, b) => (a._dep || 0) - (b._dep || 0));
  const journeys = [];
  let current = [];
  let visited = new Set();
  for (const leg of withUtc) {
    const prev = current[current.length - 1];
    const breaks = prev && (leg.origin !== prev.destination || visited.has(leg.destination) || (prev._arr && leg._dep && leg._dep - prev._arr > 24 * 36e5));
    if (breaks) { journeys.push(current); current = []; visited = new Set(); }
    if (!current.length) visited.add(leg.origin);
    visited.add(leg.destination);
    current.push(leg);
  }
  if (current.length) journeys.push(current);
  return journeys.map((j) => j.map(({ _dep, _arr, ...rest }) => rest));
}
