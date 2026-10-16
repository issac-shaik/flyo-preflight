// Tiny HTTP helpers on top of node:http (no framework).
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_BODY_BYTES = 40 * 1024 * 1024; // ~30 files x 10 MiB is Flyo's cap; we stay well under for the demo

export class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = typeof body === 'string' ? { success: false, error: body } : body;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(text);
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, { success: false, error: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, { success: false, error: 'VALIDATION_ERROR', message: 'Invalid JSON body' });
  }
}

/** Parse multipart/form-data or urlencoded bodies with the WHATWG Request implementation built into Node. */
export async function readForm(req) {
  const buf = await readBody(req);
  const request = new Request('http://local/', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] || '' },
    body: buf,
  });
  return request.formData();
}

/** Minimal router: add(method, '/path/:param', handler). */
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => (keys.push(k), '/([^/]+)')) + '/?$',
    );
    routes.push({ method, regex, keys, handler });
  };
  const match = (method, pathname) => {
    for (const r of routes) {
      if (r.method !== method && r.method !== '*') continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return null;
  };
  return { add, match };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

/** Serve a file from rootDir; refuses path traversal. Returns false if not found. */
export async function serveStatic(res, rootDir, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const full = path.resolve(rootDir, rel);
  if (!full.startsWith(path.resolve(rootDir) + path.sep) && full !== path.resolve(rootDir)) return false;
  try {
    const s = await stat(full);
    if (!s.isFile()) return false;
    res.writeHead(200, { 'Content-Type': mimeFor(full), 'Cache-Control': 'no-cache' });
    res.end(await readFile(full));
    return true;
  } catch {
    return false;
  }
}
