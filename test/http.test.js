import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from '../testlib/helpers.js';

const ORIGIN = 'https://sched.example.workers.dev';
const SECRET = 'correct-horse-battery-staple';
const fakeR2 = () => ({ head: async (key) => (key.endsWith('.jpg') ? { httpMetadata: { contentType: 'image/jpeg' } } : null) });
const env = () => makeEnv({ PUBLISH_SECRET: SECRET, MEDIA: fakeR2() });
const call = (e, path, { method = 'GET', body, secret = SECRET } = {}) =>
  worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: { ...(secret ? { 'x-secret': secret } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), e);

const newPost = (over = {}) => ({
  id: 'spring-sale', account: 'main', type: 'image', title: 'Spring sale',
  media: [`${ORIGIN}/media/2026-10/sale.jpg`], caption: 'Spring sale! #sale', scheduled_utc: new Date(Date.now() + 3600e3).toISOString(), ...over,
});

test('/status is public but reveals only counts, never titles or captions', async () => {
  const e = env();
  await call(e, '/queue', { method: 'POST', body: newPost() });
  const res = await call(e, '/status', { secret: null });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text).by_status, { pending: 1 });
  assert.ok(!text.includes('Spring sale'));
});

test('admin routes need the right secret', async () => {
  const e = env();
  assert.equal((await call(e, '/queue', { secret: null })).status, 401);
  assert.equal((await call(e, '/queue', { secret: 'wrong' })).status, 401);
  assert.equal((await call(e, '/queue')).status, 200);
  assert.equal((await call(makeEnv({ MEDIA: fakeR2() }), '/queue')).status, 401, 'no PUBLISH_SECRET configured → everything denied');
});

test('queue lifecycle: create, duplicate, list, cancel, retry', async () => {
  const e = env();
  const created = await call(e, '/queue', { method: 'POST', body: newPost() });
  assert.equal(created.status, 201);
  assert.equal((await call(e, '/queue', { method: 'POST', body: newPost() })).status, 409);

  const list = await (await call(e, '/queue')).json();
  assert.equal(list.posts.length, 1);
  assert.match(list.posts[0].scheduled_local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  assert.equal((await call(e, '/queue/spring-sale/retry', { method: 'POST' })).status, 409, 'cannot retry a pending post');
  assert.equal((await call(e, '/queue/spring-sale', { method: 'DELETE' })).status, 200);
  const retried = await call(e, '/queue/spring-sale/retry', { method: 'POST' });
  assert.equal((await retried.json()).status, 'pending');
  assert.equal((await call(e, '/queue/nope')).status, 404);
});

test('invalid posts are rejected with every problem listed', async () => {
  const e = env();
  const res = await call(e, '/queue', { method: 'POST', body: newPost({ account: 'ghost', caption: '', media: ['http://insecure/a.jpg'] }) });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.length >= 3);
});

test('media URLs hosted by the Worker must exist in storage with the right type', async () => {
  const e = env();
  const res = await call(e, '/queue', { method: 'POST', body: newPost({ media: [`${ORIGIN}/media/2026-10/missing.png`] }) });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).errors[0].includes('not found'));
});

test('a bad TIMEZONE is reported instead of silently shifting every post', async () => {
  const e = makeEnv({ PUBLISH_SECRET: SECRET, MEDIA: fakeR2(), TIMEZONE: 'Mars/Olympus' });
  assert.equal((await call(e, '/status', { secret: null })).status, 500);
});

test('retry rescues a post that expired: it is rescheduled for now and then published', async () => {
  const { runCycle } = await import('../src/publisher.js');
  const { insertPost, getPost, mockGraph } = await import('../testlib/helpers.js');
  const e = env();
  await insertPost(e, { id: 'old-one', status: 'failed', error: 'expired', scheduled_utc: new Date(Date.now() - 7 * 3600e3).toISOString() });
  assert.equal((await call(e, '/queue/old-one/retry', { method: 'POST' })).status, 200);
  const graph = mockGraph();
  try {
    const out = await runCycle(e);
    assert.equal(out[0].status, 'published');
    assert.equal((await getPost(e, 'old-one')).status, 'published');
  } finally { graph.restore(); }
});

test('retry can take a new local time, and rejects a malformed one', async () => {
  const { insertPost, getPost } = await import('../testlib/helpers.js');
  const e = env();
  await insertPost(e, { id: 'later', status: 'cancelled' });
  const bad = await call(e, '/queue/later/retry', { method: 'POST', body: { scheduled_local: 'next friday' } });
  assert.equal(bad.status, 400);
  const ok = await call(e, '/queue/later/retry', { method: 'POST', body: { scheduled_local: '2030-01-15 09:30' } });
  assert.equal(ok.status, 200);
  assert.equal((await getPost(e, 'later')).scheduled_utc, '2030-01-15T14:30:00.000Z');
});
