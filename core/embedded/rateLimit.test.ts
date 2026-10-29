import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowLimiter } from './rateLimit.ts';

test('allows the limit, refuses the next with a retry time, and starts a new window afterwards', () => {
  let t = 1000;
  const l = createWindowLimiter({ limit: 3, windowMs: 60_000, now: () => t });
  assert.deepEqual([l.take('a'), l.take('a'), l.take('a')].map((r) => r.ok), [true, true, true]);
  const no = l.take('a');
  assert.deepEqual(no, { ok: false, retryAfterSeconds: 60 });
  t += 30_000;
  assert.deepEqual(l.take('a'), { ok: false, retryAfterSeconds: 30 });
  t += 30_000;
  assert.equal(l.take('a').ok, true, 'a new window');
});

test('keys are independent, and a full table refuses new keys instead of growing', () => {
  let t = 0;
  const l = createWindowLimiter({ limit: 1, windowMs: 1000, now: () => t, maxKeys: 2 });
  assert.equal(l.take('a').ok, true);
  assert.equal(l.take('b').ok, true);
  assert.equal(l.take('a').ok, false);
  assert.equal(l.take('b').ok, false);
  assert.equal(l.take('c').ok, false, 'table full');
  t += 1000;
  assert.equal(l.take('c').ok, true, 'expired windows are forgotten');
});
