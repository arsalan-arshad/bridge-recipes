import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadEnv } from './env.ts';

const KEY = 'ab'.repeat(32);
const good = { DATABASE_URL: 'postgresql://u@localhost:5432/db', SHOPIFY_WEBHOOK_SECRET: 'whsec', ENCRYPTION_KEY: KEY };

test('a minimal valid environment loads with defaults', () => {
  const c = loadEnv(good);
  assert.equal(c.schema, 'bridge');
  assert.equal(c.port, 8787);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.encryptionKey.length, 32);
  assert.deepEqual(c.retention, { syncLogDays: 30, intakeDays: 14, entityMapDays: 30, complianceDays: 365 });
  assert.equal(c.shutdownTimeoutMs, 20_000);
});

test('SHOPIFY_API_SECRET is accepted when SHOPIFY_WEBHOOK_SECRET is absent; the webhook one wins', () => {
  assert.equal(loadEnv({ ...good, SHOPIFY_WEBHOOK_SECRET: undefined, SHOPIFY_API_SECRET: 'api' }).webhookSecret, 'api');
  assert.equal(loadEnv({ ...good, SHOPIFY_API_SECRET: 'api' }).webhookSecret, 'whsec');
});

test('every problem is reported together, by variable NAME, and no value is echoed', () => {
  const secretish = 'super-secret-looking-garbage';
  try {
    loadEnv({ DATABASE_URL: secretish, ENCRYPTION_KEY: secretish, BRIDGE_SCHEMA: 'Bad Schema!', PORT: secretish });
    assert.fail('should throw');
  } catch (e: any) {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.problems.length, 5);
    for (const name of ['DATABASE_URL', 'SHOPIFY_WEBHOOK_SECRET', 'ENCRYPTION_KEY', 'BRIDGE_SCHEMA', 'PORT']) assert.ok(e.message.includes(name), name);
    assert.ok(!e.message.includes(secretish) && !JSON.stringify(e).includes(secretish));
  }
});

test('numeric settings are bounds-checked', () => {
  for (const bad of [{ PORT: '70000' }, { PORT: '-1' }, { PORT: '8.5' }, { RETENTION_SYNC_LOG_DAYS: '0' }, { PURGE_EVERY_MINUTES: '0' }, { WORKER_POLL_SECONDS: '999' }, { SHUTDOWN_TIMEOUT_SECONDS: 'x' }]) {
    assert.throws(() => loadEnv({ ...good, ...bad }), ConfigError, JSON.stringify(bad));
  }
  const c = loadEnv({ ...good, PORT: '0', RETENTION_SYNC_LOG_DAYS: '7', SHUTDOWN_TIMEOUT_SECONDS: '5' });
  assert.equal(c.port, 0);
  assert.equal(c.retention.syncLogDays, 7);
  assert.equal(c.shutdownTimeoutMs, 5000);
});

test('a short or non-hex encryption key is refused', () => {
  for (const k of ['', 'abc', 'zz'.repeat(32), 'ab'.repeat(31)]) assert.throws(() => loadEnv({ ...good, ENCRYPTION_KEY: k }), ConfigError, k);
});

test('database url must be a postgres url', () => {
  for (const u of ['', 'mysql://x', 'localhost:5432/db', 'http://x']) assert.throws(() => loadEnv({ ...good, DATABASE_URL: u }), ConfigError, u);
  assert.doesNotThrow(() => loadEnv({ ...good, DATABASE_URL: 'postgres://u:p@h/db' }));
});

test('ADMIN_PASSWORD: unset = admin off; set = at least 12 characters; the value is never echoed', () => {
  assert.equal(loadEnv(good).adminPassword, null);
  assert.equal(loadEnv({ ...good, ADMIN_PASSWORD: '' }).adminPassword, null);
  assert.equal(loadEnv({ ...good, ADMIN_PASSWORD: 'twelve-chars!' }).adminPassword, 'twelve-chars!');
  try {
    loadEnv({ ...good, ADMIN_PASSWORD: 'short-pw' });
    assert.fail('should throw');
  } catch (e: any) {
    assert.ok(e instanceof ConfigError && e.message.includes('ADMIN_PASSWORD') && !e.message.includes('short-pw'));
  }
});

test('SHOPIFY_API_KEY (the public client id) switches the embedded app page on; unset it is off; a malformed one is rejected by name', () => {
  assert.equal(loadEnv(good).apiKey, null);
  assert.equal(loadEnv({ ...good, SHOPIFY_API_KEY: '' }).apiKey, null);
  assert.equal(loadEnv({ ...good, SHOPIFY_API_KEY: 'a1b2c3d4e5f60718' }).apiKey, 'a1b2c3d4e5f60718');
  for (const bad of ['short', 'has space in it!', '"><script>', 'x'.repeat(200)]) {
    assert.throws(() => loadEnv({ ...good, SHOPIFY_API_KEY: bad }), (e: any) => e instanceof ConfigError && e.message.includes('SHOPIFY_API_KEY') && !e.message.includes(bad), bad);
  }
});
