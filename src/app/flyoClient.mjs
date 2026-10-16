// Flyo partner Web Check-in API client, written against https://www.flyo.ai/en/api-docs.
// Encodes the documented integration rules:
//  - flight times are origin/destination local wall clock, sent without offset suffix
//  - passengers updates are FULL replacements (never partial); files are re-attached because
//    the API does not return the storage URLs it creates
//  - never resubscribe in a loop; after a 500/timeout on a mutation, reconcile via status/requests
//  - 429: wait retryAfter seconds; 409 NOT_UPDATABLE: stop and read status
import { config } from '../shared/env.mjs';

const PREFIX = '/extPartner/api/webcheckin';

export class FlyoError extends Error {
  constructor(status, body, { uncertain = false } = {}) {
    super(body?.message || body?.error || `Flyo HTTP ${status}`);
    this.status = status;
    this.body = body || {};
    this.code = body?.error || null;
    this.reason = body?.reason_code || null;
    this.uncertain = uncertain; // true if the mutation may or may not have been applied
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip local-only fields so we send exactly the documented Flyo passenger shape. */
export function toFlyoPassenger(p, filesOut) {
  const out = {
    first_name: p.first_name,
    last_name: p.last_name,
    email: p.email || null,
    country_code: p.country_code || null,
    phone: p.phone || null,
    date_of_birth: p.date_of_birth || p.passport?.date_of_birth || null,
    nationality: p.nationality || p.passport?.nationality || null,
    country_of_residence: p.country_of_residence || null,
    passport: p.passport
      ? {
        number: p.passport.number || null,
        date_of_issue: p.passport.date_of_issue || null,
        expiry_date: p.passport.expiry_date || null,
        place_of_issue: p.passport.place_of_issue || null,
        nationality: p.passport.nationality || null,
      }
      : null,
    documents: (p.documents || []).length
      ? p.documents.map((d) => ({
        type: d.type,
        document_number: d.document_number || null,
        issuing_country: d.issuing_country === 'SCHENGEN' ? null : d.issuing_country || null,
        expiry_date: d.expiry_date || null,
      }))
      : null,
    seat_preference: p.seat_preference || null,
  };
  if (filesOut && p.passport?.fileId) {
    const field = `passport_${filesOut.length}`;
    filesOut.push({ field, fileId: p.passport.fileId });
    out.passport.file_field = field;
  }
  if (filesOut) {
    (p.documents || []).forEach((d, j) => {
      if (!d.fileId) return;
      const field = `doc_${filesOut.length}`;
      filesOut.push({ field, fileId: d.fileId });
      out.documents[j].file_field = field;
    });
  }
  return out;
}

export function toFlyoFlights(legs) {
  return legs.map((l) => ({
    airline: l.airline,
    flight_number: l.flight_number,
    origin: l.origin,
    destination: l.destination,
    departure_datetime: l.departure_datetime, // local wall clock, no suffix
    arrival_datetime: l.arrival_datetime || null,
  }));
}

export function createFlyoClient({ onCall } = {}) {
  const { baseUrl, apiKey } = config.flyo;

  async function call(method, path, { query, json, form, idempotent = method === 'GET', context } = {}) {
    const url = new URL(baseUrl + PREFIX + path);
    Object.entries(query || {}).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now();
      let res;
      let body;
      try {
        res = await fetch(url, {
          method,
          headers: { 'X-API-Key': apiKey, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) },
          body: json ? JSON.stringify(json) : form || undefined, // FormData sets its own multipart boundary
          signal: AbortSignal.timeout(20_000),
        });
        body = await res.json().catch(() => ({}));
      } catch (err) {
        onCall?.({ context, method, path: url.pathname + url.search, status: 'ERR', ms: Date.now() - started, request: json || describeForm(form), response: { error: err.message } });
        if (idempotent && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new FlyoError(0, { error: 'NETWORK', message: err.message }, { uncertain: !idempotent });
      }
      onCall?.({ context, method, path: url.pathname + url.search, status: res.status, ms: Date.now() - started, request: json || describeForm(form), response: body });
      if (res.status === 429 && attempt < 2) {
        // 429 means the request was not processed, so retrying a mutation is safe.
        await sleep(Math.min(60, Number(body.retryAfter) || Number(res.headers.get('retry-after')) || 2) * 1000);
        continue;
      }
      if (!res.ok) throw new FlyoError(res.status, body, { uncertain: res.status >= 500 && !idempotent });
      return body;
    }
    throw new FlyoError(429, { error: 'RATE_LIMITED', message: 'Rate limited after retries' });
  }

  return {
    subscribe: ({ pnr, legs, passengers, callbackUrl, context }) =>
      call('POST', '/subscribe', {
        context,
        json: {
          pnr: pnr || undefined,
          flights: toFlyoFlights(legs),
          passengers: passengers.map((p) => toFlyoPassenger(p)),
          callbackData: callbackUrl
            ? { clientName: 'Preflight demo', callbackUrl, auth_header: `Authorization: Bearer ${config.flyo.webhookSecret}` }
            : undefined,
        },
      }),

    /** Full passenger replacement; attaches stored files with matching file_field names. */
    updatePassengers: async ({ checkinId, passengers, loadFile, context }) => {
      const files = [];
      const payload = passengers.map((p) => toFlyoPassenger(p, files));
      if (!files.length) {
        return call('POST', '/update', { context, json: { checkin_id: checkinId, type: 'passengers', operation: 'update', passengers: payload } });
      }
      const form = new FormData();
      form.set('checkin_id', checkinId);
      form.set('type', 'passengers');
      form.set('operation', 'update');
      form.set('passengers', JSON.stringify(payload));
      for (const f of files) {
        const stored = await loadFile(f.fileId);
        if (!stored) throw new Error(`Stored file ${f.fileId} is missing`);
        const mime = stored.mime === 'image/svg+xml' ? 'image/svg+xml' : stored.mime;
        form.set(f.field, new Blob([stored.data], { type: mime }), stored.name);
      }
      return call('POST', '/update', { context, form });
    },

    updatePnr: ({ checkinId, pnr, context }) =>
      call('POST', '/update', { context, json: { checkin_id: checkinId, type: 'pnr', payload: { pnr } } }),

    status: ({ checkinId, context }) => call('GET', '/status', { context, query: { checkin_id: checkinId } }),

    requests: ({ page = 0, limit = 25, status, context } = {}) =>
      call('GET', '/requests', { context, query: { page: Math.trunc(page), limit: Math.trunc(limit), status } }),
  };
}

function describeForm(form) {
  if (!form) return undefined;
  const out = { _multipart: true };
  for (const [k, v] of form.entries()) {
    out[k] = typeof v === 'string' ? (k === 'passengers' ? JSON.parse(v) : v) : `<file ${v.type}, ${v.size} bytes>`;
  }
  return out;
}
