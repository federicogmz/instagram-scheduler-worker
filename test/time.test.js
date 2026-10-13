import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocal, isValidTimeZone, localToUtc } from '../src/time.js';

test('fixed-offset zone (Bogotá, UTC-5)', () => {
  assert.equal(localToUtc('2026-10-19 19:00', 'America/Bogota').toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(formatLocal('2026-10-20T00:00:00Z', 'America/Bogota'), '2026-10-19 19:00');
});

test('DST zone: summer and winter offsets differ', () => {
  assert.equal(localToUtc('2026-07-01 09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z'); // EDT, UTC-4
  assert.equal(localToUtc('2026-01-15 09:00', 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z'); // EST, UTC-5
  assert.equal(localToUtc('2026-07-01 09:00', 'Europe/Madrid').toISOString(), '2026-07-01T07:00:00.000Z');   // CEST, UTC+2
});

test('spring-forward gap does not exist and is rejected', () => {
  assert.equal(localToUtc('2026-03-08 02:30', 'America/New_York'), null);
  assert.ok(localToUtc('2026-03-08 03:30', 'America/New_York'));
});

test('round trip for every hour around a DST change', () => {
  for (let h = 0; h < 24; h++) {
    const text = `2026-11-01 ${String(h).padStart(2, '0')}:00`;
    const utc = localToUtc(text, 'America/New_York');
    assert.ok(utc, text);
    assert.equal(formatLocal(utc.toISOString(), 'America/New_York'), text);
  }
});

test('malformed input and zone validation', () => {
  assert.equal(localToUtc('tomorrow', 'UTC'), null);
  assert.equal(localToUtc('2026-13-40 10:00', 'UTC'), null);
  assert.equal(isValidTimeZone('America/Bogota'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
});
