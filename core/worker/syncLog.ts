// The sync log (docs/SPEC.md section 5): what happened to each job, with minimum personal data. Never the payload.
// This is the interface plus an in-memory implementation; the Postgres one with a retention window is the next M1 item.

import { redactEmail } from '../log/redactEmail.ts';
import type { CoreOp } from '../executor/ops.ts';

export type JobOutcome =
  | 'created' | 'updated' | 'duplicate_detected' | 'already_done'
  | 'skipped' | 'dry_run' | 'recipe_disabled' | 'unknown_topic' | 'invalid_payload'
  | 'retry' | 'failed' | 'lifecycle_done';

export interface LogEntry {
  at: string;
  shop: string;
  recipeId: string;
  topic: string;
  objectId: string;
  webhookId: string;
  outcome: JobOutcome;
  dryRun: boolean;
  reason?: string; // skip reason, invalid-payload reason
  errorClass?: string; // SalesforceError.kind, or 'internal'
  errorCode?: string; // Salesforce errorCode (already scrubbed of emails)
  ops?: { kind: string; outcome: string; sfId?: string; planned?: Record<string, unknown> }[];
}

export interface SyncLog {
  record(entry: LogEntry): Promise<void>;
}

export class MemorySyncLog implements SyncLog {
  readonly entries: LogEntry[] = [];
  async record(entry: LogEntry) {
    this.entries.push(entry);
  }
}

// What a dry-run shows of a planned write: exactly the op, but with personal values masked.
export function describeOp(op: CoreOp): Record<string, unknown> {
  const f: Record<string, unknown> = { ...(op.fields as Record<string, unknown>) };
  if (typeof f.Email === 'string') f.Email = redactEmail(f.Email);
  if (typeof f.LastName === 'string' && f.LastName.length > 0) f.LastName = `${f.LastName[0]}***`;
  // Free text can carry a person's name or order notes: keep only its presence and size, never the content.
  // Company stays visible on purpose: it is what the merchant checks in a dry-run (a sole trader's company can be a personal name; the log is purged after 30 days).
  for (const k of ['Description', 'FirstName', 'Phone', 'Subject']) {
    if (typeof f[k] === 'string' && f[k] !== '') f[k] = `[${(f[k] as string).length} chars]`;
  }
  return { kind: op.kind, matchKey: op.matchKey, ...('targetId' in op ? { targetId: op.targetId } : {}), ...('ownerId' in op ? { ownerId: op.ownerId, accountId: op.accountId, contactId: op.contactId } : {}), fields: f };
}
