// Compliance handlers against a REAL Postgres and a real pg-boss queue (throwaway schema per test). Skipped without DATABASE_URL.
// These are the tests that matter most in M4: a redaction must delete everything about the order, nothing about anything else,
// atomically, idempotently, and must leave no personal data behind in its own record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { startQueue } from '../queue/postgresIntake.ts';
import { PostgresEntityStore } from '../queue/postgresEntityStore.ts';
import { PostgresSyncLog } from '../queue/postgresSyncLog.ts';
import { migrate } from '../queue/migrate.ts';
import { WEBHOOK_DEAD_QUEUE, WEBHOOK_QUEUE } from '../queue/config.ts';
import { ComplianceError, handleLifecycleJob } from './handlers.ts';
import type { Job } from '../gateway/types.ts';

const URL = process.env.DATABASE_URL ?? '';
const skip = URL === '' ? 'DATABASE_URL not set' : false;
const A = 'shop-a.myshopify.com';
const B = 'shop-b.myshopify.com';
const gid = (id: number | string) => `gid://shopify/Order/${id}`;
const EMAIL = 'real.customer@example.com';

type Rt = Awaited<ReturnType<typeof startQueue>>;

async function withDb(fn: (c: { rt: Rt; schema: string; deps: { pool: pg.Pool; schema: string; boss: any; now: () => Date } }) => Promise<void>) {
  const schema = `bridge_t_${randomBytes(4).toString('hex')}`;
  const rt = await startQueue({ connectionString: URL, schema });
  try {
    await fn({ rt, schema, deps: { pool: rt.pool, schema, boss: rt.boss, now: () => new Date('2026-10-21T12:00:00.000Z') } });
  } finally {
    await rt.stop().catch(() => {});
    const p = new pg.Pool({ connectionString: URL, max: 1 });
    await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await p.end();
  }
}

const orderJob = (shop: string, order: number, webhookId: string): Job => ({
  webhookId, eventId: 'e', topic: 'orders/paid', shop, apiVersion: '2026-10', businessKey: `orders/paid|${shop}|${gid(order)}`,
  receivedAt: '2026-10-21T00:00:00.000Z', payload: JSON.stringify({ admin_graphql_api_id: gid(order), customer: { email: EMAIL, last_name: 'Realname' } }),
});

const lifecycle = (topic: string, shop: string, orders: string[], webhookId: string, requestId: string | null = null): Job => ({
  webhookId, eventId: 'e', topic, shop, apiVersion: '2026-10', businessKey: webhookId, receivedAt: '2026-10-21T00:00:00.000Z',
  payload: JSON.stringify({ topic, shopDomain: shop, orders, requestId }),
});

async function count(pool: pg.Pool, schema: string, table: string, where = 'true', vals: unknown[] = []) {
  return (await pool.query(`SELECT count(*)::int AS n FROM ${schema}.${table} WHERE ${where}`, vals)).rows[0].n as number;
}
const queueJobs = async (rt: Rt, queue: string, shop?: string) => ((await rt.boss.findJobs(queue, { limit: 1000 } as any)) as any[]).filter((j) => !shop || j.data?.shop === shop);

// Seeds two shops with orders, logs, mappings, deliveries, queued and dead jobs, config, credentials and audit.
async function seed(c: { rt: Rt; schema: string }) {
  const { rt, schema } = c;
  const log = new PostgresSyncLog(rt.pool, schema);
  const entities = new PostgresEntityStore(rt.pool, schema);
  const entry = (shop: string, order: number, outcome = 'created') => ({ at: '2026-10-20T10:00:00.000Z', shop, recipeId: 'r1', topic: 'orders/paid', objectId: gid(order), webhookId: `w${order}`, outcome: outcome as any, dryRun: false, ops: [{ kind: 'createLead', outcome: 'created', sfId: `00Q${order}` }] });
  for (const [shop, order] of [[A, 1001], [A, 1002], [B, 2001]] as const) {
    await log.record(entry(shop, order));
    await entities.put(`r1:${gid(order)}`, { type: order === 1002 ? 'Task' : 'Lead', id: `${order === 1002 ? '00T' : '00Q'}${order}` }, shop);
    assert.equal(await rt.intake.accept(orderJob(shop, order, `wh-${order}`)), 'accepted');
  }
  // a legacy mapping written before the shop column existed
  await rt.pool.query(`INSERT INTO ${schema}.entity_map (match_key, sf_type, sf_id, shop) VALUES ($1, 'Lead', '00Q1003', NULL)`, [`r1:${gid(1003)}`]);
  await log.record(entry(A, 1003));
  // a dead-lettered job for order 1001 (holds the payload for 7 days)
  await rt.boss.send(WEBHOOK_DEAD_QUEUE, orderJob(A, 1001, 'wh-dead-1001'));
  for (const shop of [A, B]) {
    await rt.pool.query(`INSERT INTO ${schema}.recipe_config (shop, recipe_id, enabled, dry_run, config) VALUES ($1, 'r1', true, false, '{"leadSource":"x"}')`, [shop]);
    await rt.pool.query(`INSERT INTO ${schema}.salesforce_connection (shop, login_url, client_id, client_secret_enc) VALUES ($1, 'https://o', 'cid', 'v1:x:y:z')`, [shop]);
    await rt.pool.query(`INSERT INTO ${schema}.admin_audit (at, action, shop) VALUES (now(), 'config_saved', $1)`, [shop]);
  }
}

const snapshot = async (rt: Rt, schema: string, shop: string) => ({
  syncLog: await count(rt.pool, schema, 'sync_log', 'shop = $1', [shop]),
  entityMap: await count(rt.pool, schema, 'entity_map', 'shop = $1', [shop]),
  intake: await count(rt.pool, schema, 'webhook_intake', 'shop = $1', [shop]),
  recipe: await count(rt.pool, schema, 'recipe_config', 'shop = $1', [shop]),
  connection: await count(rt.pool, schema, 'salesforce_connection', 'shop = $1', [shop]),
  audit: await count(rt.pool, schema, 'admin_audit', 'shop = $1', [shop]),
  main: (await queueJobs(rt, WEBHOOK_QUEUE, shop)).length,
  dead: (await queueJobs(rt, WEBHOOK_DEAD_QUEUE, shop)).length,
});

// ---- customers/redact -----------------------------------------------------------------------------------------
test('customers/redact deletes everything about the listed orders and NOTHING else', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const bShop = await snapshot(c.rt, c.schema, B);
    const out: any = await handleLifecycleJob(lifecycle('customers/redact', A, ['1001'], 'wh-redact-1'), c.deps);
    assert.deepEqual(out, { syncLog: 1, entityMap: 1, intake: 1, queueJobs: 2 });
    // order 1001 is gone from every table and from both queues...
    assert.equal(await count(c.rt.pool, c.schema, 'sync_log', 'object_id = $1', [gid(1001)]), 0);
    assert.equal(await count(c.rt.pool, c.schema, 'entity_map', 'match_key = $1', [`r1:${gid(1001)}`]), 0);
    assert.equal(await count(c.rt.pool, c.schema, 'webhook_intake', 'business_key = $1', [`orders/paid|${A}|${gid(1001)}`]), 0);
    for (const q of [WEBHOOK_QUEUE, WEBHOOK_DEAD_QUEUE]) assert.ok(!(await queueJobs(c.rt, q)).some((j: any) => j.data?.businessKey?.endsWith(gid(1001))), q);
    // ...but the other order of the same shop, the legacy row, and the other shop are untouched
    assert.equal(await count(c.rt.pool, c.schema, 'sync_log', 'object_id = $1', [gid(1002)]), 1);
    assert.equal(await count(c.rt.pool, c.schema, 'entity_map', 'match_key = $1', [`r1:${gid(1002)}`]), 1);
    assert.equal(await count(c.rt.pool, c.schema, 'entity_map', 'match_key = $1', [`r1:${gid(1003)}`]), 1);
    assert.equal((await queueJobs(c.rt, WEBHOOK_QUEUE, A)).length, 1);
    assert.deepEqual(await snapshot(c.rt, c.schema, B), bShop, 'shop B is completely untouched');
    assert.equal(await count(c.rt.pool, c.schema, 'recipe_config', 'shop = $1', [A]), 1, 'settings and credentials are NOT removed by a customer redaction');
    assert.equal(await count(c.rt.pool, c.schema, 'salesforce_connection', 'shop = $1', [A]), 1);
  });
});

test('customers/redact records a non-personal compliance entry that lists the Salesforce records to review', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    await handleLifecycleJob(lifecycle('customers/redact', A, ['1001', '1002'], 'wh-redact-2'), c.deps);
    const rows = (await c.rt.pool.query(`SELECT kind, shop, request_ref, detail FROM ${c.schema}.compliance_log`)).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].kind, rows[0].shop, rows[0].request_ref], ['customers/redact', A, 'wh-redact-2']);
    assert.equal(rows[0].detail.orders, 2);
    assert.deepEqual([...rows[0].detail.salesforceRecordsToReview].sort(), ['Lead:00Q1001', 'Task:00T1002']);
    const text = JSON.stringify(rows[0]);
    for (const leak of [EMAIL, 'Realname', 'real.customer']) assert.ok(!text.includes(leak), `personal data in the compliance record: ${leak}`);
  });
});

test('customers/redact also removes a legacy mapping that has no shop recorded, when its order is listed', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const out: any = await handleLifecycleJob(lifecycle('customers/redact', A, ['1003'], 'wh-redact-3'), c.deps);
    assert.equal(out.entityMap, 1);
    assert.equal(await count(c.rt.pool, c.schema, 'entity_map', 'match_key = $1', [`r1:${gid(1003)}`]), 0);
    assert.equal(out.syncLog, 1);
  });
});

test('customers/redact is idempotent: a retry deletes nothing more and records nothing twice', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    await handleLifecycleJob(lifecycle('customers/redact', A, ['1001'], 'wh-redact-4'), c.deps);
    const again: any = await handleLifecycleJob(lifecycle('customers/redact', A, ['1001'], 'wh-redact-4'), c.deps);
    assert.deepEqual(again, { syncLog: 0, entityMap: 0, intake: 0, queueJobs: 0 });
    assert.equal(await count(c.rt.pool, c.schema, 'compliance_log'), 1);
    assert.equal(await count(c.rt.pool, c.schema, 'sync_log', 'shop = $1', [A]), 2);
  });
});

test('customers/redact is ATOMIC: if any step fails nothing is deleted and nothing is recorded', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const before = await snapshot(c.rt, c.schema, A);
    const brokenBoss = new Proxy(c.rt.boss, { get: (t: any, p) => (p === 'deleteJob' ? async () => { throw new Error('queue down'); } : t[p].bind ? t[p].bind(t) : t[p]) });
    await assert.rejects(() => handleLifecycleJob(lifecycle('customers/redact', A, ['1001'], 'wh-redact-5'), { ...c.deps, boss: brokenBoss }), /queue down/);
    assert.deepEqual(await snapshot(c.rt, c.schema, A), before, 'the database delete was rolled back along with the failure');
    assert.equal(await count(c.rt.pool, c.schema, 'compliance_log'), 0);
    // and a retry with a healthy queue then succeeds
    const ok: any = await handleLifecycleJob(lifecycle('customers/redact', A, ['1001'], 'wh-redact-5'), c.deps);
    assert.equal(ok.syncLog, 1);
  });
});

test('a request with no orders, or only unknown orders, deletes nothing but is still recorded', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const before = await snapshot(c.rt, c.schema, A);
    assert.deepEqual(await handleLifecycleJob(lifecycle('customers/redact', A, [], 'wh-empty'), c.deps), { syncLog: 0, entityMap: 0, intake: 0, queueJobs: 0 });
    assert.deepEqual(await handleLifecycleJob(lifecycle('customers/redact', A, ['999999'], 'wh-unknown'), c.deps), { syncLog: 0, entityMap: 0, intake: 0, queueJobs: 0 });
    assert.deepEqual(await snapshot(c.rt, c.schema, A), before);
    assert.equal(await count(c.rt.pool, c.schema, 'compliance_log'), 2);
  });
});

test('a large request (3000 orders) completes, parameterised, in one go', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const orders = Array.from({ length: 3000 }, (_, i) => String(5000 + i));
    orders.push('1001');
    const out: any = await handleLifecycleJob(lifecycle('customers/redact', A, orders, 'wh-big'), c.deps);
    assert.equal(out.syncLog, 1);
  });
});

test('hostile shop strings are bound parameters: nothing is injected and no table is touched', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const before = await snapshot(c.rt, c.schema, A);
    const evil = `x.myshopify.com'; DROP TABLE ${c.schema}.sync_log; --`;
    const out: any = await handleLifecycleJob(lifecycle('customers/redact', evil, ['1001'], 'wh-evil'), c.deps);
    assert.equal(out.syncLog, 0);
    assert.deepEqual(await snapshot(c.rt, c.schema, A), before);
    assert.equal(await count(c.rt.pool, c.schema, 'sync_log'), 4, 'the table still exists with all its rows');
  });
});

// ---- customers/data_request -------------------------------------------------------------------------------------
test('customers/data_request reports what we hold, deletes nothing, and the report holds no personal data', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const before = await snapshot(c.rt, c.schema, A);
    const held: any = await handleLifecycleJob(lifecycle('customers/data_request', A, ['1001', '1002'], 'wh-dr-1', '9999'), c.deps);
    assert.deepEqual(held, { syncLogEntries: 2, salesforceRecordMappings: 2, deliveryRecords: 2, queuedJobsWithRawPayload: 3 });
    assert.deepEqual(await snapshot(c.rt, c.schema, A), before, 'nothing was deleted');
    const row = (await c.rt.pool.query(`SELECT detail FROM ${c.schema}.compliance_log WHERE kind = 'customers/data_request'`)).rows[0].detail;
    assert.equal(row.dataRequestId, '9999');
    assert.equal(row.requestedOrders, 2);
    const o1 = row.orders.find((o: any) => o.shopifyOrderId === '1001');
    assert.deepEqual(o1.salesforceRecords, ['Lead:00Q1001']);
    assert.deepEqual(o1.syncLog.map((e: any) => e.outcome), ['created']);
    const text = JSON.stringify(row);
    for (const leak of [EMAIL, 'Realname', 'real.customer']) assert.ok(!text.includes(leak), leak);
  });
});

test('customers/data_request for unknown orders reports zeros', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const held: any = await handleLifecycleJob(lifecycle('customers/data_request', A, ['424242'], 'wh-dr-2'), c.deps);
    assert.deepEqual(held, { syncLogEntries: 0, salesforceRecordMappings: 0, deliveryRecords: 0, queuedJobsWithRawPayload: 0 });
  });
});

// ---- shop/redact ------------------------------------------------------------------------------------------------
test('shop/redact erases everything for the shop, credentials included, and leaves other shops and the running job alone', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    await c.rt.pool.query(`INSERT INTO ${c.schema}.compliance_log (at, kind, shop, request_ref, detail) VALUES (now(), 'customers/redact', $1, 'old-ref', '{}'::jsonb), (now(), 'customers/redact', $2, 'other-ref', '{}'::jsonb)`, [A, B]);
    const bShop = await snapshot(c.rt, c.schema, B);
    const job = lifecycle('shop/redact', A, [], 'wh-shop-redact');
    assert.equal(await c.rt.intake.accept(job), 'accepted'); // the job that is "running" sits in the queue like in production
    const out: any = await handleLifecycleJob(job, c.deps);
    assert.deepEqual({ ...out, queueJobs: undefined }, { syncLog: 3, entityMap: 2, intake: 2, recipeConfig: 1, salesforceConnection: 1, adminAudit: 1, earlierComplianceRecords: 1, queueJobs: undefined });
    assert.equal(out.queueJobs, 3, 'two queued order jobs and the dead-lettered one');
    assert.deepEqual(await snapshot(c.rt, c.schema, A), { syncLog: 0, entityMap: 0, intake: 1, recipe: 0, connection: 0, audit: 0, main: 1, dead: 0 });
    assert.equal(await count(c.rt.pool, c.schema, 'webhook_intake', 'shop = $1 AND topic = $2', [A, 'shop/redact']), 1, 'the erase request\'s own delivery record is kept so a retry cannot re-run it');
    assert.equal((await queueJobs(c.rt, WEBHOOK_QUEUE, A))[0].data.topic, 'shop/redact', 'the running compliance job itself was not deleted');
    assert.deepEqual(await snapshot(c.rt, c.schema, B), bShop, 'shop B untouched');
    const log = (await c.rt.pool.query(`SELECT kind, shop, request_ref FROM ${c.schema}.compliance_log ORDER BY id`)).rows;
    assert.deepEqual(log.map((r) => `${r.kind}|${r.shop}|${r.request_ref}`), [`customers/redact|${B}|other-ref`, `shop/redact|${A}|wh-shop-redact`], 'only the record of the erasure itself is left for shop A');
    assert.equal(await count(c.rt.pool, c.schema, 'entity_map', 'match_key = $1', [`r1:${gid(1003)}`]), 1, 'a legacy mapping without a shop cannot be attributed; it ages out with the retention window');
  });
});

test('shop/redact is idempotent', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    await handleLifecycleJob(lifecycle('shop/redact', A, [], 'wh-sr-2'), c.deps);
    const again: any = await handleLifecycleJob(lifecycle('shop/redact', A, [], 'wh-sr-2'), c.deps);
    assert.equal(again.syncLog + again.entityMap + again.intake + again.recipeConfig + again.salesforceConnection + again.queueJobs, 0);
    assert.equal(await count(c.rt.pool, c.schema, 'compliance_log', 'kind = $1', ['shop/redact']), 1);
  });
});

// ---- app/uninstalled --------------------------------------------------------------------------------------------
test('app/uninstalled disables the recipes, deletes the credentials and queued jobs, and keeps the data until shop/redact', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const bShop = await snapshot(c.rt, c.schema, B);
    const job = lifecycle('app/uninstalled', A, [], 'wh-un-1');
    await c.rt.intake.accept(job);
    const out: any = await handleLifecycleJob(job, c.deps);
    assert.deepEqual(out, { recipesDisabled: 1, credentialsDeleted: 1, queueJobs: 3 });
    const r = (await c.rt.pool.query(`SELECT enabled, config FROM ${c.schema}.recipe_config WHERE shop = $1`, [A])).rows[0];
    assert.equal(r.enabled, false);
    assert.deepEqual(r.config, { leadSource: 'x' }, 'the settings are kept, only switched off');
    assert.equal(await count(c.rt.pool, c.schema, 'salesforce_connection', 'shop = $1', [A]), 0);
    const s = await snapshot(c.rt, c.schema, A);
    assert.deepEqual([s.syncLog, s.entityMap, s.intake, s.dead], [3, 2, 3, 0], 'the log, mappings and delivery records stay until shop/redact (3 deliveries = 2 orders + this request)');
    assert.equal(s.main, 1, 'only the running uninstall job remains in the queue');
    assert.deepEqual(await snapshot(c.rt, c.schema, B), bShop);
    assert.equal(await count(c.rt.pool, c.schema, 'compliance_log', 'kind = $1', ['app/uninstalled']), 1);
  });
});

test('app/uninstalled twice is harmless', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    await handleLifecycleJob(lifecycle('app/uninstalled', A, [], 'wh-un-2'), c.deps);
    assert.deepEqual(await handleLifecycleJob(lifecycle('app/uninstalled', A, [], 'wh-un-2'), c.deps), { recipesDisabled: 0, credentialsDeleted: 0, queueJobs: 0 });
  });
});

// ---- input checks -------------------------------------------------------------------------------------------------
test('malformed or inconsistent lifecycle jobs are refused before touching the database', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    const before = await snapshot(c.rt, c.schema, A);
    const good = lifecycle('customers/redact', A, ['1001'], 'wh-x');
    const bad: Job[] = [
      { ...good, payload: 'not json' },
      { ...good, payload: JSON.stringify({ topic: 'shop/redact', shopDomain: A, orders: [], requestId: null }) },
      { ...good, payload: JSON.stringify({ topic: 'customers/redact', shopDomain: B, orders: ['1001'], requestId: null }) },
      { ...good, payload: JSON.stringify({ topic: 'customers/redact', shopDomain: A, orders: ['1001; DROP'], requestId: null }) },
      { ...good, payload: JSON.stringify({ topic: 'customers/redact', shopDomain: A, orders: 'all', requestId: null }) },
      { ...good, topic: 'orders/paid', payload: JSON.stringify({ topic: 'orders/paid', shopDomain: A, orders: [], requestId: null }) },
    ];
    for (const j of bad) await assert.rejects(() => handleLifecycleJob(j, c.deps), ComplianceError);
    assert.deepEqual(await snapshot(c.rt, c.schema, A), before);
    assert.equal(await count(c.rt.pool, c.schema, 'compliance_log'), 0);
  });
});

// ---- migration backfill ---------------------------------------------------------------------------------------------
test('migration 007 backfills entity_map.shop from the sync log for rows written before the column existed', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    const log = new PostgresSyncLog(c.rt.pool, c.schema);
    await log.record({ at: '2026-10-20T10:00:00.000Z', shop: A, recipeId: 'r1', topic: 'orders/paid', objectId: gid(7001), webhookId: 'w', outcome: 'created', dryRun: false });
    await c.rt.pool.query(`INSERT INTO ${c.schema}.entity_map (match_key, sf_type, sf_id, shop) VALUES ($1, 'Lead', '00Q7001', NULL), ($2, 'Lead', '00Q7002', NULL)`, [`r1:${gid(7001)}`, `r1:${gid(7002)}`]);
    await migrate(c.rt.pool, c.schema); // running the migrations again is safe and fills what it can
    const rows = (await c.rt.pool.query(`SELECT match_key, shop FROM ${c.schema}.entity_map ORDER BY match_key`)).rows;
    assert.deepEqual(rows.map((r) => r.shop), [A, null], 'known order gets its shop, the unknown one stays NULL');
  });
});

test('every delete is scoped to the requesting shop: the SAME order id under another shop is untouched (defence in depth)', { skip, timeout: 60_000 }, async () => {
  await withDb(async (c) => {
    await seed(c);
    // an artificial collision: shop B has rows for an order id that shop A is about to redact
    const log = new PostgresSyncLog(c.rt.pool, c.schema);
    await log.record({ at: '2026-10-20T10:00:00.000Z', shop: B, recipeId: 'r1', topic: 'orders/paid', objectId: gid(1001), webhookId: 'wB', outcome: 'created', dryRun: false });
    await new PostgresEntityStore(c.rt.pool, c.schema).put(`r1:${gid(1001)}-B`, { type: 'Lead', id: '00QB1001' }, B);
    await c.rt.pool.query(`INSERT INTO ${c.schema}.entity_map (match_key, sf_type, sf_id, shop) VALUES ($1, 'Lead', '00QBX', $2)`, [`r2:${gid(1001)}`, B]);
    await c.rt.pool.query(`INSERT INTO ${c.schema}.webhook_intake (webhook_id, business_key, topic, shop, received_at) VALUES ('wh-b-1001', $1, 'orders/paid', $2, now())`, [`orders/paid|${B}|${gid(1001)}`, B]);
    await c.rt.boss.send(WEBHOOK_QUEUE, orderJob(B, 1001, 'wh-b-queue-1001'));
    const bBefore = await snapshot(c.rt, c.schema, B);
    await handleLifecycleJob(lifecycle('customers/redact', A, ['1001'], 'wh-scope'), c.deps);
    assert.deepEqual(await snapshot(c.rt, c.schema, B), bBefore, 'nothing of shop B was deleted');
    assert.equal(await count(c.rt.pool, c.schema, 'sync_log', 'shop = $1 AND object_id = $2', [B, gid(1001)]), 1);
    assert.equal(await count(c.rt.pool, c.schema, 'entity_map', 'shop = $1 AND sf_id = $2', [B, '00QBX']), 1);
  });
});
