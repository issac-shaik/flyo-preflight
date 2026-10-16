// Renders a fake (clearly-labelled) boarding pass as SVG for the mock's boarding_passes URLs.
import { airport } from '../shared/airports.mjs';
import { airlineName } from './airlines.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderBoardingPass({ passenger, leg, pnr, seat, seq }) {
  const name = `${passenger.last_name}/${passenger.first_name}`.toUpperCase();
  const dep = leg.departure_datetime.replace('T', ' ').slice(0, 16);
  const boarding = new Date(new Date(`${leg.departure_datetime}Z`).getTime() - 45 * 60000).toISOString().slice(11, 16);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="300" viewBox="0 0 720 300" role="img" aria-label="Mock boarding pass for ${esc(name)}">
  <rect width="720" height="300" rx="18" fill="#ffffff" stroke="#d0d5dd"/>
  <rect width="720" height="64" rx="18" fill="#1d2939"/>
  <rect y="46" width="720" height="18" fill="#1d2939"/>
  <text x="28" y="41" font-family="Segoe UI, Arial" font-size="22" font-weight="700" fill="#fff">${esc(airlineName(leg.airline))}</text>
  <text x="692" y="41" font-family="Segoe UI, Arial" font-size="14" fill="#fda29b" text-anchor="end">VISUAL REPRESENTATION ONLY</text>
  <text x="28" y="100" font-family="Segoe UI, Arial" font-size="12" fill="#667085">PASSENGER</text>
  <text x="28" y="122" font-family="Segoe UI, Arial" font-size="20" font-weight="600" fill="#101828">${esc(name)}</text>
  <text x="28" y="172" font-family="Segoe UI, Arial" font-size="44" font-weight="700" fill="#101828">${esc(leg.origin)}</text>
  <text x="150" y="168" font-family="Segoe UI, Arial" font-size="28" fill="#98a2b3">&#8594;</text>
  <text x="200" y="172" font-family="Segoe UI, Arial" font-size="44" font-weight="700" fill="#101828">${esc(leg.destination)}</text>
  <text x="28" y="194" font-family="Segoe UI, Arial" font-size="13" fill="#667085">${esc(airport(leg.origin)?.city)} to ${esc(airport(leg.destination)?.city)}</text>
  ${[
    ['FLIGHT', `${leg.airline} ${leg.flight_number}`],
    ['DEPARTS (LOCAL)', dep],
    ['BOARDING', boarding],
    ['SEAT', seat],
    ['PNR', pnr || '-'],
    ['SEQ', String(seq).padStart(3, '0')],
  ]
    .map(([k, v], i) => {
      const x = 28 + (i % 3) * 150 + (i >= 3 ? 0 : 0);
      const y = i < 3 ? 236 : 276;
      return `<text x="${x}" y="${y - 16}" font-family="Segoe UI, Arial" font-size="11" fill="#667085">${k}</text><text x="${x}" y="${y}" font-family="Segoe UI, Arial" font-size="16" font-weight="600" fill="#101828">${esc(v)}</text>`;
    })
    .join('\n  ')}
  <line x1="520" y1="80" x2="520" y2="290" stroke="#d0d5dd" stroke-dasharray="6 6"/>
  ${barcode(`${pnr}${leg.flight_number}${name}`)}
  <text x="620" y="280" font-family="Consolas, monospace" font-size="11" fill="#667085" text-anchor="middle">${esc(pnr)} ${esc(leg.airline)}${esc(leg.flight_number)}</text>
</svg>`;
}

function barcode(seed) {
  let h = 2166136261;
  const bars = [];
  let x = 548;
  for (let i = 0; x < 692; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    const w = 1 + (h % 4);
    if (i % 2 === 0) bars.push(`<rect x="${x}" y="96" width="${w}" height="160" fill="#101828"/>`);
    x += w + 1;
  }
  return bars.join('');
}
