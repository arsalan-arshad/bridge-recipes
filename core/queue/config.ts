// Queue names and retry policy (docs/BUILD_PLAN.md M1: retries, backoff + jitter, dead-letter, replay).
// pg-boss retries a failed job with exponential backoff (its formula adds jitter) up to retryLimit, then moves it to
// the dead-letter queue, from where redrive() replays it.

export const WEBHOOK_QUEUE = 'webhook-jobs';
export const WEBHOOK_DEAD_QUEUE = 'webhook-jobs-dead';

export interface RetryPolicy {
  retryLimit: number;
  retryDelaySeconds: number; // initial delay; doubles per attempt (with jitter) when backoff is on
  retryDelayMaxSeconds: number;
  completedRetentionSeconds: number; // how long a COMPLETED job (and its raw payload) stays; short on purpose
  deadRetentionSeconds: number; // dead-lettered jobs stay replayable this long
  expireInSeconds: number; // an active job running longer than this is failed and retried
}

export const DEFAULT_POLICY: RetryPolicy = {
  retryLimit: 8,
  retryDelaySeconds: 30,
  retryDelayMaxSeconds: 3600,
  completedRetentionSeconds: 3600,
  deadRetentionSeconds: 14 * 24 * 3600,
  expireInSeconds: 300,
};

export function queueOptions(policy: RetryPolicy = DEFAULT_POLICY) {
  return {
    main: {
      retryLimit: policy.retryLimit,
      retryDelay: policy.retryDelaySeconds,
      retryBackoff: true,
      retryDelayMax: policy.retryDelayMaxSeconds,
      deleteAfterSeconds: policy.completedRetentionSeconds,
      expireInSeconds: policy.expireInSeconds,
      deadLetter: WEBHOOK_DEAD_QUEUE,
    },
    dead: { retentionSeconds: policy.deadRetentionSeconds },
  };
}
