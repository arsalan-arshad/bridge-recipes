import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyShopifyHmac } from './verifyHmac.ts';

// Vector made independently: printf 'hello' | openssl dgst -sha256 -hmac 'secret' -binary | base64
const GOOD = 'iKqz7ejTrflNJquQ07r9SiCDBww7zOnAFO4EpEOEfAs=';

test('accepts a correct signature (string and Buffer body)', () => {
  assert.equal(verifyShopifyHmac('hello', GOOD, 'secret'), true);
  assert.equal(verifyShopifyHmac(Buffer.from('hello'), GOOD, 'secret'), true);
});

test('rejects a tampered body', () => {
  assert.equal(verifyShopifyHmac('hello!', GOOD, 'secret'), false);
});

test('rejects a wrong secret', () => {
  assert.equal(verifyShopifyHmac('hello', GOOD, 'other'), false);
});

test('rejects missing, empty and malformed headers without throwing', () => {
  assert.equal(verifyShopifyHmac('hello', undefined, 'secret'), false);
  assert.equal(verifyShopifyHmac('hello', null, 'secret'), false);
  assert.equal(verifyShopifyHmac('hello', '', 'secret'), false);
  assert.equal(verifyShopifyHmac('hello', 'not-base64!!', 'secret'), false);
  assert.equal(verifyShopifyHmac('hello', 'AAAA', 'secret'), false);
});

test('rejects an empty secret even when the header was signed with an empty key', () => {
  const signedWithEmptyKey = createHmac('sha256', '').update('hello').digest('base64');
  assert.equal(verifyShopifyHmac('hello', signedWithEmptyKey, ''), false);
});

test('a re-serialised body does not verify (raw bytes matter)', () => {
  const raw = '{"a": 1}';
  const reserialised = JSON.stringify(JSON.parse(raw));
  const sig = 'x';
  assert.notEqual(raw, reserialised);
  assert.equal(verifyShopifyHmac(reserialised, sig, 'secret'), false);
});
