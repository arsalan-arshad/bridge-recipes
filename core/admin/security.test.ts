import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  LoginLimiter, checkCsrf, clearedCookie, constantTimeEqual, createSession, csrfToken, deriveSessionKey, parseCookies, readSession, sessionCookie,
} from './security.ts';

const key = deriveSessionKey(randomBytes(32));
const cookie = (v: string) => `bridge_admin=${v}`;

test('the session key is derived deterministically from the encryption key and differs from it', () => {
  const k = randomBytes(32);
  assert.deepEqual(deriveSessionKey(k), deriveSessionKey(k));
  assert.notDeepEqual(deriveSessionKey(k), k);
  assert.notDeepEqual(deriveSessionKey(randomBytes(32)), deriveSessionKey(k));
  assert.equal(deriveSessionKey(k).length, 32);
});

test('constantTimeEqual: equal, different, different length, empty', () => {
  assert.equal(constantTimeEqual('correct horse', 'correct horse', key), true);
  for (const [a, b] of [['correct horse', 'correct horsf'], ['a', 'ab'], ['', 'x'], ['x', '']] as const) assert.equal(constantTimeEqual(a, b, key), false);
  assert.equal(constantTimeEqual('', '', key), true);
});

test('a session round-trips and expires', () => {
  const v = createSession(key, 1_000, 5_000);
  const s = readSession(key, cookie(v), 2_000);
  assert.ok(s);
  assert.equal(s!.exp, 6_000);
  assert.ok(readSession(key, cookie(v), 5_999));
  assert.equal(readSession(key, cookie(v), 6_000), null, 'expired exactly at exp');
  assert.equal(readSession(key, cookie(v), 9_000), null);
});

test('tampered, forged, malformed or missing sessions are rejected', () => {
  const v = createSession(key, 1_000, 5_000);
  const [payload, sig] = v.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ exp: 9e15, nonce: 'x' })).toString('base64url');
  for (const bad of [
    `${forgedPayload}.${sig}`, `${payload}.${sig.slice(0, -2)}AA`, `${payload}.`, `.${sig}`, payload, '', 'garbage', `${payload}.${sig}.extra`,
    createSession(deriveSessionKey(randomBytes(32)), 1_000, 5_000),
  ]) assert.equal(readSession(key, cookie(bad), 2_000), null, bad.slice(0, 30));
  assert.equal(readSession(key, undefined, 2_000), null);
  assert.equal(readSession(key, 'other=1', 2_000), null);
});

test('cookie parsing copes with several cookies and spacing', () => {
  assert.deepEqual(parseCookies('a=1; b=2;c=3 ; bridge_admin=x.y'), { a: '1', b: '2', c: '3', bridge_admin: 'x.y' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('novalue; =x'), {});
});

test('CSRF tokens are bound to the session and checked in constant time', () => {
  const a = readSession(key, cookie(createSession(key, 0, 9e9)), 1)!;
  const b = readSession(key, cookie(createSession(key, 0, 9e9)), 1)!;
  assert.equal(checkCsrf(key, a, csrfToken(key, a)), true);
  assert.equal(checkCsrf(key, a, csrfToken(key, b)), false, 'another session token');
  for (const bad of [undefined, '', 'x', csrfToken(key, a).slice(1)]) assert.equal(checkCsrf(key, a, bad), false);
  assert.equal(checkCsrf(deriveSessionKey(randomBytes(32)), a, csrfToken(key, a)), false, 'another key');
});

test('cookie attributes: HttpOnly, SameSite=Strict, Path=/admin, Max-Age, Secure only when asked', () => {
  const c = sessionCookie('v', { secure: false, maxAgeSeconds: 100 });
  assert.ok(c.includes('HttpOnly') && c.includes('SameSite=Strict') && c.includes('Path=/admin') && c.includes('Max-Age=100'));
  assert.ok(!c.includes('Secure'));
  assert.ok(sessionCookie('v', { secure: true, maxAgeSeconds: 1 }).endsWith('; Secure'));
  assert.ok(clearedCookie(true).includes('Max-Age=0') && clearedCookie(true).includes('Secure'));
  assert.ok(!clearedCookie(false).includes('Secure'));
});

test('login limiter: blocks after the per-address limit, other addresses are unaffected, window expires, success resets', () => {
  let t = 0;
  const l = new LoginLimiter({ maxPerIp: 3, maxGlobal: 100, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) { assert.equal(l.blocked('a'), false); l.failure('a'); }
  assert.equal(l.blocked('a'), true);
  assert.equal(l.blocked('b'), false);
  t = 1001;
  assert.equal(l.blocked('a'), false, 'window passed');
  l.failure('a'); l.failure('a');
  l.success('a');
  assert.equal(l.blocked('a'), false);
  l.failure('a'); l.failure('a');
  assert.equal(l.blocked('a'), false, 'a success cleared the earlier failures');
});

test('login limiter: the global ceiling blocks even a fresh address', () => {
  let t = 0;
  const l = new LoginLimiter({ maxPerIp: 100, maxGlobal: 4, windowMs: 1000, now: () => t });
  for (let i = 0; i < 4; i++) l.failure(`ip${i}`);
  assert.equal(l.blocked('brand-new'), true);
  t = 1001;
  assert.equal(l.blocked('brand-new'), false);
});

test('the session key depends on the admin password: changing the password invalidates old sessions', () => {
  const k = Buffer.alloc(32, 7);
  assert.ok(deriveSessionKey(k, 'one-password-here').equals(deriveSessionKey(k, 'one-password-here')));
  assert.ok(!deriveSessionKey(k, 'one-password-here').equals(deriveSessionKey(k, 'another-password')));
  const old = createSession(deriveSessionKey(k, 'one-password-here'), 1000, 60_000);
  assert.equal(readSession(deriveSessionKey(k, 'another-password'), `bridge_admin=${old}`, 2000), null);
});
