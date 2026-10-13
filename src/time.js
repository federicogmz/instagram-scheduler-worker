// Time zone helpers built on Intl only (no dependencies). Posts are stored in UTC; humans schedule in local time.

const formatters = new Map();
const fmt = (tz) => {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
};

const parts = (ms, tz) => Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));

export function isValidTimeZone(tz) {
  try { fmt(tz); return true; } catch { return false; }
}

/** Offset of `tz` from UTC at the instant `ms`, in milliseconds (positive east of Greenwich). */
export function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** "2026-10-19 19:00" in `tz` for an ISO/UTC instant. */
export function formatLocal(iso, tz) {
  const p = parts(new Date(iso).getTime(), tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * Converts a wall-clock time ("YYYY-MM-DD HH:MM" or with "T") in `tz` to a UTC Date.
 * Returns null when the string is malformed or the local time does not exist (spring-forward gap).
 * Ambiguous times (fall-back overlap) resolve to the first occurrence.
 */
export function localToUtc(text, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (Number.isNaN(naive)) return null;
  let guess = naive - offsetMs(naive, tz);
  guess = naive - offsetMs(guess, tz); // second pass: the offset may differ across a DST boundary
  const out = new Date(guess);
  return formatLocal(out.toISOString(), tz) === `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` ? out : null;
}
