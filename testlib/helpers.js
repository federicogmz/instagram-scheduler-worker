// Test doubles: a D1 look-alike on node:sqlite (real SQL, in memory) and a scriptable Instagram Graph API.
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema, resetSchemaCache } from '../src/db.js';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map((v) => (v === undefined ? null : v))),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  resetSchemaCache();
  return { prepare: (sql) => stmt(sql), raw: db };
}

export function makeEnv(overrides = {}) {
  return {
    DB: fakeD1(),
    ACCOUNTS: JSON.stringify({ main: { page_id: 'PAGE1', ig_id: 'IG1', label: '@main' } }),
    META_ACCESS_TOKEN: 'sys-token',
    TIMEZONE: 'America/Bogota',
    POLL_DELAY_MS: '0',
    ...overrides,
  };
}

export async function insertPost(env, fields = {}) {
  await ensureSchema(env.DB);
  const t = new Date().toISOString();
  const p = {
    id: 'p1', account: 'main', title: 'Post one', type: 'image', media_json: '["https://cdn.example.com/a.jpg"]', caption: 'Hello',
    collaborators_json: null, scheduled_utc: new Date(Date.now() - 60e3).toISOString(), status: 'pending', attempts: 0,
    next_attempt_utc: null, lock_until: null, creation_id: null, items_json: null, media_id: null, permalink: null, error: null,
    created_at: t, updated_at: t, published_at: null, ...fields,
  };
  const cols = Object.keys(p);
  await env.DB.prepare(`INSERT INTO posts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((c) => p[c])).run();
  return p;
}

export const getPost = (env, id = 'p1') => env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();

/**
 * Replaces global fetch with a scripted Graph API. `script` is an object of overrides, each (url, init) => body | Error.
 * Defaults model a healthy account. Every call is recorded in `calls` as "METHOD path".
 */
export function mockGraph(script = {}) {
  const calls = [];
  const original = globalThis.fetch;
  const reply = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const defaults = {
    pageToken: () => ({ access_token: 'page-token' }),
    createContainer: () => ({ id: 'container-1' }),
    status: () => ({ status_code: 'FINISHED' }),
    publish: () => ({ id: 'media-1' }),
    permalink: () => ({ permalink: 'https://www.instagram.com/p/ABC/' }),
    recent: () => ({ data: [] }),
  };
  const h = { ...defaults, ...script };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.hostname === 'api.telegram.org') return reply({ ok: true });
    const fields = u.searchParams.get('fields');
    let out;
    if (method === 'POST' && u.pathname.endsWith('/media_publish')) out = h.publish(url, init);
    else if (method === 'POST' && u.pathname.endsWith('/media')) out = h.createContainer(url, init);
    else if (fields === 'access_token') out = h.pageToken(url, init);
    else if (fields === 'permalink') out = h.permalink(url, init);
    else if (fields === 'id,caption') out = h.recent(url, init);
    else if (fields?.startsWith('status_code')) out = h.status(url, init);
    else out = { error: { message: `unmocked ${method} ${u.pathname}` } };
    if (out instanceof Error) throw out;
    return reply(out);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
