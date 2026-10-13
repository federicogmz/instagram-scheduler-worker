import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePost } from '../src/validate.js';

const accounts = { main: { page_id: '1', ig_id: '2' }, shop: { page_id: '3', ig_id: '4' } };
const NOW = Date.parse('2026-10-12T12:00:00Z');
const opts = { accounts, timezone: 'America/Bogota', now: NOW, checkUrl: async () => null };
const good = () => ({
  id: 'launch-post', account: 'main', type: 'image', media: ['https://cdn.example.com/a.jpg'],
  caption: 'Hello #world', scheduled_local: '2026-10-19 19:00',
});

test('accepts a valid post and normalises it', async () => {
  const { errors, value } = await validatePost(good(), opts);
  assert.deepEqual(errors, []);
  assert.equal(value.scheduled.toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(value.title, 'launch-post');
});

test('rejects unknown account, type and bad id', async () => {
  const { errors } = await validatePost({ ...good(), id: 'x', account: 'nope', type: 'story' }, opts);
  assert.ok(errors.some((e) => e.startsWith('id')));
  assert.ok(errors.some((e) => e.startsWith('account')));
  assert.ok(errors.some((e) => e.startsWith('type')));
});

test('carousel needs 2–10 slides; image needs exactly one', async () => {
  const one = ['https://x.example/1.jpg'];
  assert.ok((await validatePost({ ...good(), type: 'carousel', media: one }, opts)).errors.length);
  assert.deepEqual((await validatePost({ ...good(), type: 'carousel', media: [...one, ...one] }, opts)).errors, []);
  assert.ok((await validatePost({ ...good(), media: [...one, ...one] }, opts)).errors.length);
});

test('only https media URLs (http is allowed for localhost only)', async () => {
  assert.deepEqual((await validatePost({ ...good(), media: ['http://localhost:8787/media/a.jpg'] }, opts)).errors, []);
  const { errors } = await validatePost({ ...good(), media: ['http://insecure.example/a.jpg'] }, opts);
  assert.ok(errors.some((e) => e.includes('https://')));
});

test('caption limits', async () => {
  assert.ok((await validatePost({ ...good(), caption: '' }, opts)).errors.length);
  assert.ok((await validatePost({ ...good(), caption: 'a'.repeat(2201) }, opts)).errors.some((e) => e.includes('2200')));
  assert.ok((await validatePost({ ...good(), caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') }, opts)).errors.some((e) => e.includes('hashtags')));
});

test('time rules', async () => {
  assert.ok((await validatePost({ ...good(), scheduled_local: '2026-10-01 10:00' }, opts)).errors.some((e) => e.includes('past')));
  assert.ok((await validatePost({ ...good(), scheduled_local: undefined }, opts)).errors.some((e) => e.startsWith('schedule')));
  assert.deepEqual((await validatePost({ ...good(), scheduled_local: undefined, scheduled_utc: '2026-10-20T00:00:00Z' }, opts)).errors, []);
});

test('collaborator cap and URL check failures are reported', async () => {
  assert.ok((await validatePost({ ...good(), collaborators: ['a', 'b', 'c', 'd'] }, opts)).errors.some((e) => e.startsWith('collaborators')));
  const bad = await validatePost(good(), { ...opts, checkUrl: async (u) => `${u} → HTTP 404` });
  assert.ok(bad.errors[0].includes('404'));
});
