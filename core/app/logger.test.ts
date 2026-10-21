import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogger, sanitizeFields } from './logger.ts';

test('one JSON line per event with time, level and event', () => {
  const lines: string[] = [];
  makeLogger((l) => lines.push(l), () => new Date('2026-10-21T00:00:00.000Z'))('info', 'started', { port: 8787, ok: true });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { t: '2026-10-21T00:00:00.000Z', level: 'info', event: 'started', port: 8787, ok: true });
});

test('values under sensitive-looking keys are replaced whatever they contain', () => {
  const out = sanitizeFields({
    clientSecret: 'S3CR3T', access_token: 'tok', SHOPIFY_API_SECRET: 'x', password: 'p', Authorization: 'Bearer abc', payload: '{"a":1}',
    body: 'b', customerEmail: 'a@b.com', ENCRYPTION_KEY: 'k', apiKey: 'k', privateKey: 'k', shop: 's.myshopify.com',
  });
  assert.deepEqual(Object.entries(out).filter(([, v]) => v !== '[redacted]'), [['shop', 's.myshopify.com']]);
});

test('emails inside ordinary string values are masked; long values are truncated; undefined is dropped', () => {
  const out = sanitizeFields({ note: 'contact bob.smith@acme.com now', long: 'x'.repeat(2000), nothing: undefined, n: null });
  assert.equal(out.note, 'contact b***@acme.com now');
  assert.equal((out.long as string).length, 500);
  assert.ok(!('nothing' in out));
  assert.equal(out.n, null);
});

test('the logger cannot be used to print a secret even if a caller tries', () => {
  const lines: string[] = [];
  makeLogger((l) => lines.push(l))('error', 'boom', { clientSecret: 'TOPSECRET-VALUE', detail: 'fine' });
  assert.ok(!lines[0].includes('TOPSECRET-VALUE'));
  assert.ok(lines[0].includes('fine'));
});
