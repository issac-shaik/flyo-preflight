// Demo fixtures: e-tickets (PDF + text) and traveller documents (SVG with a valid ICAO MRZ).
// Dates are generated relative to "now" so every sample is always a real future trip.
// All people, numbers and contacts are fictitious.
import { makePdf } from './pdfWriter.mjs';
import { randomInt } from 'node:crypto';
import { buildMrz } from '../readiness/mrz.mjs';
import { utcToWallClock, addMonths } from '../../shared/time.mjs';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const istToday = () => utcToWallClock(new Date(), 'Asia/Kolkata').slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const parts = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return { d: d.getUTCDate(), m: MON[d.getUTCMonth()], y: d.getUTCFullYear(), dow: DOW[d.getUTCDay()] }; };
const indigo = (iso, t) => { const p = parts(iso); return `${p.dow}, ${p.d} ${p.m} ${p.y}, ${t}`; };
const emirates = (iso, t) => { const p = parts(iso); return `${String(p.d).padStart(2, '0')}${p.m}${String(p.y).slice(2)} ${t}`; };
const ba = (iso, t) => { const p = parts(iso); return `${p.dow} ${p.d} ${p.m} ${p.y} at ${t}`; };
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const AGENCY = 'Booked via Sunrise Holidays, Banjara Hills, Hyderabad | bookings@sunrise-holidays.example | +91 40 0000 0000';

// Each generated ticket gets a fresh PNR: Flyo de-duplicates on PNR + first departure and rejects
// re-subscribing a completed attempt, so re-running a demo with the same PNR would (correctly) be refused.
const PNR_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const freshPnr = (prefix) => prefix + Array.from({ length: 6 - prefix.length }, () => PNR_CHARS[randomInt(PNR_CHARS.length)]).join('');

// ------------------------------------------------------------------ tickets
function ticketDefs() {
  const t = istToday();
  const d2 = addDays(t, 2);
  const d3 = addDays(t, 3);
  const d6 = addDays(t, 6);
  const pnr = { goa: freshPnr('K7'), lon: freshPnr('EK'), bkk: freshPnr('R4'), ny: freshPnr('QX') };
  return {
    goa_family: {
      label: 'Goa family trip (domestic, return)',
      blurb: 'IndiGo HYD to GOX and back, 2 adults, no email on ticket',
      brand: { name: 'IndiGo', color: '#1c2a6b' },
      contact: { name: 'Arjun Reddy', phone: '+91 98765 00001' },
      lines: [
        ['h', 'IndiGo  |  Booking Confirmation and E-Ticket'],
        ['', `PNR: ${pnr.goa}        Booking date: ${indigo(t, '10:42').replace(/, \d\d:\d\d$/, '')}        Status: Confirmed`],
        ['s', 'Passenger(s)'],
        ['', '1. Mr Arjun Reddy        Adult        Seat: 12A'],
        ['', '2. Mrs Kavya Reddy       Adult        Seat: 12B'],
        ['s', 'Onward journey'],
        ['b', 'Flight 6E 6281        HYD Hyderabad  ->  GOX Goa (Mopa)'],
        ['', `Departure: ${indigo(d2, '06:10')}      Arrival: ${indigo(d2, '07:35')}`],
        ['s', 'Return journey'],
        ['b', 'Flight 6E 6282        GOX Goa (Mopa)  ->  HYD Hyderabad'],
        ['', `Departure: ${indigo(d6, '19:20')}      Arrival: ${indigo(d6, '20:45')}`],
        ['s', 'Fare summary'],
        ['', 'Base fare INR 9,420   Taxes INR 2,422   Total INR 11,842 (2 passengers)'],
        ['f', AGENCY],
        ['f', 'Web check-in opens 48 hours before departure. Carry a valid government photo ID.'],
      ],
    },
    london_priya: {
      label: 'London via Dubai (needs UK visa)',
      blurb: 'Emirates HYD-DXB-LHR, 1 adult, email on ticket',
      brand: { name: 'Emirates', color: '#c8102e' },
      contact: { name: 'Priya Sharma', phone: '+91 98765 00002' },
      lines: [
        ['h', 'Emirates  e-Ticket Receipt and Itinerary'],
        ['', `Booking reference (PNR): ${pnr.lon}          E-ticket number: 176 2400000001`],
        ['', 'Passenger name: SHARMA/PRIYA MS'],
        ['', 'Passenger email: priya.sharma@example.com'],
        ['s', 'Flight     From               To                   Departure        Arrival          Class'],
        ['b', `EK 527     HYD Hyderabad      DXB Dubai            ${emirates(d2, '04:25')}    ${emirates(d2, '06:45')}    Economy`],
        ['b', `EK 003     DXB Dubai          LHR London Heathrow  ${emirates(d2, '07:50')}    ${emirates(d2, '12:30')}    Economy`],
        ['s', 'Baggage: 30kg checked, 7kg cabin. Times are local to each airport.'],
        ['f', AGENCY],
        ['f', 'Emirates contact centre: support@emirates.example'],
      ],
    },
    bangkok_rahul: {
      label: 'Bangkok (visa-free, passport check)',
      blurb: 'IndiGo HYD to BKK overnight, 1 adult',
      brand: { name: 'IndiGo', color: '#1c2a6b' },
      contact: { name: 'Rahul Verma', phone: '+91 98765 00003' },
      lines: [
        ['h', 'IndiGo  |  Booking Confirmation and E-Ticket'],
        ['', `PNR: ${pnr.bkk}        Status: Confirmed`],
        ['s', 'Passenger(s)'],
        ['', '1. Mr Rahul Verma        Adult        Seat: 21C'],
        ['', 'Passenger email: rahul.verma@example.com'],
        ['s', 'Onward journey'],
        ['b', 'Flight 6E 1067        HYD Hyderabad  ->  BKK Bangkok (Suvarnabhumi)'],
        ['', `Departure: ${indigo(d2, '23:55')}      Arrival: ${indigo(d3, '05:05')}`],
        ['f', AGENCY],
      ],
    },
    newyork_neha: {
      label: 'New York via London (US visa + UK DATV)',
      blurb: 'British Airways HYD-LHR-JFK, 1 adult',
      brand: { name: 'British Airways', color: '#075aaa' },
      contact: { name: 'Neha Iyer', phone: '+91 98765 00004' },
      lines: [
        ['h', 'British Airways  |  Your booking confirmation'],
        ['', `Booking reference: ${pnr.ny}`],
        ['', 'Passenger: Ms Neha Iyer'],
        ['', 'Passenger email: neha.iyer@example.com'],
        ['s', 'Outbound'],
        ['b', 'BA 276  Hyderabad (HYD) to London Heathrow (LHR)'],
        ['', `Depart ${ba(d2, '01:55')}    Arrive ${ba(d2, '07:25')}`],
        ['b', 'BA 117  London Heathrow (LHR) to New York JFK (JFK)'],
        ['', `Depart ${ba(d2, '11:20')}    Arrive ${ba(d2, '14:10')}`],
        ['f', AGENCY],
      ],
    },
  };
}

const STYLE = { h: { size: 17, font: 'F2', gap: 30 }, s: { size: 11, font: 'F2', gap: 26, color: '#475467' }, b: { size: 10.5, font: 'F2', gap: 18 }, f: { size: 8.5, font: 'F1', gap: 16, color: '#667085' }, '': { size: 10, font: 'F1', gap: 17 } };

export function listTicketSamples() {
  return Object.entries(ticketDefs()).map(([id, d]) => ({ id, label: d.label, blurb: d.blurb, contact: d.contact }));
}

export function ticketSample(id) {
  const d = ticketDefs()[id];
  if (!d) return null;
  const text = d.lines.map(([, s]) => s).join('\n');
  const texts = [];
  let y = 70;
  let footerStarted = false;
  for (const [kind, s] of d.lines) {
    const st = STYLE[kind];
    if (kind === 'f' && !footerStarted) { y += 24; footerStarted = true; }
    texts.push({ x: 40, y, text: s, size: st.size, font: kind === 'b' && s.includes('    ') ? 'F3' : st.font, color: kind === 'h' ? '#ffffff' : st.color });
    y += st.gap;
  }
  texts[0].y = 52;
  const pdf = makePdf({ rects: [{ x: 0, y: 0, w: 595, h: 80, color: d.brand.color }, { x: 40, y: y - 6, w: 515, h: 0.8, color: '#d0d5dd' }], texts }, { title: `${d.brand.name} e-ticket` });
  return { id, label: d.label, text, pdf, contact: d.contact, filename: `${id}-eticket.pdf` };
}

// ------------------------------------------------------------------ traveller documents
function docDefs() {
  const t = istToday();
  return {
    priya_passport: { owner: 'Sharma', label: 'Priya: passport', kind: 'passport', surname: 'SHARMA', given_names: 'PRIYA', number: 'Z4821937', nationality: 'IN', date_of_birth: '1994-07-12', sex: 'F', date_of_issue: '2021-03-15', expiry_date: '2031-03-14', place_of_issue: 'HYDERABAD' },
    priya_passport_blurry: { owner: 'Sharma', label: 'Priya: passport (blurry photo)', kind: 'passport', surname: 'SHARMA', given_names: 'PRIYA', number: 'Z4821937', nationality: 'IN', date_of_birth: '1994-07-12', sex: 'F', date_of_issue: '2021-03-15', expiry_date: '2031-03-14', place_of_issue: 'HYDERABAD', corrupt: true },
    priya_uk_visa: { owner: 'Sharma', label: 'Priya: UK visit visa', kind: 'visa', issuing: 'GB', surname: 'SHARMA', given_names: 'PRIYA', number: '451200789', nationality: 'IN', date_of_birth: '1994-07-12', sex: 'F', valid_from: addDays(t, -30), expiry_date: addMonths(addDays(t, -30), 6), visa_type: 'VISIT' },
    rahul_passport_old: { owner: 'Verma', label: 'Rahul: old passport', kind: 'passport', surname: 'VERMA', given_names: 'RAHUL', number: 'K2210456', nationality: 'IN', date_of_birth: '1990-02-03', sex: 'M', date_of_issue: addMonths(addMonths(t, 4), -120), expiry_date: addDays(addMonths(t, 4), -1), place_of_issue: 'HYDERABAD' },
    rahul_passport_new: { owner: 'Verma', label: 'Rahul: renewed passport', kind: 'passport', surname: 'VERMA', given_names: 'RAHUL KUMAR', number: 'W9013275', nationality: 'IN', date_of_birth: '1990-02-03', sex: 'M', date_of_issue: addDays(t, -20), expiry_date: addDays(addMonths(addDays(t, -20), 120), -1), place_of_issue: 'HYDERABAD' },
    neha_passport: { owner: 'Iyer', label: 'Neha: passport', kind: 'passport', surname: 'IYER', given_names: 'NEHA', number: 'V6612094', nationality: 'IN', date_of_birth: '1988-11-21', sex: 'F', date_of_issue: '2019-06-10', expiry_date: '2029-06-09', place_of_issue: 'CHENNAI' },
    neha_us_visa: { owner: 'Iyer', label: 'Neha: US B1/B2 visa', kind: 'visa', issuing: 'US', surname: 'IYER', given_names: 'NEHA', number: 'R83920114', nationality: 'IN', date_of_birth: '1988-11-21', sex: 'F', valid_from: '2023-01-12', expiry_date: '2033-01-10', visa_type: 'B1/B2' },
  };
}

export function listDocSamples(lastNames = []) {
  const wanted = lastNames.map((n) => n.toUpperCase());
  return Object.entries(docDefs())
    .filter(([, d]) => !wanted.length || wanted.includes(d.owner.toUpperCase()))
    .map(([id, d]) => ({ id, label: d.label, kind: d.kind, url: `/api/samples/docs/${id}.svg` }));
}

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function docSampleSvg(id) {
  const d = docDefs()[id];
  if (!d) return null;
  let [l1, l2] = buildMrz({ kind: d.kind, issuing: d.issuing || d.nationality, surname: d.surname, given_names: d.given_names, number: d.number, nationality: d.nationality, date_of_birth: d.date_of_birth, sex: d.sex, expiry_date: d.expiry_date });
  if (d.corrupt) l2 = `${l2.slice(0, 6)}8${l2.slice(7)}`; // a misread digit: 3 -> 8, check digits no longer verify
  const isPass = d.kind === 'passport';
  const fields = isPass
    ? [['Type', 'P'], ['Country Code', 'IND'], ['Passport No.', d.corrupt ? `${d.number.slice(0, 6)}8${d.number.slice(7)}` : d.number], ['Surname', d.surname], ['Given Name(s)', d.given_names], ['Nationality', 'INDIAN'], ['Sex', d.sex], ['Date of Birth', dmy(d.date_of_birth)], ['Place of Issue', d.place_of_issue], ['Date of Issue', dmy(d.date_of_issue)], ['Date of Expiry', dmy(d.expiry_date)]]
    : [['Valid From', dmy(d.valid_from)], ['Valid Until', dmy(d.expiry_date)], ['Type of Visa', d.visa_type], ['Number', d.number], ['Surname', d.surname], ['Given Name(s)', d.given_names], ['Nationality', 'IND'], ['Date of Birth', dmy(d.date_of_birth)]];
  const title = isPass ? 'REPUBLIC OF INDIA  |  PASSPORT' : d.issuing === 'GB' ? 'UNITED KINGDOM  |  VISA' : 'UNITED STATES OF AMERICA  |  VISA';
  const bg = isPass ? '#e8f0e8' : d.issuing === 'GB' ? '#efe9f5' : '#e9f0f7';
  const accent = isPass ? '#1f4e3d' : d.issuing === 'GB' ? '#4b2e83' : '#1d3f73';
  const cols = fields.map(([k, v], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const fx = 220 + col * 230;
    const fy = 92 + row * 44;
    return `<text x="${fx}" y="${fy}" font-family="Arial" font-size="11" fill="#475467">${x(k)}</text>\n<text x="${fx}" y="${fy + 17}" font-family="Arial" font-size="15" font-weight="700" fill="#101828">${x(v)}</text>`;
  }).join('\n');
  const blur = d.corrupt ? '<filter id="b"><feGaussianBlur stdDeviation="1.2"/></filter>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="700" height="440" viewBox="0 0 700 440" role="img" aria-label="Specimen ${x(d.kind)} for ${x(d.given_names)} ${x(d.surname)}">
<defs>${blur}</defs>
<g ${d.corrupt ? 'filter="url(#b)"' : ''}>
<rect width="700" height="440" rx="16" fill="${bg}" stroke="#98a2b3"/>
<rect width="700" height="52" rx="16" fill="${accent}"/><rect y="36" width="700" height="16" fill="${accent}"/>
<text x="24" y="34" font-family="Arial" font-size="18" font-weight="700" fill="#fff">${title}</text>
<text x="676" y="34" font-family="Arial" font-size="12" fill="#fecdca" text-anchor="end">SPECIMEN / DEMO ONLY</text>
<rect x="28" y="76" width="160" height="200" rx="8" fill="#d0d5dd"/>
<circle cx="108" cy="150" r="40" fill="#98a2b3"/><rect x="58" y="200" width="100" height="60" rx="30" fill="#98a2b3"/>
${cols}
<rect x="0" y="352" width="700" height="88" fill="#ffffff" opacity="0.7"/>
<text x="24" y="386" font-family="Consolas, 'Courier New', monospace" font-size="19" letter-spacing="1.2" fill="#101828">${x(l1)}</text>
<text x="24" y="416" font-family="Consolas, 'Courier New', monospace" font-size="19" letter-spacing="1.2" fill="#101828">${x(l2)}</text>
</g>
</svg>`;
}
