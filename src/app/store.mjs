// JSON-file persistence + in-process change notifications (Server-Sent Events fan-out).
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../shared/env.mjs';

const DB_FILE = path.join(config.app.dataDir, 'app.json');
const FILES_DIR = path.join(config.app.dataDir, 'files');
mkdirSync(FILES_DIR, { recursive: true });

export const bus = new EventEmitter();
bus.setMaxListeners(100);

let db = { bookings: [], files: {}, seenEvents: [] };
if (existsSync(DB_FILE)) {
  try { db = { ...db, ...JSON.parse(readFileSync(DB_FILE, 'utf8')) }; } catch { /* corrupt file: start fresh */ }
}

let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const tmp = `${DB_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, DB_FILE);
  }, 50);
}

export const listBookings = () => db.bookings;
export const getBooking = (id) => db.bookings.find((b) => b.id === id) || null;
export const findBookingByCheckin = (checkinId) => db.bookings.find((b) => b.flyo?.checkin_id === checkinId) || null;
export const findBookingByPhone = (digits) =>
  [...db.bookings].reverse().find((b) => (b.contact?.phone || '').replace(/\D/g, '').endsWith(digits.replace(/\D/g, '').slice(-10))) || null;

export function insertBooking(b) {
  db.bookings.unshift(b);
  persist();
  bus.emit('change', { type: 'booking', id: b.id });
  return b;
}

/** Mutate a booking through fn and broadcast the change. */
export function touch(booking, fn) {
  if (fn) fn(booking);
  booking.updated_at = new Date().toISOString();
  persist();
  bus.emit('change', { type: 'booking', id: booking.id });
  return booking;
}

export function activity(booking, kind, text, extra = {}) {
  booking.activity.push({ at: new Date().toISOString(), kind, text, ...extra });
  if (booking.activity.length > 300) booking.activity.splice(0, booking.activity.length - 300);
  touch(booking);
}

/** Webhook event de-duplication (event_id), persisted across restarts. */
export function markEventSeen(eventId) {
  if (db.seenEvents.includes(eventId)) return false;
  db.seenEvents.push(eventId);
  if (db.seenEvents.length > 5000) db.seenEvents.splice(0, 1000);
  persist();
  return true;
}

const EXT = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/heic': '.heic', 'text/plain': '.txt' };

export async function saveFile({ data, mime, name }) {
  const id = randomUUID();
  const file = `${id}${EXT[mime] || ''}`;
  await writeFile(path.join(FILES_DIR, file), data);
  db.files[id] = { id, file, mime, name: name || file, size: data.length, created_at: new Date().toISOString() };
  persist();
  return db.files[id];
}

export const fileMeta = (id) => db.files[id] || null;
export async function readStoredFile(id) {
  const meta = db.files[id];
  if (!meta) return null;
  return { ...meta, data: await readFile(path.join(FILES_DIR, meta.file)) };
}

export function deleteBooking(id) {
  const i = db.bookings.findIndex((b) => b.id === id);
  if (i >= 0) db.bookings.splice(i, 1);
  persist();
  bus.emit('change', { type: 'deleted', id });
}
