// In-memory Intake for tests and local runs. NOT durable: the real one is a Postgres insert with unique
// constraints on webhook_id and business_key (M1 queue item). Same contract: atomic, all-or-nothing.

import type { Intake, Job } from './types.ts';

export class MemoryIntake implements Intake {
  readonly jobs: Job[] = [];
  private readonly webhookIds = new Set<string>();
  private readonly businessKeys = new Set<string>();

  async accept(job: Job): Promise<'accepted' | 'duplicate'> {
    if (this.webhookIds.has(job.webhookId) || this.businessKeys.has(job.businessKey)) return 'duplicate';
    this.webhookIds.add(job.webhookId);
    this.businessKeys.add(job.businessKey);
    this.jobs.push(job);
    return 'accepted';
  }
}
