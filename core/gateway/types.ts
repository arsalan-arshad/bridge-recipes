// Gateway contracts (docs/SPEC.md section 3 steps 1-3). Erasable TypeScript only.

export interface Job {
  webhookId: string; // X-Shopify-Webhook-Id: unique per delivery, identical on retries (observed 2026-10-19)
  eventId: string; // X-Shopify-Event-Id: informational only, NOT a dedupe key (shared across subscriptions)
  topic: string;
  shop: string; // X-Shopify-Shop-Domain
  apiVersion: string;
  businessKey: string; // `${topic}|${shop}|${shopifyObjectId}`; falls back to webhookId when the payload has no object id
  receivedAt: string; // ISO time from the injected clock
  payload: string; // raw body, kept only so the job can be retried; the worker deletes it on success
}

// ONE atomic step: record the delivery AND enqueue the job, or neither. Two separate steps would let a crash
// between them make Shopify's retry look like a duplicate and lose the order.
export interface Intake {
  accept(job: Job): Promise<'accepted' | 'duplicate'>;
}

export type Outcome = 'unauthorized' | 'bad_request' | 'ignored_topic' | 'duplicate' | 'accepted' | 'intake_error';

// Never contains the payload or any customer data.
export interface LogEntry {
  outcome: Outcome;
  topic: string;
  shop: string;
  webhookId: string;
  reason?: string; // fixed vocabulary only (why a signed request was refused); never payload content
}

export interface GatewayDeps {
  secret: string; // app / store webhook signing key
  intake: Intake;
  topics: ReadonlySet<string>; // topics a recipe or compliance handler listens to
  now: () => Date;
  log: (entry: LogEntry) => void;
}

export type HeaderBag = Record<string, string | string[] | undefined>;
