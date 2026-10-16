// Entry, transit and passport-validity rules for INDIAN passport holders.
// ILLUSTRATIVE DATA, simplified for a demo and not legal advice. Entry rules change often;
// a production build would query IATA Timatic or a provider such as Sherpa / VisaDB.

export const RULES_AS_OF = '2025 (demo dataset, verify before relying on it)';

// entry: visa_free | visa_on_arrival | e_visa | eta | visa_required | no_passport_needed
// minValidityMonths: months the passport must remain valid after arrival (null = valid for duration of stay)
export const ENTRY_RULES_IN = {
  AE: { entry: 'visa_required', minValidityMonths: 6, note: 'Pre-arranged UAE visa needed. Visa on arrival only if holding a valid US visa/green card or UK/EU residence.' },
  QA: { entry: 'visa_on_arrival', minValidityMonths: 6, note: 'Visa waiver on arrival with confirmed hotel booking and return ticket.' },
  OM: { entry: 'e_visa', minValidityMonths: 6 },
  BH: { entry: 'e_visa', minValidityMonths: 6 },
  KW: { entry: 'visa_required', minValidityMonths: 6 },
  SA: { entry: 'visa_required', minValidityMonths: 6 },
  SG: { entry: 'visa_required', minValidityMonths: 6, note: 'Singapore visa via an authorised agent. SG Arrival Card within 3 days of arrival.' },
  TH: { entry: 'visa_free', minValidityMonths: 6, note: 'Visa-free stay. Thailand Digital Arrival Card (TDAC) must be filed within 3 days before arrival.', action: 'TDAC' },
  MY: { entry: 'visa_free', minValidityMonths: 6, note: 'Visa-free stay. Malaysia Digital Arrival Card (MDAC) required within 3 days of arrival.', action: 'MDAC' },
  ID: { entry: 'visa_on_arrival', minValidityMonths: 6, note: 'e-VOA recommended before travel.' },
  LK: { entry: 'eta', minValidityMonths: 6, note: 'Electronic Travel Authorisation (ETA) required.' },
  MV: { entry: 'visa_on_arrival', minValidityMonths: 6, note: 'Free 30-day visa on arrival. IMUGA traveller declaration within 96 hours of arrival.' },
  NP: { entry: 'no_passport_needed', minValidityMonths: 0, note: 'Passport or voter ID accepted.' },
  VN: { entry: 'e_visa', minValidityMonths: 6 },
  HK: { entry: 'visa_free', minValidityMonths: 6, note: 'Pre-arrival Registration (PAR) required before travel.' },
  JP: { entry: 'e_visa', minValidityMonths: 0 },
  AU: { entry: 'visa_required', minValidityMonths: 0 },
  GB: { entry: 'visa_required', minValidityMonths: null, note: 'UK visit visa required. Passport must be valid for the whole stay.' },
  US: { entry: 'visa_required', minValidityMonths: 6 },
  CA: { entry: 'visa_required', minValidityMonths: 0 },
  TR: { entry: 'visa_required', minValidityMonths: 6, note: 'e-Visa possible if holding a valid US/UK/Schengen visa or residence permit.' },
  SCHENGEN: { entry: 'visa_required', minValidityMonths: 3, issuedWithinYears: 10, note: 'Schengen visa required. Passport valid 3 months beyond departure from the Schengen area and issued within the last 10 years.' },
};

// Airside transit (same airline, as Flyo requires) for Indian passport holders.
export const TRANSIT_RULES_IN = {
  GB: { kind: 'datv', note: 'UK Direct Airside Transit Visa (DATV) required unless holding a valid visa for the US, Canada, Australia, New Zealand, Ireland, the Schengen area or the UK.', exemptVisas: ['US', 'CA', 'AU', 'NZ', 'IE', 'SCHENGEN', 'GB'] },
  US: { kind: 'visa', note: 'No airside transit in the US: a US visa (C1/B1/B2) is required even to connect.', exemptVisas: ['US'] },
  CA: { kind: 'visa', note: 'Canada requires a transit visa for Indian nationals.', exemptVisas: ['CA'] },
  SCHENGEN: { kind: 'atv', note: 'An airport transit visa may be required depending on the Schengen country; confirm with the carrier.', exemptVisas: ['SCHENGEN', 'US', 'CA', 'GB'] },
  DEFAULT: { kind: 'none', maxAirsideHours: 24, note: 'Airside transit under 24 hours generally needs no visa.' },
};

export const ENTRY_LABEL = {
  visa_free: 'Visa-free',
  visa_on_arrival: 'Visa on arrival',
  e_visa: 'e-Visa required',
  eta: 'ETA required',
  visa_required: 'Visa required',
  no_passport_needed: 'No visa needed',
};

export const NEEDS_DOCUMENT = new Set(['visa_required', 'e_visa', 'eta']);
