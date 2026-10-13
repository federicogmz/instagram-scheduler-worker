import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTEMPTS, runCycle, claim } from '../src/publisher.js';
import { getPost, insertPost, makeEnv, mockGraph } from '../testlib/helpers.js';

let graph;
afterEach(() => graph?.restore());

const publishCalls = (g) => g.calls.filter((c) => c.endsWith('/media_publish')).length;

test('publishes a due image post end to end', async () => {
  graph = mockGraph();
  const env = makeEnv();
  await insertPost(env);
  const res = await runCycle(env);
  assert.equal(res[0].status, 'published');
  const p = await getPost(env);
  assert.equal(p.status, 'published');
  assert.equal(p.media_id, 'media-1');
  assert.equal(p.permalink, 'https://www.instagram.com/p/ABC/');
  assert.equal(publishCalls(graph), 1);
});

test('does nothing for posts scheduled in the future', async () => {
  graph = mockGraph();
  const env = makeEnv();
  await insertPost(env, { scheduled_utc: new Date(Date.now() + 3600e3).toISOString() });
  assert.deepEqual(await runCycle(env), []);
  assert.equal(graph.calls.length, 0);
});

test('a failure schedules a retry with a growing wait, then gives up after MAX_ATTEMPTS', async () => {
  graph = mockGraph({ createContainer: () => ({ error: { message: 'boom' } }) });
  const env = makeEnv();
  await insertPost(env);
  await runCycle(env);
  let p = await getPost(env);
  assert.equal(p.status, 'pending');
  assert.equal(p.attempts, 1);
  assert.ok(new Date(p.next_attempt_utc) > new Date());
  assert.match(p.error, /boom/);
  assert.equal((await runCycle(env)).length, 0, 'not retried before next_attempt_utc');

  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    await env.DB.prepare('UPDATE posts SET next_attempt_utc = NULL, lock_until = NULL WHERE id = ?').bind('p1').run();
    await runCycle(env);
  }
  p = await getPost(env);
  assert.equal(p.status, 'failed');
  assert.equal(p.attempts, MAX_ATTEMPTS);
  assert.equal(publishCalls(graph), 0);
});

test('NEVER publishes twice: a container that Instagram already reports as PUBLISHED is only recorded', async () => {
  graph = mockGraph({ status: () => ({ status_code: 'PUBLISHED' }), recent: () => ({ data: [{ id: 'media-77', caption: 'Hello' }] }) });
  const env = makeEnv();
  await insertPost(env, { creation_id: 'container-old', status: 'processing' });
  await runCycle(env);
  const p = await getPost(env);
  assert.equal(p.status, 'published');
  assert.equal(p.media_id, 'media-77');
  assert.equal(publishCalls(graph), 0);
  assert.ok(!graph.calls.some((c) => c.endsWith('/IG1/media') && c.startsWith('POST')), 'no new container was created');
});

test('an ambiguous media_publish failure (network cut) keeps the container so the retry can detect the publish', async () => {
  graph = mockGraph({ publish: () => new Error('network cut') });
  const env = makeEnv();
  await insertPost(env);
  await runCycle(env);
  const p = await getPost(env);
  assert.equal(p.status, 'pending');
  assert.equal(p.creation_id, 'container-1', 'container kept');
});

test('a container Instagram marks ERROR is discarded so the retry builds a new one', async () => {
  graph = mockGraph({ status: () => ({ status_code: 'ERROR', status: 'bad media' }) });
  const env = makeEnv();
  await insertPost(env);
  await runCycle(env);
  const p = await getPost(env);
  assert.equal(p.status, 'pending');
  assert.equal(p.creation_id, null);
  assert.equal(publishCalls(graph), 0);
});

test('a reel still processing is left for the next cron run', async () => {
  graph = mockGraph({ status: () => ({ status_code: 'IN_PROGRESS' }) });
  const env = makeEnv();
  await insertPost(env, { type: 'reel', media_json: '["https://cdn.example.com/r.mp4"]' });
  const res = await runCycle(env);
  assert.equal(res[0].status, 'processing');
  const p = await getPost(env);
  assert.equal(p.status, 'processing');
  assert.equal(p.creation_id, 'container-1');
  assert.equal(p.lock_until, null);
});

test('carousel creates one child per slide plus a parent', async () => {
  let n = 0;
  graph = mockGraph({ createContainer: () => ({ id: `c${++n}` }) });
  const env = makeEnv();
  await insertPost(env, { type: 'carousel', media_json: '["https://x.example/1.jpg","https://x.example/2.jpg","https://x.example/3.jpg"]' });
  await runCycle(env);
  assert.equal(graph.calls.filter((c) => c === 'POST /v21.0/IG1/media').length, 4);
  const p = await getPost(env);
  assert.equal(p.status, 'published');
  assert.deepEqual(JSON.parse(p.items_json), ['c1', 'c2', 'c3']);
});

test('a post more than 6 h overdue is expired, not published', async () => {
  graph = mockGraph();
  const env = makeEnv();
  await insertPost(env, { scheduled_utc: new Date(Date.now() - 7 * 3600e3).toISOString() });
  await runCycle(env);
  const p = await getPost(env);
  assert.equal(p.status, 'failed');
  assert.match(p.error, /expired/);
  assert.equal(graph.calls.length, 0);
});

test('claim() is exclusive: two overlapping runs cannot take the same post', async () => {
  const env = makeEnv();
  await insertPost(env);
  assert.equal(await claim(env, 'p1'), true);
  assert.equal(await claim(env, 'p1'), false);
});

test('cancelled and published posts are never picked up', async () => {
  graph = mockGraph();
  const env = makeEnv();
  await insertPost(env, { id: 'a', status: 'cancelled' });
  await insertPost(env, { id: 'b', status: 'published' });
  assert.deepEqual(await runCycle(env), []);
  assert.equal(graph.calls.length, 0);
});
