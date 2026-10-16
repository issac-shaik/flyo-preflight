// Travel-readiness engine: everything that would make check-in fail, or make the traveller get
// turned away at the airport, evaluated before the airline's check-in window opens.
import { airport, countryName, SCHENGEN } from '../../shared/airports.mjs';
import { validateJourney, isInternational } from '../../shared/journey.mjs';
import { addMonths, utcToWallClock } from '../../shared/time.mjs';
import { compareNames } from './names.mjs';
import { ENTRY_RULES_IN, TRANSIT_RULES_IN, ENTRY_LABEL, NEEDS_DOCUMENT, RULES_AS_OF } from './travelRules.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PNR_RE = /^[A-Z0-9]{6}$/;
const GENERIC_WINDOW_HOURS = 48;

const regionKey = (cc) => (SCHENGEN.has(cc) ? 'SCHENGEN' : cc);

export const passportComplete = (p) => {
  const pp = p.passport || {};
  return Boolean(pp.number && pp.date_of_issue && pp.expiry_date && pp.place_of_issue && (pp.nationality || p.nationality));
};

/** Valid visa held by a passenger for a country or region, on a given date. */
function heldVisa(p, regionOrCountry, onDate) {
  return (p.documents || []).find((d) => {
    if (d.type !== 'VISA' || !d.issuing_country) return false;
    const key = d.issuing_country === 'SCHENGEN' ? 'SCHENGEN' : regionKey(d.issuing_country);
    if (key !== regionOrCountry) return false;
    return !onDate || !d.expiry_date || d.expiry_date >= onDate;
  });
}

const fmtDate = (iso) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * @param booking app booking (flights already normalised with *_utc fields)
 * @returns {{ overall: 'green'|'amber'|'red', checks: object[], needs: object[], flyoReady: boolean, holdReasons: string[], summary: string, rulesAsOf: string }}
 */
export function evaluateReadiness(booking, now = new Date()) {
  const checks = [];
  const needs = [];
  const add = (c) => checks.push({ passenger: null, ...c });
  const pax = booking.passengers || [];
  const legs = booking.flights || [];
  const label = (i) => `${pax[i].first_name} ${pax[i].last_name}`;

  // ---------------- itinerary (Flyo journey rules) ----------------
  const journey = validateJourney(legs, now);
  if (!journey.ok) {
    add({ id: 'journey', group: 'itinerary', level: 'fail', label: 'Flyo journey rules', detail: `${journey.reason_code || journey.error}: ${journey.message}` });
  } else {
    add({ id: 'journey', group: 'itinerary', level: 'pass', label: 'Flyo journey rules', detail: `One-way, ${legs.length} leg${legs.length > 1 ? 's' : ''}, single airline, departs more than 6h from now` });
  }
  const sorted = journey.ok ? journey.legs : legs;
  const intl = sorted.length ? isInternational(sorted) : false;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const destCountry = last ? airport(last.destination)?.country : null;
  const arrivalUtc = last?.arrival_utc || last?.departure_utc;
  const arrivalDate = arrivalUtc && destCountry ? utcToWallClock(new Date(arrivalUtc), airport(last.destination).tz).slice(0, 10) : null;
  const departureDate = first?.departure_datetime?.slice(0, 10);

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a.arrival_utc) continue;
    const mins = (new Date(b.departure_utc) - new Date(a.arrival_utc)) / 60000;
    const where = `${a.destination} (${airport(a.destination)?.city})`;
    if (mins < (intl ? 60 : 45)) {
      add({ id: `mct-${i}`, group: 'itinerary', level: 'warn', label: `Connection at ${a.destination}`, detail: `Only ${Math.round(mins)} min to connect at ${where}; tight for the minimum connection time` });
    } else {
      add({ id: `mct-${i}`, group: 'itinerary', level: 'pass', label: `Connection at ${a.destination}`, detail: `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m layover at ${where}` });
    }
  }

  // ---------------- data Flyo needs before it can automate ----------------
  if (!booking.pnr || !PNR_RE.test(booking.pnr)) {
    add({ id: 'pnr', group: 'flyo', level: 'fail', label: 'PNR', detail: 'Missing or invalid 6-character PNR. Flyo will report MISSING_PNR.' });
  } else {
    add({ id: 'pnr', group: 'flyo', level: 'pass', label: 'PNR', detail: booking.pnr });
  }
  const emailPax = pax.findIndex((p) => p.email && EMAIL_RE.test(p.email));
  if (emailPax === -1) {
    add({ id: 'email', group: 'flyo', level: 'pending', label: 'Contact email', detail: 'At least one valid passenger email is required (Flyo MISSING_EMAIL)' });
    needs.push({ pi: 0, item: 'email', label: 'Email address for the booking' });
  } else {
    add({ id: 'email', group: 'flyo', level: 'pass', label: 'Contact email', detail: pax[emailPax].email });
  }

  // ---------------- per-passenger documents, entry and transit ----------------
  if (intl) {
    pax.forEach((p, i) => {
      const pp = p.passport;
      const nat = pp?.nationality || p.nationality || null;
      if (!pp || !passportComplete(p)) {
        const missing = ['number', 'date_of_issue', 'expiry_date', 'place_of_issue'].filter((f) => !pp?.[f]);
        add({ id: `passport-${i}`, group: 'documents', passenger: i, level: 'pending', label: 'Passport details',
          detail: pp ? `Still missing: ${missing.join(', ').replace(/_/g, ' ')}` : 'Not received yet (Flyo MISSING_PASSPORT)' });
        needs.push({ pi: i, item: 'passport', label: `Passport photo for ${label(i)}` });
      } else {
        add({ id: `passport-${i}`, group: 'documents', passenger: i, level: 'pass', label: 'Passport details', detail: `${pp.number}, issued ${pp.place_of_issue}` });
        if (pp.mrz_valid === false) {
          add({ id: `mrz-${i}`, group: 'documents', passenger: i, level: 'warn', label: 'Passport MRZ check digits',
            detail: `Check digits do not verify (${Object.entries(pp.mrz_checks || {}).filter(([, ok]) => !ok).map(([k]) => k).join(', ')}). Likely a misread; please confirm the number and dates by eye.` });
        } else if (pp.mrz_valid) {
          add({ id: `mrz-${i}`, group: 'documents', passenger: i, level: 'pass', label: 'Passport MRZ check digits', detail: 'All ICAO 9303 check digits verify' });
        }
        if (pp.surname !== undefined || pp.given_names !== undefined) {
          const nm = compareNames(p, pp);
          add({ id: `name-${i}`, group: 'documents', passenger: i, level: nm.level, label: 'Ticket name vs passport', detail: nm.detail });
        }
        if (departureDate && pp.expiry_date < departureDate) {
          add({ id: `expiry-${i}`, group: 'documents', passenger: i, level: 'fail', label: 'Passport validity', detail: `Passport expired on ${fmtDate(pp.expiry_date)}, before departure` });
        }
      }

      if (nat && nat !== 'IN') {
        add({ id: `nat-${i}`, group: 'entry', passenger: i, level: 'warn', label: 'Entry rules', detail: `Entry rules are only modelled for Indian passports in this demo (${countryName(nat)} passport). Verify manually.` });
        return;
      }
      const assumed = !nat;

      // destination entry
      const destKey = regionKey(destCountry);
      const rule = ENTRY_RULES_IN[destKey];
      if (!rule) {
        add({ id: `entry-${i}`, group: 'entry', passenger: i, level: 'warn', label: `Entry to ${countryName(destCountry)}`, detail: 'No entry rule in the demo dataset; verify manually' });
      } else {
        const where = destKey === 'SCHENGEN' ? 'the Schengen area' : countryName(destCountry);
        if (NEEDS_DOCUMENT.has(rule.entry)) {
          const visa = heldVisa(p, destKey, arrivalDate);
          const expiredVisa = !visa && heldVisa(p, destKey, null);
          if (visa) {
            add({ id: `entry-${i}`, group: 'entry', passenger: i, level: 'pass', label: `Entry to ${where}`, detail: `${ENTRY_LABEL[rule.entry]}: visa ${visa.document_number || ''} valid until ${fmtDate(visa.expiry_date)}`.trim() });
          } else if (expiredVisa) {
            add({ id: `entry-${i}`, group: 'entry', passenger: i, level: 'fail', label: `Entry to ${where}`, detail: `Visa on file expires ${fmtDate(expiredVisa.expiry_date)}, before arrival` });
          } else if (p.declined?.[destKey]) {
            add({ id: `entry-${i}`, group: 'entry', passenger: i, level: 'fail', label: `Entry to ${where}`, detail: `${ENTRY_LABEL[rule.entry]} for Indian passport holders and the traveller says they do not have one` });
          } else {
            add({ id: `entry-${i}`, group: 'entry', passenger: i, level: 'pending', label: `Entry to ${where}`, detail: `${ENTRY_LABEL[rule.entry]}${assumed ? ' (assuming Indian passport)' : ''}. Not received yet.` });
            needs.push({ pi: i, item: 'visa', country: destKey, label: `${destKey === 'SCHENGEN' ? 'Schengen' : countryName(destCountry)} visa for ${label(i)}` });
          }
        } else {
          add({ id: `entry-${i}`, group: 'entry', passenger: i, level: 'pass', label: `Entry to ${where}`, detail: `${ENTRY_LABEL[rule.entry]}${rule.note ? `. ${rule.note}` : ''}` });
        }
        if (rule.action) {
          add({ id: `action-${i}`, group: 'entry', passenger: i, level: 'info', label: `${rule.action} arrival card`, detail: rule.note });
        }
        // passport validity against destination rule
        if (pp?.expiry_date && arrivalDate && pp.expiry_date >= departureDate) {
          if (rule.minValidityMonths) {
            const required = addMonths(arrivalDate, rule.minValidityMonths);
            if (pp.expiry_date < required) {
              add({ id: `expiry-${i}`, group: 'documents', passenger: i, level: 'fail', label: 'Passport validity',
                detail: `${where} requires ${rule.minValidityMonths} months' validity after arrival (until ${fmtDate(required)}); passport expires ${fmtDate(pp.expiry_date)}. Renew before travel.` });
            } else {
              add({ id: `expiry-${i}`, group: 'documents', passenger: i, level: 'pass', label: 'Passport validity', detail: `Valid until ${fmtDate(pp.expiry_date)}; ${where} needs ${rule.minValidityMonths} months after arrival` });
            }
          } else {
            const sixMonths = addMonths(arrivalDate, 6);
            add({ id: `expiry-${i}`, group: 'documents', passenger: i, level: pp.expiry_date < sixMonths ? 'warn' : 'pass', label: 'Passport validity',
              detail: pp.expiry_date < sixMonths
                ? `Expires ${fmtDate(pp.expiry_date)}. ${where} only needs validity for the stay, but some airlines and onward trips need 6 months.`
                : `Valid until ${fmtDate(pp.expiry_date)}` });
          }
          if (rule.issuedWithinYears && pp.date_of_issue) {
            const limit = addMonths(arrivalDate, -12 * rule.issuedWithinYears);
            if (pp.date_of_issue < limit) {
              add({ id: `issued-${i}`, group: 'documents', passenger: i, level: 'fail', label: 'Passport issue date', detail: `Issued ${fmtDate(pp.date_of_issue)}; ${where} requires issue within the last ${rule.issuedWithinYears} years` });
            }
          }
        }
      }

      // transit points
      for (let s = 0; s < sorted.length - 1; s++) {
        const hub = sorted[s].destination;
        const hubCountry = airport(hub)?.country;
        if (!hubCountry || hubCountry === 'IN' || hubCountry === destCountry) continue;
        const key = regionKey(hubCountry);
        const tr = TRANSIT_RULES_IN[key] || TRANSIT_RULES_IN.DEFAULT;
        const layoverH = sorted[s].arrival_utc ? (new Date(sorted[s + 1].departure_utc) - new Date(sorted[s].arrival_utc)) / 36e5 : null;
        const id = `transit-${i}-${hub}`;
        const lbl = `Transit via ${hub} (${countryName(hubCountry)})`;
        if (tr.kind === 'none') {
          const long = layoverH != null && layoverH > (tr.maxAirsideHours || 24);
          add({ id, group: 'transit', passenger: i, level: long ? 'warn' : 'pass', label: lbl,
            detail: long ? `Layover of ${layoverH.toFixed(1)}h exceeds ${tr.maxAirsideHours}h; a transit/entry visa may be required` : tr.note });
          continue;
        }
        const exemptBy = tr.exemptVisas.find((v) => heldVisa(p, v, departureDate));
        if (exemptBy) {
          add({ id, group: 'transit', passenger: i, level: 'pass', label: lbl, detail: `Exempt: holds a valid ${exemptBy === 'SCHENGEN' ? 'Schengen' : countryName(exemptBy)} visa` });
        } else if (p.declined?.[`transit:${key}`]) {
          add({ id, group: 'transit', passenger: i, level: 'fail', label: lbl, detail: `${tr.note} Traveller has none.` });
        } else {
          add({ id, group: 'transit', passenger: i, level: 'pending', label: lbl, detail: tr.note });
          needs.push({ pi: i, item: 'transit', country: key, label: `${tr.kind.toUpperCase()} or exempting visa for ${label(i)} (${hub})` });
        }
      }
    });
  }

  // ---------------- timing ----------------
  if (first?.departure_utc) {
    const opens = new Date(new Date(first.departure_utc).getTime() - GENERIC_WINDOW_HOURS * 36e5);
    const hoursToOpen = (opens - now) / 36e5;
    const outstanding = needs.length > 0;
    const when = `${utcToWallClock(opens, airport(first.origin).tz).replace('T', ' ').slice(0, 16)} ${first.origin} time`;
    if (outstanding && hoursToOpen < 24) {
      add({ id: 'deadline', group: 'timing', level: 'warn', label: 'Collection deadline',
        detail: hoursToOpen <= 0 ? 'Check-in window is likely already open. Every hour of missing info risks a manual check-in.' : `Check-in typically opens around ${when}. Collect the missing details before then.` });
    } else {
      add({ id: 'deadline', group: 'timing', level: 'info', label: 'Check-in window',
        detail: hoursToOpen <= 0 ? 'Check-in window is typically open now' : `Typically opens around ${when}; Flyo starts 15 minutes after the window opens` });
    }
  }

  const flyoReady = Boolean(booking.pnr && PNR_RE.test(booking.pnr)) && emailPax !== -1 && (!intl || pax.every(passportComplete));
  const fails = checks.filter((c) => c.level === 'fail');
  const pendings = checks.filter((c) => c.level === 'pending');
  const warns = checks.filter((c) => c.level === 'warn');
  const overall = fails.length ? 'red' : pendings.length || warns.length ? 'amber' : 'green';
  // Hold the completing Flyo update on blocking issues, outstanding documents, and unverified MRZ
  // check digits (a misread passport number would make the airline check-in fail).
  const holdReasons = [...fails, ...pendings.filter((c) => c.group !== 'flyo'), ...warns.filter((c) => c.id.startsWith('mrz-'))]
    .map((c) => `${c.passenger != null ? `${label(c.passenger)}: ` : ''}${c.label}: ${c.detail}`);
  const summary = fails.length
    ? `${fails.length} blocking issue${fails.length > 1 ? 's' : ''}`
    : pendings.length
      ? `Waiting on ${needs.length} item${needs.length === 1 ? '' : 's'} from the traveller`
      : warns.length
        ? `Ready, with ${warns.length} thing${warns.length > 1 ? 's' : ''} to double-check`
        : 'Ready to fly';
  return { overall, checks, needs, flyoReady, holdReasons, summary, international: intl, rulesAsOf: RULES_AS_OF, evaluatedAt: now.toISOString() };
}
