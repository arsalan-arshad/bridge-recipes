// Durable sync log. Defence in depth: even though callers already mask personal values, any raw email address that
// reaches this class is masked again before it is stored. The payload is never an input (LogEntry has no such field).

import { assertSchemaName } from './migrate.ts';
import { redactEmail } from '../log/redactEmail.ts';
import type { LogEntry, SyncLog } from '../worker/syncLog.ts';

type Pool = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

// Mask any email whose local part is not already masked ("a***@domain").
// Linear time: split into runs of non-delimiter characters first, then look at each run once (the earlier single regex backtracked
// quadratically on long runs without an "@").
export function scrubEmails(text: string): string {
  return text.replace(/[^\s"'\\<>,;]+/g, (token) => {
    const at = token.indexOf('@');
    if (at === -1 || at === token.length - 1) return token; // no "@", or nothing after it
    return token.slice(0, at).endsWith('***') ? token : redactEmail(token);
  });
}

export interface LogFilter {
  shop?: string;
  outcome?: string;
  limit?: number;
  offset?: number;
}

export class PostgresSyncLog implements SyncLog {
  private readonly pool: Pool;
  private readonly schema: string;
  constructor(pool: Pool, schema: string) {
    this.pool = pool;
    this.schema = assertSchemaName(schema);
  }

  async record(e: LogEntry): Promise<void> {
    const ops = e.ops === undefined ? null : scrubEmails(JSON.stringify(e.ops));
    await this.pool.query(
      `INSERT INTO ${this.schema}.sync_log (at, shop, recipe_id, topic, object_id, webhook_id, outcome, dry_run, reason, error_class, error_code, ops)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [e.at, e.shop, e.recipeId, e.topic, e.objectId, e.webhookId, e.outcome, e.dryRun, e.reason ?? null, e.errorClass ?? null,
       e.errorCode === undefined ? null : scrubEmails(e.errorCode), ops],
    );
  }

  // Newest first. For the future log viewer.
  async recent(filter: LogFilter = {}): Promise<LogEntry[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.shop !== undefined) { vals.push(filter.shop); where.push(`shop = $${vals.length}`); }
    if (filter.outcome !== undefined) { vals.push(filter.outcome); where.push(`outcome = $${vals.length}`); }
    vals.push(Math.min(Math.max(filter.limit ?? 50, 1), 500));
    const limitIdx = vals.length;
    vals.push(Math.min(Math.max(filter.offset ?? 0, 0), 1_000_000));
    const r = await this.pool.query(
      `SELECT at, shop, recipe_id, topic, object_id, webhook_id, outcome, dry_run, reason, error_class, error_code, ops
       FROM ${this.schema}.sync_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $${limitIdx} OFFSET $${vals.length}`,
      vals,
    );
    return r.rows.map((x) => ({
      at: new Date(x.at).toISOString(), shop: x.shop, recipeId: x.recipe_id, topic: x.topic, objectId: x.object_id, webhookId: x.webhook_id,
      outcome: x.outcome, dryRun: x.dry_run,
      ...(x.reason !== null ? { reason: x.reason } : {}), ...(x.error_class !== null ? { errorClass: x.error_class } : {}),
      ...(x.error_code !== null ? { errorCode: x.error_code } : {}), ...(x.ops !== null ? { ops: x.ops } : {}),
    }));
  }
}
