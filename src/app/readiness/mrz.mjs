// ICAO 9303 machine-readable zone parsing for passports (TD3) and visas (MRV-A),
// including check-digit verification so OCR / typing errors are caught before they reach the airline.

const ISO3_TO_ISO2 = {
  IND: 'IN', GBR: 'GB', USA: 'US', CAN: 'CA', AUS: 'AU', ARE: 'AE', SGP: 'SG', THA: 'TH', MYS: 'MY', LKA: 'LK',
  NPL: 'NP', BGD: 'BD', PAK: 'PK', FRA: 'FR', DEU: 'DE', D: 'DE', NLD: 'NL', ITA: 'IT', ESP: 'ES', CHE: 'CH', JPN: 'JP',
  QAT: 'QA', OMN: 'OM', SAU: 'SA', KWT: 'KW', BHR: 'BH', TUR: 'TR', IDN: 'ID', VNM: 'VN', HKG: 'HK', MDV: 'MV',
};
export const iso3to2 = (c) => ISO3_TO_ISO2[String(c).replace(/</g, '')] || String(c).replace(/</g, '').slice(0, 2);

const charValue = (ch) => {
  if (ch === '<') return 0;
  if (/[0-9]/.test(ch)) return ch.charCodeAt(0) - 48;
  if (/[A-Z]/.test(ch)) return ch.charCodeAt(0) - 55;
  return NaN;
};

export function checkDigit(str) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum += charValue(str[i]) * weights[i % 3];
  return String(sum % 10);
}

function mrzDate(yymmdd, kind) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = +yymmdd.slice(0, 2);
  const nowYY = new Date().getUTCFullYear() % 100;
  // Expiry dates are always in the 2000s; birth dates in the future belong to the 1900s.
  const century = kind === 'expiry' ? 2000 : yy > nowYY ? 1900 : 2000;
  return `${century + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

const clean = (line) => String(line || '').toUpperCase().replace(/[\s]/g, '').replace(/[«‹]/g, '<');

/** Find two consecutive 44-char MRZ lines in free text. */
export function findMrzLines(text) {
  const candidates = String(text || '')
    .split(/\r?\n/)
    .map(clean)
    .filter((l) => /^[A-Z0-9<]{40,46}$/.test(l));
  for (let i = 0; i < candidates.length - 1; i++) {
    if (/^[PV][A-Z<]/.test(candidates[i])) return [candidates[i].padEnd(44, '<').slice(0, 44), candidates[i + 1].padEnd(44, '<').slice(0, 44)];
  }
  return null;
}

function parseNames(field) {
  const [surname, given = ''] = field.split('<<');
  return {
    surname: surname.replace(/</g, ' ').trim(),
    given_names: given.replace(/</g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Parse a TD3 passport or MRV-A visa MRZ.
 * @returns {object|null} fields + `checks` (per check digit) + `valid` (all digits OK)
 */
export function parseMrz(line1, line2) {
  const l1 = clean(line1).padEnd(44, '<');
  const l2 = clean(line2).padEnd(44, '<');
  const kind = l1[0] === 'P' ? 'passport' : l1[0] === 'V' ? 'visa' : null;
  if (!kind) return null;

  const issuing = iso3to2(l1.slice(2, 5));
  const names = parseNames(l1.slice(5));
  const number = l2.slice(0, 9).replace(/</g, '');
  const nationality = iso3to2(l2.slice(10, 13));
  const dob = mrzDate(l2.slice(13, 19), 'birth');
  const sex = l2[20] === '<' ? 'X' : l2[20];
  const expiry = mrzDate(l2.slice(21, 27), 'expiry');

  const checks = {
    number: checkDigit(l2.slice(0, 9)) === l2[9],
    date_of_birth: checkDigit(l2.slice(13, 19)) === l2[19],
    expiry_date: checkDigit(l2.slice(21, 27)) === l2[27],
  };
  if (kind === 'passport') {
    const personal = l2.slice(28, 42);
    checks.personal_number = personal.replace(/</g, '') === '' ? l2[42] === '<' || l2[42] === '0' : checkDigit(personal) === l2[42];
    const composite = l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43);
    checks.composite = checkDigit(composite) === l2[43];
  }
  return {
    kind, issuing_country: issuing, ...names, number, nationality, date_of_birth: dob, sex, expiry_date: expiry,
    checks, valid: Object.values(checks).every(Boolean), line1: l1, line2: l2,
  };
}

const toIso3 = (cc) => Object.entries(ISO3_TO_ISO2).find(([k, v]) => v === cc && k.length === 3)?.[0] || cc.padEnd(3, '<');
const field = (s, len) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '<').padEnd(len, '<').slice(0, len);
const yymmdd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

/** Build a valid MRZ (used to generate sample documents for the offline demo). */
export function buildMrz({ kind = 'passport', issuing, surname, given_names, number, nationality, date_of_birth, sex, expiry_date }) {
  const names = field(`${surname.replace(/ /g, '<')}<<${given_names.replace(/ /g, '<')}`, 39);
  const l1 = `${kind === 'passport' ? 'P<' : 'V<'}${toIso3(issuing)}${names}`;
  const num = field(number, 9);
  const dob = yymmdd(date_of_birth);
  const exp = yymmdd(expiry_date);
  let l2 = `${num}${checkDigit(num)}${toIso3(nationality)}${dob}${checkDigit(dob)}${sex}${exp}${checkDigit(exp)}`;
  if (kind === 'passport') {
    const personal = '<'.repeat(14);
    l2 += `${personal}<`;
    const composite = l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43);
    l2 += checkDigit(composite);
  } else {
    l2 = l2.padEnd(44, '<');
  }
  return [l1, l2];
}
