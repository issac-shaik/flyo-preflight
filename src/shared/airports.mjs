// Airport reference data used for timezone math and domestic/international detection.
// Deliberately small: Indian airports plus the hubs Indian travellers use most.
// A production build would load the full OurAirports / IATA dataset.

export const AIRPORTS = {
  // India
  HYD: { city: 'Hyderabad', country: 'IN', tz: 'Asia/Kolkata' },
  DEL: { city: 'Delhi', country: 'IN', tz: 'Asia/Kolkata' },
  BOM: { city: 'Mumbai', country: 'IN', tz: 'Asia/Kolkata' },
  BLR: { city: 'Bengaluru', country: 'IN', tz: 'Asia/Kolkata' },
  MAA: { city: 'Chennai', country: 'IN', tz: 'Asia/Kolkata' },
  CCU: { city: 'Kolkata', country: 'IN', tz: 'Asia/Kolkata' },
  COK: { city: 'Kochi', country: 'IN', tz: 'Asia/Kolkata' },
  GOI: { city: 'Goa (Dabolim)', country: 'IN', tz: 'Asia/Kolkata' },
  GOX: { city: 'Goa (Mopa)', country: 'IN', tz: 'Asia/Kolkata' },
  PNQ: { city: 'Pune', country: 'IN', tz: 'Asia/Kolkata' },
  AMD: { city: 'Ahmedabad', country: 'IN', tz: 'Asia/Kolkata' },
  JAI: { city: 'Jaipur', country: 'IN', tz: 'Asia/Kolkata' },
  VTZ: { city: 'Visakhapatnam', country: 'IN', tz: 'Asia/Kolkata' },
  VGA: { city: 'Vijayawada', country: 'IN', tz: 'Asia/Kolkata' },
  TIR: { city: 'Tirupati', country: 'IN', tz: 'Asia/Kolkata' },
  LKO: { city: 'Lucknow', country: 'IN', tz: 'Asia/Kolkata' },
  ATQ: { city: 'Amritsar', country: 'IN', tz: 'Asia/Kolkata' },
  SXR: { city: 'Srinagar', country: 'IN', tz: 'Asia/Kolkata' },
  IXL: { city: 'Leh', country: 'IN', tz: 'Asia/Kolkata' },
  TRV: { city: 'Thiruvananthapuram', country: 'IN', tz: 'Asia/Kolkata' },
  // Middle East
  DXB: { city: 'Dubai', country: 'AE', tz: 'Asia/Dubai' },
  AUH: { city: 'Abu Dhabi', country: 'AE', tz: 'Asia/Dubai' },
  SHJ: { city: 'Sharjah', country: 'AE', tz: 'Asia/Dubai' },
  DOH: { city: 'Doha', country: 'QA', tz: 'Asia/Qatar' },
  MCT: { city: 'Muscat', country: 'OM', tz: 'Asia/Muscat' },
  BAH: { city: 'Bahrain', country: 'BH', tz: 'Asia/Bahrain' },
  KWI: { city: 'Kuwait', country: 'KW', tz: 'Asia/Kuwait' },
  RUH: { city: 'Riyadh', country: 'SA', tz: 'Asia/Riyadh' },
  JED: { city: 'Jeddah', country: 'SA', tz: 'Asia/Riyadh' },
  // Asia-Pacific
  SIN: { city: 'Singapore', country: 'SG', tz: 'Asia/Singapore' },
  BKK: { city: 'Bangkok', country: 'TH', tz: 'Asia/Bangkok' },
  HKT: { city: 'Phuket', country: 'TH', tz: 'Asia/Bangkok' },
  KUL: { city: 'Kuala Lumpur', country: 'MY', tz: 'Asia/Kuala_Lumpur' },
  DPS: { city: 'Bali (Denpasar)', country: 'ID', tz: 'Asia/Makassar' },
  CMB: { city: 'Colombo', country: 'LK', tz: 'Asia/Colombo' },
  MLE: { city: 'Malé', country: 'MV', tz: 'Indian/Maldives' },
  KTM: { city: 'Kathmandu', country: 'NP', tz: 'Asia/Kathmandu' },
  SGN: { city: 'Ho Chi Minh City', country: 'VN', tz: 'Asia/Ho_Chi_Minh' },
  HAN: { city: 'Hanoi', country: 'VN', tz: 'Asia/Ho_Chi_Minh' },
  HKG: { city: 'Hong Kong', country: 'HK', tz: 'Asia/Hong_Kong' },
  NRT: { city: 'Tokyo (Narita)', country: 'JP', tz: 'Asia/Tokyo' },
  HND: { city: 'Tokyo (Haneda)', country: 'JP', tz: 'Asia/Tokyo' },
  SYD: { city: 'Sydney', country: 'AU', tz: 'Australia/Sydney' },
  MEL: { city: 'Melbourne', country: 'AU', tz: 'Australia/Melbourne' },
  // Europe
  LHR: { city: 'London Heathrow', country: 'GB', tz: 'Europe/London' },
  LGW: { city: 'London Gatwick', country: 'GB', tz: 'Europe/London' },
  MAN: { city: 'Manchester', country: 'GB', tz: 'Europe/London' },
  CDG: { city: 'Paris', country: 'FR', tz: 'Europe/Paris' },
  FRA: { city: 'Frankfurt', country: 'DE', tz: 'Europe/Berlin' },
  MUC: { city: 'Munich', country: 'DE', tz: 'Europe/Berlin' },
  AMS: { city: 'Amsterdam', country: 'NL', tz: 'Europe/Amsterdam' },
  ZRH: { city: 'Zurich', country: 'CH', tz: 'Europe/Zurich' },
  FCO: { city: 'Rome', country: 'IT', tz: 'Europe/Rome' },
  MAD: { city: 'Madrid', country: 'ES', tz: 'Europe/Madrid' },
  IST: { city: 'Istanbul', country: 'TR', tz: 'Europe/Istanbul' },
  // Americas
  JFK: { city: 'New York JFK', country: 'US', tz: 'America/New_York' },
  EWR: { city: 'Newark', country: 'US', tz: 'America/New_York' },
  SFO: { city: 'San Francisco', country: 'US', tz: 'America/Los_Angeles' },
  ORD: { city: 'Chicago', country: 'US', tz: 'America/Chicago' },
  IAD: { city: 'Washington Dulles', country: 'US', tz: 'America/New_York' },
  YYZ: { city: 'Toronto', country: 'CA', tz: 'America/Toronto' },
  YVR: { city: 'Vancouver', country: 'CA', tz: 'America/Vancouver' },
};

export const SCHENGEN = new Set([
  'AT', 'BE', 'BG', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT',
  'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'CH',
]);

export const COUNTRY_NAMES = {
  IN: 'India', AE: 'UAE', QA: 'Qatar', OM: 'Oman', BH: 'Bahrain', KW: 'Kuwait', SA: 'Saudi Arabia', SG: 'Singapore',
  TH: 'Thailand', MY: 'Malaysia', ID: 'Indonesia', LK: 'Sri Lanka', MV: 'Maldives', NP: 'Nepal', VN: 'Vietnam',
  HK: 'Hong Kong', JP: 'Japan', AU: 'Australia', GB: 'United Kingdom', FR: 'France', DE: 'Germany', NL: 'Netherlands',
  CH: 'Switzerland', IT: 'Italy', ES: 'Spain', TR: 'Türkiye', US: 'United States', CA: 'Canada',
};

export const airport = (code) => AIRPORTS[String(code || '').toUpperCase()] || null;
export const countryName = (cc) => COUNTRY_NAMES[cc] || cc;
