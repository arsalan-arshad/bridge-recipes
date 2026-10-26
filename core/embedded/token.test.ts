import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySessionToken } from './token.ts';

const SECRET = 'test-client-secret';
const ID = 'client-id-1234';
const NOW = 1_800_000_000_000; // ms
const S = NOW / 1000;
const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://demo-shop.myshopify.com/admin', dest: 'https://demo-shop.myshopify.com', aud: ID, sub: '42',
  exp: S + 60, nbf: S - 5, iat: S - 5, jti: 'x', ...over,
});

function make(c: Record<string, unknown> = claims(), opts: { secret?: string; header?: unknown } = {}): string {
  const h = b64(opts.header ?? { alg: 'HS256', typ: 'JWT' });
  const p = b64(c);
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
const check = (t: string, over: { nowMs?: number } = {}) => verifySessionToken(t, { clientSecret: SECRET, clientId: ID, nowMs: over.nowMs ?? NOW });

test('a valid token yields the shop (lower-cased host) and the user id', () => {
  assert.deepEqual(check(make()), { ok: true, shop: 'demo-shop.myshopify.com', userId: '42' });
  assert.deepEqual(check(make(claims({ dest: 'https://Demo-Shop.myshopify.com', iss: 'https://DEMO-shop.myshopify.com/admin', sub: undefined }))), { ok: true, shop: 'demo-shop.myshopify.com', userId: null });
});

test('refusals, each with its own reason', () => {
  const cases: [string, string, string][] = [
    ['not three parts', 'abc.def', 'malformed'],
    ['empty part', 'a..c', 'malformed'],
    ['not base64url', 'a b.c.d', 'malformed'],
    ['empty string', '', 'malformed'],
    ['alg none', make(claims(), { header: { alg: 'none' } }), 'bad_algorithm'],
    ['alg RS256', make(claims(), { header: { alg: 'RS256' } }), 'bad_algorithm'],
    ['header not an object', make(claims(), { header: '"HS256"' }), 'malformed'],
    ['signed with another secret', make(claims(), { secret: 'other' }), 'bad_signature'],
    ['expired', make(claims({ exp: S - 10 })), 'expired'],
    ['exp missing', make(claims({ exp: undefined })), 'expired'],
    ['exp not a number', make(claims({ exp: '9999999999' })), 'expired'],
    ['not yet valid', make(claims({ nbf: S + 60 })), 'not_yet_valid'],
    ['nbf missing', make(claims({ nbf: undefined })), 'not_yet_valid'],
    ['audience is another app', make(claims({ aud: 'someone-else' })), 'wrong_audience'],
    ['audience is a list', make(claims({ aud: [ID] })), 'wrong_audience'],
    ['dest is not a Shopify shop', make(claims({ dest: 'https://evil.example.com', iss: 'https://evil.example.com/admin' })), 'bad_shop'],
    ['dest over http', make(claims({ dest: 'http://demo-shop.myshopify.com' })), 'bad_shop'],
    ['dest lookalike host', make(claims({ dest: 'https://demo-shop.myshopify.com.evil.io', iss: 'https://demo-shop.myshopify.com.evil.io/admin' })), 'bad_shop'],
    ['dest missing', make(claims({ dest: undefined })), 'bad_shop'],
    ['issuer is another shop', make(claims({ iss: 'https://other-shop.myshopify.com/admin' })), 'issuer_mismatch'],
    ['issuer missing', make(claims({ iss: undefined })), 'issuer_mismatch'],
  ];
  for (const [name, token, reason] of cases) assert.deepEqual(check(token), { ok: false, reason: reason as any }, name);
});

test('the signature is checked before any claim is trusted: a forged token with otherwise bad claims says bad_signature', () => {
  assert.deepEqual(check(make(claims({ exp: S - 10, aud: 'x' }), { secret: 'other' })), { ok: false, reason: 'bad_signature' });
});

test('exp and nbf allow a few seconds of clock skew, no more', () => {
  assert.equal(check(make(claims({ exp: S - 4 }))).ok, true);
  assert.equal(check(make(claims({ exp: S - 5 }))).ok, false);
  assert.equal(check(make(claims({ nbf: S + 4 }))).ok, true);
  assert.equal(check(make(claims({ nbf: S + 6 }))).ok, false);
  assert.equal(verifySessionToken(make(claims({ exp: S - 20 })), { clientSecret: SECRET, clientId: ID, nowMs: NOW, leewaySeconds: 30 }).ok, true);
});

test('a truncated or extended signature is refused', () => {
  const t = make();
  assert.deepEqual(check(t.slice(0, -2)), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(check(`${t}AA`), { ok: false, reason: 'bad_signature' });
});
