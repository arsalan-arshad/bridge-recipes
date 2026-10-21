import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CryptoError, decrypt, encrypt, parseKey } from './secretBox.ts';

const key = () => randomBytes(32);
const SECRET = 'sf-client-secret-VALUE-12345';

test('round trip, including empty and unicode text', () => {
  const k = key();
  for (const text of [SECRET, '', 'päss wörd ✓ 日本語', 'x'.repeat(10_000)]) assert.equal(decrypt(encrypt(text, k, 'shop-a|secret'), k, 'shop-a|secret'), text);
});

test('the ciphertext does not contain the plaintext, and every encryption differs (fresh IV)', () => {
  const k = key();
  const a = encrypt(SECRET, k, 'c');
  const b = encrypt(SECRET, k, 'c');
  assert.notEqual(a, b);
  assert.ok(!a.includes(SECRET) && !Buffer.from(a.split(':')[3], 'base64url').toString('utf8').includes(SECRET));
  assert.ok(a.startsWith('v1:'));
  assert.equal(a.split(':').length, 4);
});

test('tampering with any part is detected', () => {
  const k = key();
  const parts = encrypt(SECRET, k, 'c').split(':');
  for (let i = 1; i <= 3; i++) {
    const copy = [...parts];
    const raw = Buffer.from(copy[i], 'base64url');
    raw[0] ^= 1;
    copy[i] = raw.toString('base64url');
    assert.throws(() => decrypt(copy.join(':'), k, 'c'), CryptoError, `part ${i}`);
  }
});

test('wrong key or wrong context fails (a ciphertext cannot be moved to another shop or purpose)', () => {
  const k = key();
  const sealed = encrypt(SECRET, k, 'shop-a|client_secret');
  assert.throws(() => decrypt(sealed, key(), 'shop-a|client_secret'), CryptoError);
  assert.throws(() => decrypt(sealed, k, 'shop-b|client_secret'), CryptoError);
  assert.throws(() => decrypt(sealed, k, 'shop-a|other'), CryptoError);
  assert.equal(decrypt(sealed, k, 'shop-a|client_secret'), SECRET);
});

test('malformed ciphertext is rejected without a crash', () => {
  const k = key();
  for (const bad of ['', 'nope', 'v2:a:b:c', 'v1:a:b', 'v1:AAAA:AAAA:AAAA', 'v1:::', `${encrypt('x', k, 'c')}:extra`]) {
    assert.throws(() => decrypt(bad, k, 'c'), CryptoError, bad);
  }
});

test('key validation: only 64 hex characters; the message never contains the offending value', () => {
  assert.equal(parseKey('ab'.repeat(32)).length, 32);
  assert.equal(parseKey('AB'.repeat(32)).length, 32);
  const leaky = 'not-hex-but-secret-looking-value';
  for (const bad of [undefined, '', 'abc', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), leaky]) {
    assert.throws(() => parseKey(bad), (e: any) => e instanceof CryptoError && !e.message.includes(leaky));
  }
  assert.throws(() => encrypt('x', randomBytes(16), 'c'), CryptoError);
  assert.throws(() => decrypt('v1:a:b:c', randomBytes(16), 'c'), CryptoError);
});

test('errors never contain the plaintext, the key or the ciphertext', () => {
  const k = key();
  const sealed = encrypt(SECRET, k, 'c');
  try {
    decrypt(sealed, key(), 'c');
    assert.fail('should have thrown');
  } catch (e: any) {
    const text = `${e.message}${e.stack}${JSON.stringify(e)}`;
    for (const leak of [SECRET, k.toString('hex'), sealed.split(':')[3]]) assert.ok(!text.includes(leak));
  }
});

test('a VALID ciphertext with an unknown version label is rejected (no silent format changes)', () => {
  const k = key();
  const sealed = encrypt(SECRET, k, 'c');
  assert.equal(decrypt(sealed, k, 'c'), SECRET);
  assert.throws(() => decrypt(sealed.replace(/^v1:/, 'v2:'), k, 'c'), CryptoError);
  assert.throws(() => decrypt(sealed.replace(/^v1:/, 'V1:'), k, 'c'), CryptoError);
});

test('a short key is refused for BOTH encrypt and decrypt', () => {
  const sealed = encrypt(SECRET, key(), 'c');
  assert.throws(() => encrypt('x', randomBytes(31), 'c'), CryptoError);
  assert.throws(() => encrypt('x', randomBytes(33), 'c'), CryptoError);
  assert.throws(() => decrypt(sealed, randomBytes(31), 'c'), CryptoError);
  assert.throws(() => decrypt(sealed, randomBytes(33), 'c'), CryptoError);
});
