// Wall-clock <-> UTC helpers. Flyo flight timestamps are airport-local wall clock with any
// Z / numeric offset suffix ignored (never converted). Lifecycle timestamps are real UTC.

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?/;

/** Strip any offset suffix and normalise to YYYY-MM-DDTHH:mm:ss. Returns null if unparseable. */
export function normalizeWallClock(value) {
  const m = WALL_RE.exec(String(value || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  // Reject impossible calendar dates (e.g. 2026-02-30)
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || +h > 23 || +mi > 59) {
    return null;
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function tzOffsetMs(tz, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

/**
 * Convert an airport-local wall clock to a UTC Date.
 * Repeated local times (DST fall-back) resolve to the earlier occurrence, matching Flyo's rule.
 * Non-existent local times (DST spring-forward gap) return null.
 */
export function wallClockToUtc(wall, tz) {
  const norm = normalizeWallClock(wall);
  if (!norm || !tz) return null;
  const m = WALL_RE.exec(norm);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const candidates = new Set();
  for (const probe of [naive - 36e5 * 14, naive, naive + 36e5 * 14]) {
    candidates.add(naive - tzOffsetMs(tz, probe));
  }
  const valid = [...candidates].filter((utc) => utc + tzOffsetMs(tz, utc) === naive).sort((a, b) => a - b);
  return valid.length ? new Date(valid[0]) : null;
}

/** Format a UTC Date as local wall clock in tz (YYYY-MM-DDTHH:mm:ss). */
export function utcToWallClock(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export const addMonths = (dateStr, months) => {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};

export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
export const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 36e5;
