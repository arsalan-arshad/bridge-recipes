// The Intake contract every implementation must satisfy (in-memory and Postgres run the same tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Intake, Job } from './types.ts';

export interface IntakeFixture {
  intake: Intake;
  count(): Promise<number>; // jobs actually queued
  close?(): Promise<void>;
}

const job = (over: Partial<Job> = {}): Job => ({
  webhookId: 'wh-1',
  eventId: 'ev-1',
  topic: 'orders/paid',
  shop: 's.myshopify.com',
  apiVersion: '2026-10',
  businessKey: 'orders/paid|s.myshopify.com|1',
  receivedAt: '2026-10-19T12:00:00.000Z',
  payload: '{}',
  ...over,
});

export function defineIntakeContract(label: string, make: () => Promise<IntakeFixture>): void {
  const run = (name: string, fn: (f: IntakeFixture) => Promise<void>) =>
    test(`${label}: ${name}`, async () => {
      const f = await make();
      try {
        await fn(f);
      } finally {
        await f.close?.();
      }
    });

  run('accepts a new job once', async ({ intake, count }) => {
    assert.equal(await intake.accept(job()), 'accepted');
    assert.equal(await count(), 1);
  });

  run('same Webhook-Id with a DIFFERENT business key is a duplicate', async ({ intake, count }) => {
    await intake.accept(job());
    assert.equal(await intake.accept(job({ businessKey: 'orders/paid|s.myshopify.com|2' })), 'duplicate');
    assert.equal(await count(), 1);
  });

  run('same business key with a DIFFERENT Webhook-Id is a duplicate', async ({ intake, count }) => {
    await intake.accept(job());
    assert.equal(await intake.accept(job({ webhookId: 'wh-2' })), 'duplicate');
    assert.equal(await count(), 1);
  });

  run('a duplicate records nothing new (a later new order with that Webhook-Id is still accepted)', async ({ intake, count }) => {
    await intake.accept(job());
    await intake.accept(job({ webhookId: 'wh-2' })); // duplicate by business key: must not remember wh-2
    assert.equal(await intake.accept(job({ webhookId: 'wh-2', businessKey: 'orders/paid|s.myshopify.com|3' })), 'accepted');
    assert.equal(await count(), 2);
  });

  run('different Webhook-Id and business key are independent', async ({ intake, count }) => {
    await intake.accept(job());
    assert.equal(await intake.accept(job({ webhookId: 'wh-2', businessKey: 'orders/paid|s.myshopify.com|2' })), 'accepted');
    assert.equal(await count(), 2);
  });

  run('concurrent identical deliveries: exactly one accepted, one job', async ({ intake, count }) => {
    const results = await Promise.all(Array.from({ length: 8 }, () => intake.accept(job())));
    assert.equal(results.filter((r) => r === 'accepted').length, 1);
    assert.equal(results.filter((r) => r === 'duplicate').length, 7);
    assert.equal(await count(), 1);
  });
}
