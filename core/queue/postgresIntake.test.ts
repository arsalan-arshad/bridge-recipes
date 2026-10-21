// Integration tests against a REAL Postgres (the local bridge_recipes_dev). Skipped when DATABASE_URL is not set,
// so `npm test` stays green on a machine without a database; they run for real where it is set.
// Every test works in its own throwaway schema, dropped afterwards. No secrets or customer data involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { defineIntakeContract } from '../gateway/intakeContract.ts';
import { handleWebhook } from '../gateway/handleWebhook.ts';
import { PostgresIntake, startQueue } from './postgresIntake.ts';
import { WEBHOOK_DEAD_QUEUE, WEBHOOK_QUEUE } from './config.ts';
import type { RetryPolicy } from './config.ts';
import type { Job } from '../gateway/types.ts';

const URL = process.env.DATABASE_URL ?? '';
const skip = URL === '' ? 'DATABASE_URL not set (point it at the local bridge_recipes_dev to run these)' : false;

const FAST: RetryPolicy = { retryLimit: 2, retryDelaySeconds: 1, retryDelayMaxSeconds: 2, completedRetentionSeconds: 3600, deadRetentionSeconds: 3600, expireInSeconds: 60 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newSchema = () => `bridge_t_${randomBytes(4).toString('hex')}`;

async function dropSchema(schema: string) {
  const pool = new pg.Pool({ connectionString: URL, max: 1 });
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
}

async function withRuntime(fn: (rt: Awaited<ReturnType<typeof startQueue>>, schema: string) => Promise<void>, policy?: RetryPolicy) {
  const schema = newSchema();
  const rt = await startQueue({ connectionString: URL, schema, policy });
  try {
    await fn(rt, schema);
  } finally {
    await rt.stop().catch(() => {});
    await dropSchema(schema);
  }
}

const countJobs = (rt: { pool: pg.Pool }, schema: string, queue = WEBHOOK_QUEUE) =>
  rt.pool.query(`SELECT count(*)::int AS n FROM ${schema}.job WHERE name = $1`, [queue]).then((r) => r.rows[0].n as number);

// ---- the shared Intake contract, against Postgres ------------------------------------------------------
if (!skip) {
  defineIntakeContract('PostgresIntake', async () => {
    const schema = newSchema();
    const rt = await startQueue({ connectionString: URL, schema });
    return {
      intake: rt.intake,
      count: () => countJobs(rt, schema),
      close: async () => {
        await rt.stop().catch(() => {});
        await dropSchema(schema);
      },
    };
  });
} else {
  test('PostgresIntake contract', { skip }, () => {});
}

const job = (over: Partial<Job> = {}): Job => ({
  webhookId: 'wh-1', eventId: 'ev-1', topic: 'orders/paid', shop: 's.myshopify.com', apiVersion: '2026-10',
  businessKey: 'orders/paid|s.myshopify.com|1', receivedAt: '2026-10-19T12:00:00.000Z', payload: '{"a":1}', ...over,
});

test('a failed start does not leak connections', { skip }, async () => {
  const probe = new pg.Pool({ connectionString: URL, max: 1 });
  const open = async () => (await probe.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`)).rows[0].n as number;
  const before = await open();
  const schema = newSchema();
  const bad: RetryPolicy = { ...FAST, retryLimit: -1 }; // pg-boss rejects this when the queue is created
  await assert.rejects(() => startQueue({ connectionString: URL, schema, policy: bad }));
  await sleep(500);
  const after = await open();
  await dropSchema(schema);
  await probe.end();
  assert.ok(after <= before, `connections before=${before} after=${after}`);
});

test('atomic: if enqueueing fails nothing is recorded, so the retry is accepted (not lost as a "duplicate")', { skip }, async () => {
  await withRuntime(async (rt, schema) => {
    const broken = new PostgresIntake({ pool: rt.pool, boss: { send: async () => { throw new Error('queue down'); } } as any, schema });
    await assert.rejects(() => broken.accept(job()), /queue down/);
    const rows = await rt.pool.query(`SELECT count(*)::int AS n FROM ${schema}.webhook_intake`);
    assert.equal(rows.rows[0].n, 0, 'the intake row must have rolled back');
    assert.equal(await rt.intake.accept(job()), 'accepted');
    assert.equal(await countJobs(rt, schema), 1);
  });
});

test('atomic: if the COMMIT fails, the job created in the same transaction is rolled back too', { skip }, async () => {
  await withRuntime(async (rt, schema) => {
    const failingCommit = {
      connect: async () => {
        const c = await rt.pool.connect();
        return {
          query: (text: string, values?: unknown[]) => (text === 'COMMIT' ? Promise.reject(new Error('commit failed')) : c.query(text, values as any[])),
          release: () => c.release(),
        };
      },
    } as unknown as pg.Pool;
    const intake = new PostgresIntake({ pool: failingCommit, boss: rt.boss, schema });
    await assert.rejects(() => intake.accept(job()), /commit failed/);
    assert.equal(await countJobs(rt, schema), 0, 'no job may survive a failed commit');
    assert.equal((await rt.pool.query(`SELECT count(*)::int AS n FROM ${schema}.webhook_intake`)).rows[0].n, 0);
    assert.equal(await rt.intake.accept(job()), 'accepted', 'the retry is then accepted');
  });
});

test('atomic: a queue that returns no job id is an error and rolls back', { skip }, async () => {
  await withRuntime(async (rt, schema) => {
    const refusing = new PostgresIntake({ pool: rt.pool, boss: { send: async () => null } as any, schema });
    await assert.rejects(() => refusing.accept(job()), /refused/);
    assert.equal((await rt.pool.query(`SELECT count(*)::int AS n FROM ${schema}.webhook_intake`)).rows[0].n, 0);
  });
});

test('queued job carries the raw payload and the dedupe fields', { skip }, async () => {
  await withRuntime(async (rt) => {
    await rt.intake.accept(job({ payload: '{"hello":"wörld"}' }));
    const seen: any[] = [];
    await rt.boss.work(WEBHOOK_QUEUE, { pollingIntervalSeconds: 0.5 } as any, async ([j]: any[]) => { seen.push(j.data); });
    for (let i = 0; i < 20 && seen.length === 0; i++) await sleep(500);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].payload, '{"hello":"wörld"}');
    assert.equal(seen[0].webhookId, 'wh-1');
    assert.equal(seen[0].businessKey, 'orders/paid|s.myshopify.com|1');
  });
});

test('gateway end to end on Postgres: signed delivery queued once; Shopify retry is a duplicate', { skip }, async () => {
  await withRuntime(async (rt, schema) => {
    const secret = 'test-signing-secret';
    const body = Buffer.from(JSON.stringify({ admin_graphql_api_id: 'gid://shopify/Order/5', name: '#5' }));
    const headers = {
      'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body).digest('base64'),
      'x-shopify-topic': 'orders/paid', 'x-shopify-shop-domain': 's.myshopify.com', 'x-shopify-webhook-id': 'wh-e2e',
    };
    const deps = { secret, intake: rt.intake, topics: new Set(['orders/paid']), now: () => new Date(0), log: () => {} };
    assert.deepEqual(await handleWebhook({ rawBody: body, headers }, deps), { status: 200, outcome: 'accepted' });
    assert.deepEqual(await handleWebhook({ rawBody: body, headers }, deps), { status: 200, outcome: 'duplicate' });
    assert.equal(await countJobs(rt, schema), 1);
  });
});

// ---- retries, back-off, dead-letter, replay ------------------------------------------------------------

test('failing job is retried, then dead-lettered; redrive replays it and it can then succeed', { skip, timeout: 60_000 }, async () => {
  await withRuntime(async (rt, schema) => {
    await rt.intake.accept(job());
    let attempts = 0;
    let healthy = false;
    await rt.boss.work(WEBHOOK_QUEUE, { pollingIntervalSeconds: 0.5 } as any, async () => {
      attempts++;
      if (!healthy) throw new Error('salesforce down');
    });
    for (let i = 0; i < 60 && (await countJobs(rt, schema, WEBHOOK_DEAD_QUEUE)) === 0; i++) await sleep(500);
    assert.equal(await countJobs(rt, schema, WEBHOOK_DEAD_QUEUE), 1, 'dead-lettered after the retries');
    assert.equal(attempts, 3, '1 try + 2 retries (retryLimit 2)');

    healthy = true; // "Salesforce is back": replay the dead job
    const moved = await rt.boss.redrive(WEBHOOK_DEAD_QUEUE);
    assert.equal(moved, 1);
    for (let i = 0; i < 40 && attempts < 4; i++) await sleep(500);
    assert.equal(attempts, 4, 'the replayed job ran again and succeeded');
  }, FAST);
});

test('completed jobs (and their raw payloads) are scheduled for deletion by the short completed retention', { skip }, async () => {
  await withRuntime(async (rt) => {
    const q = await rt.boss.getQueue(WEBHOOK_QUEUE);
    assert.ok(q);
    assert.equal((q as any).deleteAfterSeconds, 3600);
    assert.equal((q as any).deadLetter, WEBHOOK_DEAD_QUEUE);
    assert.equal((q as any).retryBackoff, true);
    assert.equal((q as any).retryLimit, 8);
  });
});

// ---- the entity map on Postgres ------------------------------------------------------------------------
import { defineEntityStoreContract } from '../executor/entityStoreContract.ts';
import { PostgresEntityStore } from './postgresEntityStore.ts';

if (!skip) {
  defineEntityStoreContract('PostgresEntityStore', async () => {
    const schema = newSchema();
    const rt = await startQueue({ connectionString: URL, schema });
    return {
      store: new PostgresEntityStore(rt.pool, schema),
      close: async () => {
        await rt.stop().catch(() => {});
        await dropSchema(schema);
      },
    };
  });
} else {
  test('PostgresEntityStore contract', { skip }, () => {});
}

test('pool and queue error events are handled (no crash) and reported by a fixed source name only', { skip }, async () => {
  const reported: string[] = [];
  const schema = newSchema();
  const rt = await startQueue({ connectionString: URL, schema, onError: (s) => reported.push(s) });
  try {
    // an EventEmitter without an 'error' listener THROWS on emit: reaching the assertions proves a listener is installed
    assert.doesNotThrow(() => rt.pool.emit('error', new Error('idle client lost postgres://user:hunter2@host/db')));
    assert.doesNotThrow(() => (rt.boss as any).emit('error', new Error('queue broke password=hunter2')));
    assert.deepEqual(reported, ['pool', 'queue']);
    assert.ok(!JSON.stringify(reported).includes('hunter2'));
  } finally {
    await rt.stop().catch(() => {});
    await dropSchema(schema);
  }
});
