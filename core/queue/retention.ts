// Retention (docs/SPEC.md section 5: "SyncLog ... (retention window)"; section 3: payloads are deleted once done).
// Queue jobs (and the raw payloads inside them) are purged by pg-boss itself (core/queue/config.ts). This purges OUR tables.
// Defaults: sync log 30 days; intake rows 14 days (Shopify retries within hours, so dedupe needs only a margin);
// entity map 30 days (a job never retries that long). All configurable. `now` is injected so it is testable.

import { assertSchemaName } from './migrate.ts';

export interface RetentionPolicy {
  syncLogDays: number;
  intakeDays: number;
  entityMapDays: number;
  complianceDays: number; // the compliance log is the merchant's evidence of handled requests; kept longer
}

export const DEFAULT_RETENTION: RetentionPolicy = { syncLogDays: 30, intakeDays: 14, entityMapDays: 30, complianceDays: 365 };

export async function purgeExpired(
  pool: { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }> },
  schema: string,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<{ syncLog: number; intake: number; entityMap: number; adminAudit: number; complianceLog: number }> {
  assertSchemaName(schema);
  for (const [k, v] of Object.entries(policy)) {
    if (!Number.isFinite(v) || v < 1) throw new Error(`retention ${k} must be at least 1 day`);
  }
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const del = async (table: string, column: string, days: number) =>
    (await pool.query(`DELETE FROM ${schema}.${table} WHERE ${column} < $1`, [cutoff(days)])).rowCount ?? 0;
  return {
    syncLog: await del('sync_log', 'at', policy.syncLogDays),
    intake: await del('webhook_intake', 'received_at', policy.intakeDays),
    entityMap: await del('entity_map', 'created_at', policy.entityMapDays),
    adminAudit: await del('admin_audit', 'at', policy.syncLogDays), // the audit trail ages out with the sync log
    complianceLog: await del('compliance_log', 'at', policy.complianceDays),
  };
}
