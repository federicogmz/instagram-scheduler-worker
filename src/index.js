// instagram-scheduler-worker — schedule Instagram posts (image, carousel, reel) from a queue in Cloudflare D1.
// Admin endpoints are authenticated with the `x-secret` header (PUBLISH_SECRET). Never put the secret in a URL.
//
//   GET    /status                 public, counts only
//   GET    /media/<path>           public: Instagram has to be able to download the files
//   POST   /media?name=<path>      upload a JPEG or MP4 to R2          (auth)
//   GET    /queue[?status=…]       list posts                          (auth)
//   POST   /queue                  schedule a post                     (auth)
//   GET    /queue/<id>             one post                            (auth)
//   DELETE /queue/<id>             cancel                              (auth)
//   POST   /queue/<id>/retry       re-queue a failed/cancelled post; optional body {scheduled_local|scheduled_utc}   (auth)
//   POST   /publish?post=<id>[&dry_run=1]   publish now / test only    (auth)
//   POST   /notify-test            send a test notification            (auth)

import { ensureSchema, nowIso, updatePost } from './db.js';
import { parseAccounts } from './meta.js';
import { msg } from './messages.js';
import { notify } from './notify.js';
import { MAX_LATE_MS, advance, claim, runCycle } from './publisher.js';
import { formatLocal, isValidTimeZone } from './time.js';
import { parseSchedule, validatePost } from './validate.js';

const MAX_UPLOAD = 95 * 1024 * 1024; // a Worker request body is capped at 100 MB
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' };
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isMp4 = (b) => b.length > 12 && String.fromCharCode(b[4], b[5], b[6], b[7]) === 'ftyp';
const validName = (n) => /^[a-z0-9][a-z0-9._/-]{2,120}\.(jpe?g|mp4)$/i.test(n) && !n.includes('..') && !n.includes('//');

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const timezone = (env) => env.TIMEZONE || 'UTC';

/** Constant-time comparison (hash both sides so lengths do not leak). */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = (await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])).map((h) => new Uint8Array(h));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function authorized(request, env) {
  const given = request.headers.get('x-secret') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!env.PUBLISH_SECRET && !!given && safeEqual(given, env.PUBLISH_SECRET);
}

const view = (env, p) => ({
  id: p.id, account: p.account, title: p.title, type: p.type, status: p.status, attempts: p.attempts,
  scheduled_local: formatLocal(p.scheduled_utc, timezone(env)), scheduled_utc: p.scheduled_utc, permalink: p.permalink, error: p.error,
});

async function serveMedia(env, request, key) {
  const isHead = request.method === 'HEAD';
  const range = request.headers.get('range');
  const obj = await env.MEDIA.get(key, range ? { range: request.headers } : undefined);
  if (!obj) return json({ error: 'Not found' }, 404);
  const ext = key.split('.').pop().toLowerCase();
  const h = new Headers({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', ETag: obj.httpEtag });
  if (obj.range && range) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    h.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set('Content-Length', String(length));
    return new Response(isHead ? null : obj.body, { status: 206, headers: h });
  }
  h.set('Content-Length', String(obj.size));
  return new Response(isHead ? null : obj.body, { status: 200, headers: h });
}

/** Checks that a media URL answers with the right content type — what Instagram will ask for. Returns an error string or null. */
function urlChecker(env, origin) {
  return async (url, type) => {
    const expected = type === 'reel' ? 'video/mp4' : 'image/jpeg';
    try {
      // A Worker cannot fetch its own public URL, so files we host are checked directly in R2.
      if (url.startsWith(`${origin}/media/`)) {
        const o = await env.MEDIA.head(decodeURIComponent(url.slice(origin.length + 7)));
        const ct = o?.httpMetadata?.contentType;
        return !o ? `${url} → not found in storage` : ct !== expected ? `${url} → ${ct} (expected ${expected})` : null;
      }
      const r = await fetch(url, { headers: { Range: 'bytes=0-15' } });
      const ct = (r.headers.get('content-type') || '').split(';')[0];
      if (![200, 206].includes(r.status)) return `${url} → HTTP ${r.status}`;
      return ct !== expected ? `${url} → ${ct || 'no content type'} (expected ${expected})` : null;
    } catch (e) { return `${url} → ${String(e).slice(0, 80)}`; }
  };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!isValidTimeZone(timezone(env))) return json({ error: `TIMEZONE "${timezone(env)}" is not a valid IANA time zone` }, 500);
  await ensureSchema(env.DB);

  if (path.startsWith('/media/') && ['GET', 'HEAD'].includes(request.method)) return serveMedia(env, request, decodeURIComponent(path.slice(7)));

  if (path === '/' || path === '/status') {
    const rows = (await env.DB.prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status').all()).results ?? [];
    return json({ service: 'instagram-scheduler-worker', time_utc: nowIso(), by_status: Object.fromEntries(rows.map((r) => [r.status, r.n])) });
  }

  if (!(await authorized(request, env))) return json({ error: 'Unauthorized' }, 401);

  if (path === '/media' && request.method === 'POST') {
    const name = (url.searchParams.get('name') || '').trim();
    if (!validName(name)) return json({ error: 'name: path/file.jpg|jpeg|mp4 (lowercase letters, digits, . _ - /)' }, 400);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_UPLOAD) return json({ error: `invalid size (max ${MAX_UPLOAD} bytes)` }, 413);
    const ext = name.split('.').pop().toLowerCase();
    if (MIME[ext] === 'image/jpeg' ? !isJpeg(bytes) : !isMp4(bytes)) return json({ error: `content is not a valid ${MIME[ext]}` }, 415);
    if (!url.searchParams.get('overwrite') && (await env.MEDIA.head(name))) return json({ error: 'already exists; pass overwrite=1 to replace it' }, 409);
    await env.MEDIA.put(name, bytes, { httpMetadata: { contentType: MIME[ext] } });
    return json({ ok: true, url: `${url.origin}/media/${name}`, bytes: bytes.length });
  }

  if (path === '/queue' && request.method === 'GET') {
    const status = url.searchParams.get('status');
    const q = status
      ? env.DB.prepare('SELECT * FROM posts WHERE status = ? ORDER BY scheduled_utc').bind(status)
      : env.DB.prepare('SELECT * FROM posts ORDER BY scheduled_utc DESC LIMIT 60');
    return json({ ok: true, posts: ((await q.all()).results ?? []).map((p) => view(env, p)) });
  }

  if (path === '/queue' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { errors, value } = await validatePost(body, { accounts: parseAccounts(env), timezone: timezone(env), checkUrl: urlChecker(env, url.origin) });
    if (errors.length) return json({ ok: false, errors }, 400);
    if (await env.DB.prepare('SELECT 1 FROM posts WHERE id = ?').bind(value.id).first()) return json({ ok: false, errors: [`a post with id ${value.id} already exists`] }, 409);
    const t = nowIso();
    await env.DB.prepare("INSERT INTO posts (id, account, title, type, media_json, caption, collaborators_json, scheduled_utc, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .bind(value.id, body.account, value.title, body.type, JSON.stringify(value.media), value.caption, value.collaborators.length ? JSON.stringify(value.collaborators) : null, value.scheduled.toISOString(), t, t).run();
    return json({ ok: true, id: value.id, scheduled_local: formatLocal(value.scheduled.toISOString(), timezone(env)), timezone: timezone(env) }, 201);
  }

  const m = path.match(/^\/queue\/([^/]+)(?:\/(retry))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const p = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    if (!p) return json({ error: 'Not found' }, 404);
    if (request.method === 'GET') return json({ ok: true, post: { ...view(env, p), caption: p.caption, media: JSON.parse(p.media_json), creation_id: p.creation_id } });
    if (request.method === 'DELETE') {
      if (!['pending', 'processing', 'failed'].includes(p.status)) return json({ error: `cannot cancel a ${p.status} post` }, 409);
      await updatePost(env, id, { status: 'cancelled', lock_until: null });
      return json({ ok: true, id, status: 'cancelled' });
    }
    if (request.method === 'POST' && m[2] === 'retry') {
      if (!['failed', 'cancelled'].includes(p.status)) return json({ error: `the post is ${p.status}` }, 409);
      if (p.media_id) return json({ error: 'it already has a media_id: it was published' }, 409);
      // Optional body { scheduled_local | scheduled_utc } picks a new time. Without it, a post that is already too late to go out
      // on its own is rescheduled for "now"; otherwise it keeps its time.
      const body = await request.json().catch(() => ({}));
      let when = null;
      if (body.scheduled_local || body.scheduled_utc) {
        const r = parseSchedule(body, timezone(env));
        if (r.error) return json({ ok: false, errors: [r.error] }, 400);
        when = r.date;
      } else if (Date.parse(p.scheduled_utc) < Date.now() - MAX_LATE_MS) {
        when = new Date();
      }
      // creation_id is kept on purpose: if the post did go out, the retry detects PUBLISHED instead of posting again
      await updatePost(env, id, { status: 'pending', attempts: 0, error: null, next_attempt_utc: null, lock_until: null, ...(when ? { scheduled_utc: when.toISOString() } : {}) });
      return json({ ok: true, id, status: 'pending' });
    }
  }

  if (path === '/publish' && request.method === 'POST') {
    const p = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(url.searchParams.get('post') || '').first();
    if (!p) return json({ error: 'Post not found' }, 404);
    if (url.searchParams.get('dry_run')) return json(await advance(env, p, { dryRun: true }));
    if (!['pending', 'processing'].includes(p.status)) return json({ error: `the post is ${p.status}` }, 409);
    if (!(await claim(env, p.id))) return json({ error: 'another run is publishing it; try again in a few minutes' }, 409);
    return json(await advance(env, p));
  }

  if (path === '/notify-test' && request.method === 'POST') {
    await notify(env, msg(env).test());
    return json({ ok: true });
  }

  return json({ error: 'Route not found' }, 404);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); } catch (err) {
      console.error('fetch', new URL(request.url).pathname, err);
      return json({ error: String(err.message || err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env).then((r) => console.log('[cron]', JSON.stringify(r))).catch((e) => console.error('[cron] error', e)));
  },
};
