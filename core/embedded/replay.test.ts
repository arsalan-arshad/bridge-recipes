import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReplayIds } from './replay.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const jobs = [{ id: A, shop: 'one.myshopify.com' }, { id: B, shop: 'two.myshopify.com' }, { id: C, shop: 'one.myshopify.com' }];

test('"all" means all of the shop\'s OWN jobs, never another shop\'s', () => {
  assert.deepEqual(selectReplayIds(jobs, 'one.myshopify.com', 'all'), { ok: true, ids: [A, C] });
  assert.deepEqual(selectReplayIds(jobs, 'two.myshopify.com', 'all'), { ok: true, ids: [B] });
  assert.deepEqual(selectReplayIds(jobs, 'none.myshopify.com', 'all'), { ok: true, ids: [] });
  assert.deepEqual(selectReplayIds([], 'one.myshopify.com', 'all'), { ok: true, ids: [] });
});

test('look-alike shop names are different shops (exact match only)', () => {
  const D = '44444444-4444-4444-8444-444444444444';
  const E = '55555555-5555-4555-8555-555555555555';
  const lookalike = [...jobs, { id: D, shop: 'one.myshopify.com.evil.io' }, { id: E, shop: 'xone.myshopify.com' }];
  assert.deepEqual(selectReplayIds(lookalike, 'one.myshopify.com', 'all'), { ok: true, ids: [A, C] });
  assert.deepEqual(selectReplayIds(lookalike, 'one.myshopify.com', D), { ok: true, ids: [] });
  assert.deepEqual(selectReplayIds(lookalike, 'one.myshopify.com', E), { ok: true, ids: [] });
});

test('a single id is honoured only if it is one of the shop\'s own jobs', () => {
  assert.deepEqual(selectReplayIds(jobs, 'one.myshopify.com', A), { ok: true, ids: [A] });
  assert.deepEqual(selectReplayIds(jobs, 'one.myshopify.com', B), { ok: true, ids: [] }, "another shop's job");
  assert.deepEqual(selectReplayIds(jobs, 'one.myshopify.com', '99999999-9999-4999-8999-999999999999'), { ok: true, ids: [] }, 'an unknown job');
});

test('anything that is neither "all" nor a job id is refused', () => {
  for (const bad of [undefined, '', 'ALL', 'all ', 'a', `${A},${B}`, `${A} `, "'; drop table", '../x', '<img>']) {
    assert.deepEqual(selectReplayIds(jobs, 'one.myshopify.com', bad), { ok: false }, String(bad));
  }
});
