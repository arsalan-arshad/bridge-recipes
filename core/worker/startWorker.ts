// Connects the queue to processJob. One job at a time per worker (batchSize 1), so a failure fails exactly that job and the
// queue's retry policy (backoff, dead-letter) applies to it alone.

import { processJob } from './processJob.ts';
import { WEBHOOK_QUEUE } from '../queue/config.ts';
import type { PgBoss } from 'pg-boss';
import type { Job } from '../gateway/types.ts';
import type { WorkerDeps } from './processJob.ts';

export async function startWorker(boss: PgBoss, deps: WorkerDeps, opts: { pollingIntervalSeconds?: number; localConcurrency?: number } = {}): Promise<string> {
  return boss.work(
    WEBHOOK_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2, localConcurrency: opts.localConcurrency ?? 1 } as any,
    async (jobs: { data: unknown }[]) => {
      for (const j of jobs) await processJob(j.data as Job, deps);
    },
  );
}
