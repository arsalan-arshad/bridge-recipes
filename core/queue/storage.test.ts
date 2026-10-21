// Integration tests (real Postgres): sync log, retention and the encrypted connection store.
// Skipped without DATABASE_URL. Each test uses its own throwaway schema, dropped afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { startQueue } from './postgresIntake.ts';
import { PostgresSyncLog, scrubEmails } from './postgresSyncLog.ts';
import { PostgresConnectionStore } from './postgresConnectionStore.ts';
import { PostgresEntityStore } from './postgresEntityStore.ts';
import { DEFAULT_RETENTION, purgeExpired } from './retention.ts';
import { CryptoError } from '../crypto/secretBox.ts';
import type { LogEntry } from '../worker/syncLog.ts';

const URL = process.env.DATABASE_URL ?? '';
const skip = URL === '' ? 'DATABASE_URL not set' : false;

async function withDb(fn: (rt: Awaited<ReturnType<typeof startQueue>>, schema: string) => Promise<void>) {
  const schema = `bridge_t_${randomBytes(4).toString('hex')}`;
  const rt = await startQueue({ connectionString: URL, schema });
  try {
    await fn(rt, schema);
  } finally {
    await rt.stop().catch(() => {});
    const p = new pg.Pool({ connectionString: URL, max: 1 });
    await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await p.end();
  }
}

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  at: '2026-10-21T10:00:00.000Z', shop: 's.myshopify.com', recipeId: 'r1', topic: 'orders/paid', objectId: 'gid://shopify/Order/1',
  webhookId: 'wh-1', outcome: 'created', dryRun: false, ...over,
});

// ---- sync log ------------------------------------------------------------------------------------------
test('scrubEmails masks raw addresses and leaves already-masked ones alone', () => {
  assert.equal(scrubEmails('mail bob.smith@acme.com now'), 'mail b***@acme.com now');
  assert.equal(scrubEmails('t***@example.com stays'), 't***@example.com stays');
  assert.equal(scrubEmails('{"Email":"zed@x.io","n":"a***@b.io"}'), '{"Email":"z***@x.io","n":"a***@b.io"}');
  assert.equal(scrubEmails('no address here'), 'no address here');
});

test('sync log: a recorded entry reads back identically, newest first, filterable', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const log = new PostgresSyncLog(rt.pool, schema);
    await log.record(entry({ at: '2026-10-21T10:00:00.000Z', outcome: 'created', ops: [{ kind: 'createLead', outcome: 'created', sfId: '00Qaaaaaaaaaaaa1' }] }));
    await log.record(entry({ at: '2026-10-21T11:00:00.000Z', outcome: 'retry', errorClass: 'transient', errorCode: 'SERVER_UNAVAILABLE', webhookId: 'wh-2' }));
    await log.record(entry({ at: '2026-10-21T12:00:00.000Z', outcome: 'skipped', reason: 'no_consent', shop: 'other.myshopify.com', webhookId: 'wh-3' }));
    const all = await log.recent();
    assert.deepEqual(all.map((e) => e.webhookId), ['wh-3', 'wh-2', 'wh-1']);
    assert.deepEqual(all[2], entry({ ops: [{ kind: 'createLead', outcome: 'created', sfId: '00Qaaaaaaaaaaaa1' }] }));
    assert.equal(all[1].errorClass, 'transient');
    assert.equal(all[0].reason, 'no_consent');
    assert.deepEqual((await log.recent({ shop: 's.myshopify.com' })).map((e) => e.webhookId), ['wh-2', 'wh-1']);
    assert.deepEqual((await log.recent({ outcome: 'retry' })).map((e) => e.webhookId), ['wh-2']);
    assert.equal((await log.recent({ limit: 1 })).length, 1);
  });
});

test('sync log: a raw email or last name that slips into an entry is masked before it is stored', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const log = new PostgresSyncLog(rt.pool, schema);
    await log.record(entry({ errorCode: 'INVALID_EMAIL: bob.smith@acme.com', ops: [{ kind: 'createLead', outcome: 'planned', planned: { fields: { Email: 'bob.smith@acme.com', Company: 'Acme' } } }] }));
    const raw = (await rt.pool.query(`SELECT row_to_json(t)::text AS j FROM ${schema}.sync_log t`)).rows[0].j as string;
    assert.ok(!raw.includes('bob.smith'), 'no raw local part in the stored row');
    assert.ok(raw.includes('b***@acme.com'));
    assert.ok(raw.includes('Acme'));
  });
});

test('sync log: parameters are bound, not interpolated (quotes and semicolons are stored literally)', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const log = new PostgresSyncLog(rt.pool, schema);
    await log.record(entry({ reason: "x'; DROP TABLE sync_log; --" }));
    assert.equal((await log.recent())[0].reason, "x'; DROP TABLE sync_log; --");
    assert.equal((await log.recent()).length, 1);
  });
});

// ---- retention -----------------------------------------------------------------------------------------
test('retention deletes only rows older than each window and reports counts', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const NOW = new Date('2026-10-21T12:00:00.000Z');
    const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
    const log = new PostgresSyncLog(rt.pool, schema);
    await log.record(entry({ at: day(31), webhookId: 'old' }));
    await log.record(entry({ at: day(29), webhookId: 'recent' }));
    for (const [id, days] of [['old', 15], ['new', 13]] as const) {
      await rt.pool.query(`INSERT INTO ${schema}.webhook_intake (webhook_id, business_key, topic, shop, received_at) VALUES ($1, $1, 't', 's', $2)`, [id, day(days)]);
    }
    const entities = new PostgresEntityStore(rt.pool, schema);
    await entities.put('r1:old', { type: 'Lead', id: '1' }, 's.myshopify.com');
    await entities.put('r1:new', { type: 'Lead', id: '2' }, 's.myshopify.com');
    await rt.pool.query(`UPDATE ${schema}.entity_map SET created_at = $1 WHERE match_key = 'r1:old'`, [day(31)]);

    assert.deepEqual(await purgeExpired(rt.pool, schema, NOW), { syncLog: 1, intake: 1, entityMap: 1, adminAudit: 0, complianceLog: 0 });
    assert.deepEqual((await log.recent()).map((e) => e.webhookId), ['recent']);
    assert.equal((await rt.pool.query(`SELECT webhook_id FROM ${schema}.webhook_intake`)).rows[0].webhook_id, 'new');
    assert.equal(await entities.get('r1:old'), null);
    assert.notEqual(await entities.get('r1:new'), null);
    assert.deepEqual(await purgeExpired(rt.pool, schema, NOW), { syncLog: 0, intake: 0, entityMap: 0, adminAudit: 0, complianceLog: 0 }, 'idempotent');
  });
});

test('retention boundary: exactly at the window is kept; invalid windows are rejected before any delete', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const NOW = new Date('2026-10-21T12:00:00.000Z');
    const log = new PostgresSyncLog(rt.pool, schema);
    await log.record(entry({ at: new Date(NOW.getTime() - DEFAULT_RETENTION.syncLogDays * 86_400_000).toISOString(), webhookId: 'edge' }));
    assert.equal((await purgeExpired(rt.pool, schema, NOW)).syncLog, 0);
    for (const bad of [0, -1, NaN]) await assert.rejects(() => purgeExpired(rt.pool, schema, NOW, { ...DEFAULT_RETENTION, syncLogDays: bad }), /at least 1 day/);
    assert.equal((await log.recent()).length, 1);
  });
});

// ---- encrypted connection store ------------------------------------------------------------------------
const CONN = { loginUrl: 'https://org.my.salesforce.com', clientId: 'CLIENT-ID-123', clientSecret: 'S3CR3T-sf-client-secret-VALUE' };

test('connection store: the secret round-trips but is NEVER stored in plaintext', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const store = new PostgresConnectionStore(rt.pool, schema, randomBytes(32));
    await store.put('s.myshopify.com', CONN);
    assert.deepEqual(await store.get('s.myshopify.com'), CONN);
    const raw = (await rt.pool.query(`SELECT row_to_json(t)::text AS j FROM ${schema}.salesforce_connection t`)).rows[0].j as string;
    assert.ok(!raw.includes(CONN.clientSecret), 'plaintext secret must not be in the table');
    assert.ok(raw.includes('"client_secret_enc":"v1:'));
    assert.ok(raw.includes(CONN.clientId), 'the (non-secret) client id is plain');
    assert.equal(await store.get('unknown.myshopify.com'), null);
  });
});

test('connection store: wrong key fails; a secret copied to another shop does not decrypt; update replaces and clears verification', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const key = randomBytes(32);
    const store = new PostgresConnectionStore(rt.pool, schema, key);
    await store.put('a.myshopify.com', CONN);
    await assert.rejects(() => new PostgresConnectionStore(rt.pool, schema, randomBytes(32)).get('a.myshopify.com'), CryptoError);

    await rt.pool.query(`INSERT INTO ${schema}.salesforce_connection (shop, login_url, client_id, client_secret_enc)
      SELECT 'b.myshopify.com', login_url, client_id, client_secret_enc FROM ${schema}.salesforce_connection WHERE shop = 'a.myshopify.com'`);
    await assert.rejects(() => store.get('b.myshopify.com'), CryptoError, 'ciphertext moved to another shop');

    await store.markVerified('a.myshopify.com', new Date('2026-10-21T12:00:00Z'));
    assert.notEqual((await rt.pool.query(`SELECT last_verified_at FROM ${schema}.salesforce_connection WHERE shop = 'a.myshopify.com'`)).rows[0].last_verified_at, null);
    await store.put('a.myshopify.com', { ...CONN, clientSecret: 'rotated-secret' });
    assert.equal((await store.get('a.myshopify.com'))!.clientSecret, 'rotated-secret');
    assert.equal((await rt.pool.query(`SELECT last_verified_at FROM ${schema}.salesforce_connection WHERE shop = 'a.myshopify.com'`)).rows[0].last_verified_at, null, 'a new secret must be re-verified');
  });
});

// ---- per-shop recipe settings on Postgres -------------------------------------------------------------
import { PostgresConfigStore } from './postgresConfigStore.ts';
import { validateR1Config } from '../../recipes/retail-b2b-lead-spotter/validateConfig.ts';
import { R1_DEFAULT_CONFIG, R1_ID } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';

test('config store: no row = disabled; set stores validated config; a new recipe is DRY-RUN unless explicitly false', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const store = new PostgresConfigStore(rt.pool, schema, { [R1_ID]: validateR1Config });
    assert.equal(await store.get('s.myshopify.com', R1_ID), null);
    await store.set('s.myshopify.com', R1_ID, { enabled: true, config: R1_DEFAULT_CONFIG });
    assert.deepEqual(await store.get('s.myshopify.com', R1_ID), { enabled: true, dryRun: true, config: R1_DEFAULT_CONFIG });
    await store.set('s.myshopify.com', R1_ID, { enabled: true, dryRun: false, config: { ...R1_DEFAULT_CONFIG, minOrderTotal: 25 } });
    const live = await store.get('s.myshopify.com', R1_ID);
    assert.deepEqual([live!.dryRun, (live!.config as any).minOrderTotal], [false, 25]);
    assert.equal(await store.get('other.myshopify.com', R1_ID), null, 'settings are per shop');
    assert.equal(await store.get('s.myshopify.com', 'unknown-recipe'), null);
  });
});

test('config store: the kill switch (disable) takes effect immediately and keeps the config', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const store = new PostgresConfigStore(rt.pool, schema, { [R1_ID]: validateR1Config });
    await store.set('s.myshopify.com', R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    assert.equal(await store.disable('s.myshopify.com', R1_ID), true);
    const s = await store.get('s.myshopify.com', R1_ID);
    assert.equal(s!.enabled, false);
    assert.deepEqual(s!.config, R1_DEFAULT_CONFIG);
    assert.equal(await store.disable('nobody.myshopify.com', R1_ID), false);
  });
});

test('config store: an invalid config is rejected on write and nothing is stored; an invalid STORED config fails closed on read', { skip }, async () => {
  await withDb(async (rt, schema) => {
    const flagged: string[] = [];
    const store = new PostgresConfigStore(rt.pool, schema, { [R1_ID]: validateR1Config }, (s, r) => flagged.push(`${s}|${r}`));
    await assert.rejects(() => store.set('s.myshopify.com', R1_ID, { enabled: true, config: { ...R1_DEFAULT_CONFIG, minOrderTotal: -5 } }), /minOrderTotal/);
    await assert.rejects(() => store.set('s.myshopify.com', 'nope', { enabled: true, config: {} }), /unknown recipe/);
    assert.equal((await rt.pool.query(`SELECT count(*)::int AS n FROM ${schema}.recipe_config`)).rows[0].n, 0);
    // simulate a corrupted row (e.g. edited by hand): enabled, live, but invalid config
    await rt.pool.query(`INSERT INTO ${schema}.recipe_config (shop, recipe_id, enabled, dry_run, config) VALUES ('s.myshopify.com', $1, true, false, '{"leadSource": 5}')`, [R1_ID]);
    assert.equal(await store.get('s.myshopify.com', R1_ID), null, 'invalid stored config = recipe disabled, not defaults');
    assert.deepEqual(flagged, [`s.myshopify.com|${R1_ID}`]);
  });
});
