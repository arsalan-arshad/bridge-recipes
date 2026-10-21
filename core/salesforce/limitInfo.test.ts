import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiUsageRatio, parseLimitInfo } from './limitInfo.ts';

test('parses the classic format', () => {
  assert.deepEqual(parseLimitInfo('api-usage=10018/100000'), { 'api-usage': { used: 10018, max: 100000 } });
});

test('parses extra keys and ignores junk', () => {
  const r = parseLimitInfo('api-usage=10018/100000; api-bursts=1/750; weird; x=y/z');
  assert.deepEqual(r['api-usage'], { used: 10018, max: 100000 });
  assert.deepEqual(r['api-bursts'], { used: 1, max: 750 });
  assert.equal(Object.keys(r).length, 2);
});

test('missing or empty header gives an empty result', () => {
  assert.deepEqual(parseLimitInfo(undefined), {});
  assert.deepEqual(parseLimitInfo(null), {});
  assert.deepEqual(parseLimitInfo(''), {});
});

test('apiUsageRatio', () => {
  assert.equal(apiUsageRatio('api-usage=25/100'), 0.25);
  assert.equal(apiUsageRatio('api-bursts=1/750'), null);
  assert.equal(apiUsageRatio('api-usage=0/0'), null);
  assert.equal(apiUsageRatio(undefined), null);
});
