// Processes ONE queued webhook job. Order of checks: unknown topic -> recipe settings (kill switch) -> map payload ->
// read-only context -> decide() -> (dry-run: log only) or execute. Every path writes exactly one sync-log entry.
// Errors that are retryable (Salesforce down, limits, credentials) are logged as 'retry' and RE-THROWN so the queue retries
// with backoff and finally dead-letters; anything else is logged as 'failed' and also re-thrown (visible in the dead-letter
// queue, replayable). The raw payload is never logged.

import { SalesforceError } from '../salesforce/client.ts';
import { runOp } from '../executor/executeOp.ts';
import type { EntityStore } from '../executor/entityStore.ts';
import type { OpOutcome, SfWriter } from '../executor/ops.ts';
import type { Job } from '../gateway/types.ts';
import type { ConfigStore, Recipe, SfReader } from './recipe.ts';
import { describeOp } from './syncLog.ts';
import { isLifecycleTopic } from '../compliance/topics.ts';
import type { JobOutcome, LogEntry, SyncLog } from './syncLog.ts';

export interface WorkerDeps {
  recipes: Recipe[];
  configs: ConfigStore;
  // One client, or a function that returns the client for a shop (resolved lazily: a disabled recipe and an early skip
  // never need a Salesforce connection).
  sf: (SfReader & SfWriter) | ((shop: string) => Promise<SfReader & SfWriter>);
  entities: EntityStore;
  log: SyncLog;
  now: () => Date;
  // Privacy and uninstall requests (core/compliance). Handled WITHOUT a sync-log entry: that log is shop data, and a shop/redact
  // must not leave a new row behind. The handler records its own non-personal compliance entry. Errors propagate (retry, then dead-letter).
  lifecycle?: (job: Job) => Promise<unknown>;
}

const RANK: Record<string, number> = { failed: 5, duplicate_detected: 4, created: 3, updated: 2, already_done: 1 };

export async function processJob(job: Job, deps: WorkerDeps): Promise<JobOutcome> {
  const base = (over: Partial<LogEntry> & Pick<LogEntry, 'outcome'>): LogEntry => ({
    at: deps.now().toISOString(), shop: job.shop, recipeId: 'none', topic: job.topic, objectId: '', webhookId: job.webhookId, dryRun: false, ...over,
  });
  const done = async (e: LogEntry) => {
    await deps.log.record(e);
    return e.outcome;
  };

  if (deps.lifecycle && isLifecycleTopic(job.topic)) {
    await deps.lifecycle(job);
    return 'lifecycle_done';
  }

  const recipe = deps.recipes.find((r) => r.topics.includes(job.topic));
  if (!recipe) return done(base({ outcome: 'unknown_topic' }));

  const settings = await deps.configs.get(job.shop, recipe.id);
  if (!settings || !settings.enabled) return done(base({ recipeId: recipe.id, outcome: 'recipe_disabled' }));
  const dryRun = settings.dryRun;
  const mk = (over: Partial<LogEntry> & Pick<LogEntry, 'outcome'>, objectId = '') => base({ recipeId: recipe.id, dryRun, objectId, ...over });

  let payload: unknown;
  try {
    payload = JSON.parse(job.payload);
  } catch {
    return done(mk({ outcome: 'invalid_payload', reason: 'not_json' }));
  }
  const mapped = recipe.mapEvent(payload);
  if (!mapped.ok) return done(mk({ outcome: 'invalid_payload', reason: mapped.reason }));
  const event = mapped.event;
  const objectId = recipe.objectIdOf(event);

  try {
    // Rules that need no Salesforce data decide first: such a skip is final and costs zero API calls.
    const early = recipe.decide(event, recipe.emptyContext(), settings.config);
    if ('skip' in early) return done(mk({ outcome: 'skipped', reason: early.skip }, objectId));

    const sf = typeof deps.sf === 'function' ? await deps.sf(job.shop) : deps.sf;
    const ctx = await recipe.buildContext(event, sf); // reads only, allowed in dry-run
    const decision = recipe.decide(event, ctx, settings.config);
    if ('skip' in decision) return done(mk({ outcome: 'skipped', reason: decision.skip }, objectId));

    if (dryRun) {
      return done(mk({ outcome: 'dry_run', ops: decision.ops.map((op) => ({ kind: op.kind, outcome: 'planned', planned: describeOp(op) })) }, objectId));
    }

    const results: { kind: string; outcome: OpOutcome }[] = [];
    for (const op of decision.ops) results.push({ kind: op.kind, outcome: await runOp(op, { sf, entities: deps.entities, shop: job.shop }) });
    const overall = results.map((r) => r.outcome.kind).sort((a, b) => RANK[b] - RANK[a])[0] as JobOutcome;
    return done(mk({
      outcome: overall,
      ops: results.map((r) => ({ kind: r.kind, outcome: r.outcome.kind, ...('id' in r.outcome ? { sfId: r.outcome.id } : {}) })),
    }, objectId));
  } catch (err) {
    if (err instanceof SalesforceError) {
      await deps.log.record(mk({ outcome: err.retryable ? 'retry' : 'failed', errorClass: err.kind, errorCode: err.errorCode }, objectId));
    } else {
      await deps.log.record(mk({ outcome: 'failed', errorClass: 'internal' }, objectId)); // no message: it could carry data
    }
    throw err;
  }
}
