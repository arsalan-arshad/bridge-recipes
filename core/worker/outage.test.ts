// M1 test: "Salesforce outage and recovery" (docs/BUILD_PLAN.md), end to end on a REAL Postgres:
//   signed webhook -> gateway -> atomic intake -> pg-boss -> worker -> processJob -> (fake, switchable) Salesforce.
// Acceptance (docs/SPEC.md section 9): "Salesforce down for an hour -> jobs retry, then succeed after recovery;
// nothing lost, nothing duplicated." Skipped without DATABASE_URL. Salesforce is faked; the database and queue are real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { handleWebhook } from '../gateway/handleWebhook.ts';
import { startQueue } from '../queue/postgresIntake.ts';
import { PostgresEntityStore } from '../queue/postgresEntityStore.ts';
import { WEBHOOK_DEAD_QUEUE, WEBHOOK_QUEUE } from '../queue/config.ts';
import type { RetryPolicy } from '../queue/config.ts';
import { startWorker } from './startWorker.ts';
import { MemoryConfigStore } from './recipe.ts';
import { MemorySyncLog } from './syncLog.ts';
import { SalesforceError } from '../salesforce/client.ts';
import { r1Recipe, R1_DEFAULT_CONFIG, R1_ID } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';

const URL = process.env.DATABASE_URL ?? '';
const skip = URL === '' ? 'DATABASE_URL not set' : false;
const FAST: RetryPolicy = { retryLimit: 2, retryDelaySeconds: 1, retryDelayMaxSeconds: 2, completedRetentionSeconds: 3600, deadRetentionSeconds: 3600, expireInSeconds: 60 };
const SECRET = 'test-signing-secret';
const SHOP = 'example-store.myshopify.com';
const BODY = readFileSync(join(import.meta.dirname, '..', '..', 'recipes', 'retail-b2b-lead-spotter', 'payloads', 'SHOPIFY_real_orders_paid_2026-10_subscribed.json'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 40_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await cond()) return;
    await sleep(250);
  }
  throw new Error('timed out waiting for condition');
}

async function scenario(fn: (c: Awaited<ReturnType<typeof build>>) => Promise<void>) {
  const c = await build();
  try {
    await fn(c);
  } finally {
    await c.rt.stop().catch(() => {});
    const p = new pg.Pool({ connectionString: URL, max: 1 });
    await p.query(`DROP SCHEMA IF EXISTS ${c.schema} CASCADE`);
    await p.end();
  }
}

async function build() {
  const schema = `bridge_t_${randomBytes(4).toString('hex')}`;
  const rt = await startQueue({ connectionString: URL, schema, policy: FAST });
  const state = { down: false, creates: 0, queries: 0 };
  const sf = {
    async query(soql: string) {
      state.queries++;
      if (state.down) throw new SalesforceError('transient', 503, 'SERVER_UNAVAILABLE', 'Salesforce unavailable');
      void soql;
      return [];
    },
    async create(type: string) {
      if (state.down) throw new SalesforceError('transient', 503, 'SERVER_UNAVAILABLE', 'Salesforce unavailable');
      state.creates++;
      return { id: `${type[0]}${String(state.creates).padStart(14, '0')}` };
    },
    async update() { if (state.down) throw new SalesforceError('transient', 503, 'SERVER_UNAVAILABLE', 'x'); },
    async getRecord() { return {}; },
  };
  const configs = new MemoryConfigStore();
  configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
  const log = new MemorySyncLog();
  const entities = new PostgresEntityStore(rt.pool, schema);
  const deps = { recipes: [r1Recipe], configs, sf, entities, log, now: () => new Date() };
  const gw = { secret: SECRET, intake: rt.intake, topics: new Set(['orders/paid']), now: () => new Date(), log: () => {} };
  const deliver = (webhookId = 'wh-1') =>
    handleWebhook({
      rawBody: BODY,
      headers: {
        'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(BODY).digest('base64'),
        'x-shopify-topic': 'orders/paid', 'x-shopify-shop-domain': SHOP, 'x-shopify-webhook-id': webhookId,
      },
    }, gw);
  const count = (queue: string) => rt.pool.query(`SELECT count(*)::int AS n FROM ${schema}.job WHERE name = $1`, [queue]).then((r) => r.rows[0].n as number);
  return { rt, schema, state, log, deps, deliver, count };
}

test('Salesforce down at first, then back: the job retries and succeeds ONCE; nothing lost, nothing duplicated', { skip, timeout: 90_000 }, async () => {
  await scenario(async ({ rt, state, log, deps, deliver }) => {
    state.down = true;
    assert.deepEqual(await deliver('wh-1'), { status: 200, outcome: 'accepted' });
    await startWorker(rt.boss, deps, { pollingIntervalSeconds: 0.5 });

    await until(() => log.entries.filter((e) => e.outcome === 'retry').length >= 2);
    assert.equal(state.creates, 0, 'nothing was written while Salesforce was down');
    // Shopify retries the same delivery during the outage: it must not create a second job.
    assert.deepEqual(await deliver('wh-1'), { status: 200, outcome: 'duplicate' });

    state.down = false; // Salesforce recovers
    await until(() => log.entries.some((e) => e.outcome === 'created'));

    assert.equal(state.creates, 1, 'exactly one Lead written');
    const retries = log.entries.filter((e) => e.outcome === 'retry');
    assert.ok(retries.length >= 2);
    assert.ok(retries.every((e) => e.errorClass === 'transient' && e.errorCode === 'SERVER_UNAVAILABLE'));
    assert.equal(log.entries.filter((e) => e.outcome === 'created').length, 1);
    assert.equal(log.entries.at(-1)!.outcome, 'created');

    // A redelivery after success writes nothing more (business key + entity map).
    assert.deepEqual(await deliver('wh-2'), { status: 200, outcome: 'duplicate' });
    await sleep(1500);
    assert.equal(state.creates, 1);
  });
});

test('a longer outage dead-letters the job; after recovery a replay (redrive) writes exactly once', { skip, timeout: 120_000 }, async () => {
  await scenario(async ({ rt, state, log, deps, deliver, count }) => {
    state.down = true;
    await deliver('wh-1');
    await startWorker(rt.boss, deps, { pollingIntervalSeconds: 0.5 });
    await until(async () => (await count(WEBHOOK_DEAD_QUEUE)) === 1, 60_000);
    assert.equal(state.creates, 0);
    assert.equal(log.entries.filter((e) => e.outcome === 'retry').length, 3, '1 try + 2 retries, all logged');

    state.down = false;
    assert.equal(await rt.boss.redrive(WEBHOOK_DEAD_QUEUE), 1);
    await until(() => log.entries.some((e) => e.outcome === 'created'), 60_000);
    assert.equal(state.creates, 1);
    assert.equal(log.entries.filter((e) => e.outcome === 'created').length, 1);
    assert.equal(await count(WEBHOOK_QUEUE) >= 1, true);
  });
});

test('crash window: Salesforce write succeeded but the job failed afterwards -> the retry writes nothing (entity map)', { skip, timeout: 90_000 }, async () => {
  await scenario(async ({ rt, state, log, deps, deliver }) => {
    // Make the log fail ONCE after the write succeeded: processJob throws, the queue retries the job.
    let failedOnce = false;
    const flakyLog = {
      async record(e: any) {
        if (e.outcome === 'created' && !failedOnce) {
          failedOnce = true;
          throw new Error('log database blip');
        }
        return log.record(e);
      },
    };
    await deliver('wh-1');
    await startWorker(rt.boss, { ...deps, log: flakyLog }, { pollingIntervalSeconds: 0.5 });
    await until(() => log.entries.some((e) => e.outcome === 'already_done'), 60_000);
    assert.equal(state.creates, 1, 'the Lead was written once, not twice, despite the retry');
  });
});
