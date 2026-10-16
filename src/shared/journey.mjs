// Flyo journey rules, shared by the mock (to enforce) and the app (to pre-flight before spending quota).
// Documented rules: one-way only; legs sorted by departure instant; must connect end-to-end;
// may not revisit an airport; one airline; arrival after departure; first departure >= 6h away.
import { airport } from './airports.mjs';
import { normalizeWallClock, wallClockToUtc } from './time.mjs';

export const MIN_HOURS_BEFORE_DEPARTURE = 6;

const AIRLINE_RE = /^[A-Z0-9]{2}$/;
const IATA_RE = /^[A-Z]{3}$/;

/**
 * @returns {{ ok: true, legs: object[] } | { ok: false, status: number, error: string, reason_code?: string, message: string }}
 */
export function validateJourney(flights, now = new Date()) {
  if (!Array.isArray(flights) || flights.length === 0) {
    return fail(400, 'VALIDATION_ERROR', null, 'flights must be a non-empty array');
  }
  const legs = [];
  for (const [i, f] of flights.entries()) {
    const airline = String(f?.airline || '').toUpperCase();
    const origin = String(f?.origin || '').toUpperCase();
    const destination = String(f?.destination || '').toUpperCase();
    const flight_number = String(f?.flight_number || '').trim();
    if (!AIRLINE_RE.test(airline)) return fail(400, 'VALIDATION_ERROR', null, `flights[${i}].airline must be a 2-character IATA code`);
    if (!flight_number) return fail(400, 'VALIDATION_ERROR', null, `flights[${i}].flight_number is required`);
    if (!IATA_RE.test(origin) || !IATA_RE.test(destination)) {
      return fail(400, 'VALIDATION_ERROR', null, `flights[${i}] origin/destination must be 3-letter IATA codes`);
    }
    const o = airport(origin);
    const d = airport(destination);
    if (!o || !d) return fail(400, 'VALIDATION_ERROR', null, `flights[${i}]: unknown airport timezone for ${!o ? origin : destination}`);
    const dep = normalizeWallClock(f.departure_datetime);
    if (!dep) return fail(400, 'VALIDATION_ERROR', null, `flights[${i}].departure_datetime is not a valid local date-time`);
    const depUtc = wallClockToUtc(dep, o.tz);
    if (!depUtc) return fail(400, 'VALIDATION_ERROR', null, `flights[${i}].departure_datetime does not exist in ${o.tz}`);
    let arr = null;
    let arrUtc = null;
    if (f.arrival_datetime) {
      arr = normalizeWallClock(f.arrival_datetime);
      arrUtc = arr && wallClockToUtc(arr, d.tz);
      if (!arrUtc) return fail(400, 'VALIDATION_ERROR', null, `flights[${i}].arrival_datetime is not a valid local date-time`);
      if (arrUtc <= depUtc) return fail(422, 'REJECTED', 'ARRIVAL_BEFORE_DEPARTURE', `flights[${i}] arrives before it departs once timezones are applied`);
    }
    legs.push({
      airline, flight_number, origin, destination,
      departure_datetime: dep, arrival_datetime: arr,
      departure_utc: depUtc.toISOString(), arrival_utc: arrUtc ? arrUtc.toISOString() : null,
    });
  }

  legs.sort((a, b) => new Date(a.departure_utc) - new Date(b.departure_utc));

  const airlines = new Set(legs.map((l) => l.airline));
  if (airlines.size > 1) return fail(422, 'REJECTED', 'MULTI_AIRLINE', 'All legs must be operated by the same airline');

  const visited = new Set([legs[0].origin]);
  for (let i = 0; i < legs.length; i++) {
    if (i > 0 && legs[i].origin !== legs[i - 1].destination) {
      return fail(422, 'REJECTED', 'INVALID_ONE_WAY_ITINERARY', `Leg ${i + 1} does not depart from where leg ${i} arrives`);
    }
    if (visited.has(legs[i].destination)) {
      return fail(422, 'REJECTED', 'INVALID_ONE_WAY_ITINERARY', `Itinerary revisits ${legs[i].destination}; only one-way journeys are supported`);
    }
    visited.add(legs[i].destination);
  }

  const hoursAway = (new Date(legs[0].departure_utc) - now) / 36e5;
  if (hoursAway < MIN_HOURS_BEFORE_DEPARTURE) {
    return fail(422, 'REJECTED', 'DEPARTURE_TOO_CLOSE', `First departure is ${hoursAway.toFixed(1)}h away; at least ${MIN_HOURS_BEFORE_DEPARTURE}h is required`);
  }
  return { ok: true, legs };
}

export const isInternational = (legs) =>
  new Set(legs.flatMap((l) => [airport(l.origin)?.country, airport(l.destination)?.country])).size > 1;

function fail(status, error, reason_code, message) {
  return { ok: false, status, error, ...(reason_code ? { reason_code } : {}), message };
}
