// Passport / visa extraction from a traveller's photo, PDF or typed text.
// The MRZ is the source of truth wherever available: it carries ICAO check digits, so a misread
// digit is detected instead of silently sent to the airline.
import { findMrzLines, parseMrz, iso3to2 } from '../readiness/mrz.mjs';
import { llmEnabled, llmJson } from './llm.mjs';

const DOC_SYSTEM = `You read travel documents (passport data pages and visas) photographed by travellers.
Return JSON: {"kind": "passport"|"visa"|"other", "surname": string|null, "given_names": string|null, "number": string|null,
"nationality": string|null, "issuing_country": string|null, "date_of_birth": string|null, "sex": "M"|"F"|"X"|null,
"date_of_issue": string|null, "expiry_date": string|null, "place_of_issue": string|null, "visa_type": string|null,
"valid_from": string|null, "mrz_line1": string|null, "mrz_line2": string|null, "legible": boolean, "notes": string|null}
Rules: dates as YYYY-MM-DD; countries as ISO 3166-1 alpha-2 (IN, GB, US); copy MRZ lines exactly, using < for fillers,
44 characters each; for a visa, "number" is the visa/vignette number and "expiry_date" is the "valid until" date;
for Indian passports "place_of_issue" is printed on the data page (e.g. HYDERABAD). Never guess unreadable characters; use null.`;

const dmy = (s) => {
  const m = String(s || '').match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

const svgToText = (svg) =>
  [...String(svg).matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim())
    .join('\n');

function fromText(text, source) {
  const lines = findMrzLines(text);
  if (!lines) return null;
  const mrz = parseMrz(...lines);
  if (!mrz) return null;
  const issueDate = dmy((text.match(/Date of Issue[^\d]{0,20}([\d/.-]{8,10})/i) || [])[1]);
  const place = (text.match(/Place of Issue\s*[:\n]\s*([A-Za-z][A-Za-z .,-]{1,40})/i) || [])[1]?.trim().toUpperCase() || null;
  const validFrom = dmy((text.match(/Valid From[^\d]{0,20}([\d/.-]{8,10})/i) || [])[1]);
  const visaType = (text.match(/Type of Visa\s*[:\n]\s*([A-Za-z0-9][A-Za-z0-9 /-]{0,40})/i) || [])[1]?.trim() || null;
  return toResult(mrz, { date_of_issue: issueDate, place_of_issue: place, valid_from: validFrom, visa_type: visaType }, source);
}

function toResult(mrz, extra, source) {
  if (mrz.kind === 'passport') {
    return {
      kind: 'passport', source,
      surname: mrz.surname, given_names: mrz.given_names, number: mrz.number, nationality: mrz.nationality,
      issuing_country: mrz.issuing_country, date_of_birth: mrz.date_of_birth, sex: mrz.sex, expiry_date: mrz.expiry_date,
      date_of_issue: extra.date_of_issue || null, place_of_issue: extra.place_of_issue || null,
      mrz_valid: mrz.valid, mrz_checks: mrz.checks,
    };
  }
  return {
    kind: 'visa', source,
    surname: mrz.surname, given_names: mrz.given_names, document_number: mrz.number, nationality: mrz.nationality,
    issuing_country: mrz.issuing_country, expiry_date: mrz.expiry_date, valid_from: extra.valid_from || null,
    visa_type: extra.visa_type || null, mrz_valid: mrz.valid, mrz_checks: mrz.checks,
  };
}

/**
 * @param {{ text?: string, file?: { data: Buffer, mime: string, name?: string } }} input
 * @returns {Promise<object>} { kind: 'passport'|'visa'|'unknown', ... }
 */
export async function extractDocument({ text, file }) {
  if (text) {
    const r = fromText(text, 'typed MRZ');
    if (r) return r;
  }
  if (file?.mime === 'image/svg+xml') {
    const r = fromText(svgToText(file.data.toString('utf8')), 'sample document (SVG text layer)');
    if (r) return r;
  }
  if (file && llmEnabled() && (file.mime.startsWith('image/') && file.mime !== 'image/svg+xml' || file.mime === 'application/pdf')) {
    const out = await llmJson({ system: DOC_SYSTEM, prompt: 'Read this travel document.', files: [file] });
    if (out.mrz_line1 && out.mrz_line2) {
      const mrz = parseMrz(out.mrz_line1, out.mrz_line2);
      if (mrz) {
        const r = toResult(mrz, out, 'vision LLM + MRZ');
        // Prefer MRZ for fields it carries; fall back to the visual zone where the MRZ is silent.
        return r;
      }
    }
    if (out.kind === 'passport' || out.kind === 'visa') {
      const cc = (v) => (v && v.length === 3 ? iso3to2(v) : v);
      return out.kind === 'passport'
        ? { kind: 'passport', source: 'vision LLM (no MRZ)', surname: out.surname, given_names: out.given_names, number: out.number, nationality: cc(out.nationality), issuing_country: cc(out.issuing_country), date_of_birth: out.date_of_birth, sex: out.sex, expiry_date: out.expiry_date, date_of_issue: out.date_of_issue, place_of_issue: out.place_of_issue, mrz_valid: null }
        : { kind: 'visa', source: 'vision LLM (no MRZ)', surname: out.surname, given_names: out.given_names, document_number: out.number, issuing_country: cc(out.issuing_country), expiry_date: out.expiry_date, valid_from: out.valid_from, visa_type: out.visa_type, mrz_valid: null };
    }
    return { kind: 'unknown', reason: out.notes || 'Not recognised as a passport or visa' };
  }
  return {
    kind: 'unknown',
    reason: llmEnabled() ? 'Could not read the document' : 'Photo reading needs a vision LLM (LLM_PROVIDER/LLM_API_KEY). The agent can enter the details manually.',
  };
}
