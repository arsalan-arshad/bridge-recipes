// Durable Intake: ONE database transaction records the delivery (unique on webhook id AND business key) and
// enqueues the pg-boss job. Either both happen or neither, so a crash or error can never turn Shopify's retry
// into a "duplicate" of something that was never queued.

import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { assertSchemaName, migrate } from './migrate.ts';
import { DEFAULT_POLICY, WEBHOOK_DEAD_QUEUE, WEBHOOK_QUEUE, queueOptions } from './config.ts';
import type { RetryPolicy } from './config.ts';
import type { Intake, Job } from '../gateway/types.ts';

export class PostgresIntake implements Intake {
  private readonly pool: pg.Pool;
  private readonly boss: PgBoss;
  private readonly schema: string;
  private readonly queue: string;

  constructor(opts: { pool: pg.Pool; boss: PgBoss; schema: string; queue?: string }) {
    this.pool = opts.pool;
    this.boss = opts.boss;
    this.schema = assertSchemaName(opts.schema);
    this.queue = opts.queue ?? WEBHOOK_QUEUE;
  }

  async accept(job: Job): Promise<'accepted' | 'duplicate'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // ON CONFLICT DO NOTHING covers BOTH unique constraints. A concurrent identical delivery blocks here until the
      // first transaction ends, then sees the conflict (or, if the first rolled back, proceeds).
      const ins = await client.query(
        `INSERT INTO ${this.schema}.webhook_intake (webhook_id, business_key, topic, shop, received_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [job.webhookId, job.businessKey, job.topic, job.shop, job.receivedAt],
      );
      if (ins.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'duplicate';
      }
      // The job is created in the SAME transaction (pg-boss runs its SQL on our client).
      const id = await this.boss.send(this.queue, { ...job }, { db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values as any[]) } });
      if (id === null) throw new Error('queue refused the job');
      await client.query('COMMIT');
      return 'accepted';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface QueueRuntime {
  intake: PostgresIntake;
  boss: PgBoss;
  pool: pg.Pool;
  stop(): Promise<void>;
}

// Connects, migrates, creates the queues (dead-letter first) and returns a ready intake.
// `onError` is told that the database pool or the queue emitted an error event (fixed source name only, never the error: it can echo
// connection details). Without a listener, a pool 'error' event (e.g. an idle connection dropped by the server) would crash the process.
export async function startQueue(opts: { connectionString: string; schema: string; policy?: RetryPolicy; supervise?: boolean; onError?: (source: 'pool' | 'queue') => void }): Promise<QueueRuntime> {
  const schema = assertSchemaName(opts.schema);
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: 5 });
  pool.on('error', () => opts.onError?.('pool'));
  let boss: PgBoss | undefined;
  try {
    await migrate(pool, schema);
    boss = new PgBoss({ connectionString: opts.connectionString, schema, ...(opts.supervise === undefined ? {} : { supervise: opts.supervise }) });
    boss.on('error', () => opts.onError?.('queue')); // the error itself is never logged: it could carry data or connection details
    await boss.start();
    const q = queueOptions(opts.policy ?? DEFAULT_POLICY);
    await boss.createQueue(WEBHOOK_DEAD_QUEUE, q.dead);
    await boss.createQueue(WEBHOOK_QUEUE, q.main);
  } catch (err) {
    // A failed start must not leak connections (a leaked pool keeps the process alive).
    if (boss) await boss.stop({ graceful: false, close: true } as any).catch(() => {});
    await pool.end().catch(() => {});
    throw err;
  }
  const started = boss;
  return {
    intake: new PostgresIntake({ pool, boss: started, schema }),
    boss: started,
    pool,
    async stop() {
      await started.stop({ graceful: false, close: true } as any);
      await pool.end();
    },
  };
}
