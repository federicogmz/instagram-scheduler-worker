import { localToUtc } from './time.js';

export const TYPES = ['image', 'carousel', 'reel'];
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
const MAX_COLLABORATORS = 3;
const ID_RE = /^[a-z0-9][a-z0-9_-]{2,80}$/i;
// Instagram needs public https URLs; plain http is tolerated only for local development (`wrangler dev`).
const MEDIA_URL_RE = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/i;

/** Reads `scheduled_utc` (ISO 8601) or `scheduled_local` ("YYYY-MM-DD HH:MM" in `timezone`). Returns { date } or { error }. */
export function parseSchedule(b, timezone) {
  if (b.scheduled_utc) {
    const d = new Date(b.scheduled_utc);
    return Number.isNaN(d.getTime()) ? { error: 'scheduled_utc is not a valid date' } : { date: d };
  }
  if (b.scheduled_local) {
    const d = localToUtc(b.scheduled_local, timezone);
    return d ? { date: d } : { error: `scheduled_local: "YYYY-MM-DD HH:MM" in ${timezone}; that time is malformed or does not exist (DST gap)` };
  }
  return { error: 'schedule: give scheduled_local ("YYYY-MM-DD HH:MM") or scheduled_utc (ISO 8601)' };
}

/**
 * Validates a post submitted to POST /queue.
 * `checkUrl(url, type)` is injected so tests (and the Worker) decide how media URLs are verified; it returns an error string or null.
 * Returns { errors: string[], value } where value is the normalised post when errors is empty.
 */
export async function validatePost(body, { accounts, timezone, now = Date.now(), checkUrl }) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  const id = String(b.id || '').trim();
  if (!ID_RE.test(id)) errors.push('id: 3–80 characters (letters, digits, "_" and "-")');

  if (!Object.hasOwn(accounts, b.account)) errors.push(`account: one of ${Object.keys(accounts).join(' | ')}`);
  if (!TYPES.includes(b.type)) errors.push(`type: ${TYPES.join(' | ')}`);

  const media = Array.isArray(b.media) ? b.media.map(String) : [];
  if (b.type === 'carousel' ? !(media.length >= 2 && media.length <= 10) : media.length !== 1) {
    errors.push('media: carousel needs 2–10 URLs; image and reel need exactly 1');
  }
  for (const u of media) if (!MEDIA_URL_RE.test(u)) errors.push(`media: ${u} is not an https:// URL`);

  const caption = String(b.caption || '');
  if (!caption.trim()) errors.push('caption is empty');
  if (caption.length > MAX_CAPTION) errors.push(`caption has ${caption.length} characters (max ${MAX_CAPTION})`);
  if ((caption.match(/#\w+/g) || []).length > MAX_HASHTAGS) errors.push(`more than ${MAX_HASHTAGS} hashtags`);

  const { date: scheduled, error: scheduleError } = parseSchedule(b, timezone);
  if (scheduleError) errors.push(scheduleError);
  else if (scheduled.getTime() < now - 5 * 60e3) errors.push('the scheduled time is already in the past');

  const collaborators = Array.isArray(b.collaborators) ? b.collaborators.map(String) : [];
  if (collaborators.length > MAX_COLLABORATORS) errors.push(`collaborators: at most ${MAX_COLLABORATORS}`);

  if (!errors.length && checkUrl) {
    for (const u of media) { const problem = await checkUrl(u, b.type); if (problem) errors.push(problem); }
  }

  return { errors, value: errors.length ? null : { id, media, caption, scheduled, collaborators, title: String(b.title || id).slice(0, 120) } };
}
