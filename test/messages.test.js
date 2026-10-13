import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { msg } from '../src/messages.js';
import { runCycle } from '../src/publisher.js';
import { getPost, insertPost, makeEnv, mockGraph } from '../testlib/helpers.js';

let graph;
afterEach(() => graph?.restore());

test('language switch with English as the default', () => {
  assert.match(msg({}).published('T', '@a', '2026-01-01 10:00', 'https://x'), /Published/);
  assert.match(msg({ NOTIFY_LANG: 'es' }).published('T', '@a', '2026-01-01 10:00', 'https://x'), /Publicado/);
  assert.match(msg({ NOTIFY_LANG: 'xx' }).test(), /Test/, 'unknown language falls back to English');
});

test('a successful publish sends exactly one Telegram message when configured, none when not', async () => {
  graph = mockGraph();
  const withTg = makeEnv({ TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '1', NOTIFY_LANG: 'es' });
  await insertPost(withTg);
  await runCycle(withTg);
  assert.equal(graph.calls.filter((c) => c.includes('sendMessage')).length, 1);
  assert.equal((await getPost(withTg)).status, 'published');
  graph.restore();

  graph = mockGraph();
  const without = makeEnv();
  await insertPost(without);
  await runCycle(without);
  assert.equal(graph.calls.filter((c) => c.includes('sendMessage')).length, 0);
});
