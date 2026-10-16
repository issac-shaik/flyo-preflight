// Mock airline check-in configuration (hours before departure that web check-in opens).
// Illustrative values only. Flyo's real per-airline/per-route timings are internal to Flyo.
// Airlines that are "known" but have no timing are routed to manual fulfillment, per Flyo docs.

export const AIRLINES = {
  '6E': { name: 'IndiGo', windowHours: 48 },
  AI: { name: 'Air India', windowHours: 48 },
  IX: { name: 'Air India Express', windowHours: 48 },
  QP: { name: 'Akasa Air', windowHours: 48 },
  SG: { name: 'SpiceJet', windowHours: 48 },
  EK: { name: 'Emirates', windowHours: 48 },
  QR: { name: 'Qatar Airways', windowHours: 48 },
  EY: { name: 'Etihad', windowHours: 30 },
  SQ: { name: 'Singapore Airlines', windowHours: 48 },
  TG: { name: 'Thai Airways', windowHours: 24 },
  BA: { name: 'British Airways', windowHours: 24 },
  LH: { name: 'Lufthansa', windowHours: 23 },
  UL: { name: 'SriLankan Airlines', windowHours: null }, // known, no timing -> manual fulfillment
};

export const airlineName = (code) => AIRLINES[code]?.name || code;
