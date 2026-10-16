// Preflight app server: agent dashboard + JSON API + Flyo/Twilio webhooks.
// SECURITY: the dashboard has no login. It binds to 127.0.0.1 by default; do not expose it publicly as-is.
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { config, ROOT } from '../shared/env.mjs';
import { createRouter, sendJson, sendText, readJson, readBody, serveStatic, HttpError } from '../shared/http.mjs';
import { bus, listBookings, getBooking, deleteBooking, readStoredFile, findBookingByPhone } from './store.mjs';
import {
  ingestTicket, handleTravellerMessage, handleFlyoWebhook, startPolling,
  agentUpdatePassenger, agentOverride, agentRetrySubscribe, agentRefresh, resolveAlert,
} from './orchestrator.mjs';
import { listTicketSamples, ticketSample, listDocSamples, docSampleSvg } from './samples/samples.mjs';
import { llmLabel } from './extract/llm.mjs';
import { messagingMode, verifyTwilioSignature, fetchTwilioMedia } from './messaging.mjs';
import { RULES_AS_OF } from './readiness/travelRules.mjs';

const PUBLIC_DIR = path.join(ROOT, 'public');
const ALLOWED_UPLOADS = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'text/plain']);
const MAX_UPLOAD = 15 * 1024 * 1024;

function decodeUpload(f) {
  if (!f) return undefined;
  const mime = String(f.mime || '').toLowerCase();
  if (!ALLOWED_UPLOADS.has(mime)) throw new HttpError(415, { error: `Unsupported file type ${mime || '(unknown)'}. Use PDF, PNG, JPEG, WEBP or HEIC.` });
  const data = Buffer.from(String(f.base64 || ''), 'base64');
  if (!data.length) throw new HttpError(400, { error: 'Empty file' });
  if (data.length > MAX_UPLOAD) throw new HttpError(413, { error: 'File too large (max 15 MB)' });
  return { data, mime, name: String(f.name || 'upload').slice(0, 120) };
}

const need = (b) => { if (!b) throw new HttpError(404, { error: 'Booking not found' }); return b; };
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

const router = createRouter();

// ---------------------------------------------------------------- meta + bookings
router.add('GET', '/api/meta', (_req, res) => sendJson(res, 200, {
  flyo: { baseUrl: config.flyo.baseUrl, mock: /127\.0\.0\.1|localhost/.test(config.flyo.baseUrl) },
  llm: llmLabel(), messaging: messagingMode(), rulesAsOf: RULES_AS_OF, samples: listTicketSamples(),
}));
router.add('GET', '/api/bookings', (_req, res) => sendJson(res, 200, { bookings: listBookings() }));
router.add('GET', '/api/bookings/:id', (_req, res, p) => sendJson(res, 200, need(getBooking(p.id))));
router.add('DELETE', '/api/bookings/:id', (_req, res, p) => { need(getBooking(p.id)); deleteBooking(p.id); sendJson(res, 200, { ok: true }); });

router.add('POST', '/api/ingest', async (req, res) => {
  const body = await readJson(req);
  let file;
  let contact = body.contact || {};
  let sourceKind;
  if (body.sample) {
    const s = ticketSample(body.sample);
    if (!s) throw new HttpError(404, { error: 'Unknown sample' });
    file = { data: s.pdf, mime: 'application/pdf', name: s.filename };
    contact = { ...s.contact, ...Object.fromEntries(Object.entries(contact).filter(([, v]) => v)) };
    sourceKind = 'sample pdf';
  } else {
    file = decodeUpload(body.file);
  }
  if (!file && !String(body.text || '').trim()) throw new HttpError(400, { error: 'Provide a ticket file or pasted text' });
  try {
    const created = await ingestTicket({ file, text: body.text, contact, sourceKind });
    sendJson(res, 200, { ok: true, bookings: created.map((b) => b.id) });
  } catch (e) {
    throw new HttpError(e.status || 422, { error: e.message });
  }
});

router.add('POST', '/api/bookings/:id/chat', async (req, res, p) => {
  need(getBooking(p.id));
  const body = await readJson(req);
  let file = decodeUpload(body.file);
  if (body.sampleDoc) {
    const svg = docSampleSvg(body.sampleDoc);
    if (!svg) throw new HttpError(404, { error: 'Unknown sample document' });
    file = { data: Buffer.from(svg), mime: 'image/svg+xml', name: `${body.sampleDoc}.svg` };
  }
  if (!file && !String(body.text || '').trim()) throw new HttpError(400, { error: 'Empty message' });
  await handleTravellerMessage(p.id, { text: body.text, file });
  sendJson(res, 200, { ok: true });
});

router.add('POST', '/api/bookings/:id/passengers/:pi', async (req, res, p) => {
  const b = await agentUpdatePassenger(p.id, Number(p.pi), await readJson(req));
  sendJson(res, 200, b);
});
router.add('POST', '/api/bookings/:id/override', async (req, res, p) => sendJson(res, 200, await agentOverride(p.id, (await readJson(req)).on)));
router.add('POST', '/api/bookings/:id/retry', async (_req, res, p) => sendJson(res, 200, await agentRetrySubscribe(p.id)));
router.add('POST', '/api/bookings/:id/refresh', async (_req, res, p) => sendJson(res, 200, await agentRefresh(p.id)));
router.add('POST', '/api/bookings/:id/alerts/:aid/resolve', (_req, res, p) => sendJson(res, 200, resolveAlert(p.id, p.aid)));

// ---------------------------------------------------------------- files + samples
router.add('GET', '/api/files/:id', async (_req, res, p) => {
  const f = await readStoredFile(p.id);
  if (!f) throw new HttpError(404, { error: 'File not found' });
  // Uploaded content is untrusted: sandbox it so an SVG/HTML upload can't run script on this origin.
  res.writeHead(200, {
    'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `inline; filename="${f.name.replace(/[^\w.-]/g, '_')}"`,
  });
  res.end(f.data);
});
router.add('GET', '/api/samples/tickets', (_req, res) => sendJson(res, 200, { samples: listTicketSamples() }));
router.add('GET', '/api/samples/tickets/:file', (_req, res, p) => {
  const id = p.file.replace(/\.(pdf|txt)$/, '');
  const s = ticketSample(id);
  if (!s) throw new HttpError(404, { error: 'Unknown sample' });
  if (p.file.endsWith('.txt')) return sendText(res, 200, s.text);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${s.filename}"` });
  res.end(s.pdf);
});
router.add('GET', '/api/samples/docs', (_req, res, _p, url) => {
  const b = url.searchParams.get('booking') && getBooking(url.searchParams.get('booking'));
  sendJson(res, 200, { docs: listDocSamples(b ? b.passengers.map((x) => x.last_name) : []) });
});
router.add('GET', '/api/samples/docs/:file', (_req, res, p) => {
  const svg = docSampleSvg(p.file.replace(/\.svg$/, ''));
  if (!svg) throw new HttpError(404, { error: 'Unknown sample document' });
  sendText(res, 200, svg, 'image/svg+xml; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
});

// ---------------------------------------------------------------- live updates (SSE)
router.add('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const onChange = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on('change', onChange);
  req.on('close', () => { clearInterval(ping); bus.off('change', onChange); });
});

// ---------------------------------------------------------------- webhooks
router.add('POST', '/webhooks/flyo', async (req, res) => {
  // Flyo adds no body signature; it sends back the auth_header we registered in callbackData.
  if (!safeEqual(req.headers.authorization || '', `Bearer ${config.flyo.webhookSecret}`)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  const event = await readJson(req);
  sendJson(res, 200, { received: true }); // acknowledge fast (Flyo expects 2xx within 10s)
  handleFlyoWebhook(event).catch((e) => console.error('[preflight] webhook processing failed', e));
});

router.add('POST', '/webhooks/twilio', async (req, res) => {
  const params = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
  if (!verifyTwilioSignature(`${config.app.publicUrl}/webhooks/twilio`, params, req.headers['x-twilio-signature'])) {
    return sendText(res, 403, 'invalid signature');
  }
  sendText(res, 200, '<Response></Response>', 'text/xml');
  const b = findBookingByPhone(String(params.From || '').replace('whatsapp:', ''));
  if (!b) return console.warn('[preflight] WhatsApp message from unknown number');
  let file;
  if (Number(params.NumMedia) > 0 && params.MediaUrl0) {
    try {
      const m = await fetchTwilioMedia(params.MediaUrl0);
      file = { ...m, name: `whatsapp-${Date.now()}` };
    } catch (e) { console.error('[preflight] media download failed', e.message); }
  }
  handleTravellerMessage(b.id, { text: params.Body || '', file }).catch((e) => console.error('[preflight] inbound failed', e));
});

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    const m = router.match(req.method, url.pathname);
    if (m) return await m.handler(req, res, m.params, url);
    if (req.method === 'GET' && (await serveStatic(res, PUBLIC_DIR, url.pathname))) return;
    throw new HttpError(404, { error: 'Not found' });
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.body?.error || err.message, ...err.body });
    console.error('[preflight]', err);
    sendJson(res, 500, { error: err.message || 'Internal error' });
  }
});

server.listen(config.app.port, config.app.host, () => {
  console.log(`[preflight] dashboard on http://${config.app.host}:${config.app.port}  (Flyo: ${config.flyo.baseUrl}, LLM: ${llmLabel()}, messaging: ${messagingMode()})`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.app.host)) {
    console.warn('[preflight] WARNING: dashboard has no authentication and is bound to a non-loopback address.');
  }
  startPolling();
});
