// The publishing state machine. Statuses: pending → processing → published | failed | cancelled.
//
// Guarantees:
//  · Never publishes twice. The container id (creation_id) is stored as soon as it exists; before every media_publish the container is
//    checked and, if Instagram already reports PUBLISHED, the post is just marked as published.
//  · A media_publish that fails ambiguously (network cut) KEEPS the container, so the retry can detect that it went out.
//    The container is only discarded when Instagram itself reports ERROR or EXPIRED.
//  · Overlapping cron runs cannot grab the same post: claim() is an atomic UPDATE with a short lock.
//  · Retries: up to MAX_ATTEMPTS with growing waits (10, 20, 30 min). A post more than MAX_LATE_MS overdue never goes out on its own.

import { ensureSchema, nowIso, updatePost } from './db.js';
import { containerStatus, createContainer, graphPost, pageToken, parseAccounts, permalinkOf, recentMedia, sleep } from './meta.js';
import { formatLocal } from './time.js';
import { msg } from './messages.js';
import { notify } from './notify.js';

export const MAX_ATTEMPTS = 4;
export const MAX_LATE_MS = 6 * 3600e3;
const LOCK_MS = 4 * 60e3;

const label = (env, post) => parseAccounts(env)[post.account]?.label || post.account;
const local = (env, iso) => formatLocal(iso, env.TIMEZONE || 'UTC');

/** Atomically takes the post for this run. False if another run holds it. */
export async function claim(env, id) {
  const now = nowIso();
  const until = new Date(Date.now() + LOCK_MS).toISOString();
  const r = await env.DB.prepare("UPDATE posts SET lock_until = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing') AND (lock_until IS NULL OR lock_until < ?)")
    .bind(until, now, id, now).run();
  return (r.meta?.changes ?? 0) === 1;
}

async function fail(env, post, err) {
  const attempts = post.attempts + 1;
  const message = String(err?.message || err).slice(0, 500);
  console.error(`[${post.id}] failure (${attempts}/${MAX_ATTEMPTS}):`, message);
  if (attempts >= MAX_ATTEMPTS) {
    await updatePost(env, post.id, { status: 'failed', attempts, error: message, lock_until: null });
    await notify(env, msg(env).gaveUp(post.title, label(env, post), local(env, post.scheduled_utc), attempts, message, post.id));
  } else {
    const next = new Date(Date.now() + attempts * 10 * 60e3).toISOString();
    await updatePost(env, post.id, {
      status: 'pending', attempts, error: message, next_attempt_utc: next, lock_until: null,
      // only throw the container away when Instagram says it is dead
      ...(err?.discardContainer ? { creation_id: null, items_json: null } : {}),
    });
    await notify(env, msg(env).willRetry(post.title, label(env, post), attempts, MAX_ATTEMPTS, local(env, next), message));
  }
}

async function markPublished(env, post, token, mediaId) {
  const permalink = await permalinkOf(env, mediaId, token);
  await updatePost(env, post.id, { status: 'published', media_id: mediaId, permalink, error: null, lock_until: null, published_at: nowIso() });
  await notify(env, msg(env).published(post.title, label(env, post), local(env, nowIso()), permalink));
}

/**
 * Moves a post forward (to the end when possible). Idempotent.
 * options.dryRun: creates a container and checks Instagram accepts it (FINISHED) without publishing or storing anything.
 */
export async function advance(env, post, options = {}) {
  try {
    const { page_id: pageId, ig_id: igId } = parseAccounts(env)[post.account];
    const token = await pageToken(env, pageId);

    if (options.dryRun) {
      const c = await createContainer(env, post, igId, token);
      let last = null;
      for (let i = 0; i < 10; i++) {
        await sleep(env, 3000);
        last = await containerStatus(env, c.creation_id, token);
        if (['FINISHED', 'ERROR'].includes(last.status_code)) break;
      }
      return { dry_run: true, creation_id: c.creation_id, status_code: last?.status_code, detail: last };
    }

    let creationId = post.creation_id;
    if (!creationId) {
      const c = await createContainer(env, post, igId, token);
      creationId = c.creation_id;
      await updatePost(env, post.id, { creation_id: creationId, items_json: c.items ? JSON.stringify(c.items) : null, status: 'processing' });
    }

    // Wait for Instagram to process the media. Images take seconds (we wait here); reels take minutes (the next cron run continues).
    const polls = post.type === 'reel' ? 1 : 10;
    let st = null;
    for (let i = 0; i < polls; i++) {
      st = await containerStatus(env, creationId, token);
      if (['FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'].includes(st.status_code)) break;
      if (i < polls - 1) await sleep(env, 3000);
    }

    if (st?.status_code === 'PUBLISHED') { // an earlier run published and then lost the result
      const recent = await recentMedia(env, igId, token);
      const same = (recent.data || []).find((m) => (m.caption || '').slice(0, 60) === post.caption.slice(0, 60));
      // If no caption matches, fall back to the container id (still a valid reference for the record).
      await markPublished(env, post, token, same?.id || creationId);
      return { status: 'published', media_id: same?.id || creationId };
    }
    if (st?.status_code === 'ERROR' || st?.status_code === 'EXPIRED') {
      throw Object.assign(new Error(`Instagram rejected container ${creationId}: ${JSON.stringify(st).slice(0, 300)}`), { discardContainer: true });
    }
    if (st?.status_code !== 'FINISHED') {
      await updatePost(env, post.id, { status: 'processing', lock_until: null });
      return { status: 'processing', status_code: st?.status_code };
    }

    const pub = await graphPost(env, `${igId}/media_publish`, { creation_id: creationId, access_token: token });
    if (!pub.id) throw new Error(`media_publish returned no id: ${JSON.stringify(pub).slice(0, 300)}`);
    await markPublished(env, post, token, pub.id);
    return { status: 'published', media_id: pub.id };
  } catch (err) {
    if (options.dryRun) return { dry_run: true, error: String(err.message || err) };
    await fail(env, post, err);
    return { status: 'error', error: String(err.message || err) };
  }
}

/** One cron tick: expire hopelessly late posts, then advance every due post. */
export async function runCycle(env) {
  await ensureSchema(env.DB);
  const now = nowIso();
  const cutoff = new Date(Date.now() - MAX_LATE_MS).toISOString();

  const stale = (await env.DB.prepare("SELECT * FROM posts WHERE status IN ('pending', 'processing') AND scheduled_utc < ?").bind(cutoff).all()).results ?? [];
  for (const p of stale) {
    await updatePost(env, p.id, { status: 'failed', error: msg(env).expiredReason(MAX_LATE_MS / 3600e3) });
    await notify(env, msg(env).expired(p.title, local(env, p.scheduled_utc), p.id));
  }

  const due = (await env.DB.prepare("SELECT * FROM posts WHERE status IN ('pending', 'processing') AND scheduled_utc <= ? AND (next_attempt_utc IS NULL OR next_attempt_utc <= ?) ORDER BY scheduled_utc")
    .bind(now, now).all()).results ?? [];
  const results = [];
  for (const p of due) if (await claim(env, p.id)) results.push({ id: p.id, ...(await advance(env, p)) });
  return results;
}
