// Data access for the admin UI: audit trail, shop list, dead-letter listing and replay.

import { assertSchemaName } from './migrate.ts';
import { WEBHOOK_DEAD_QUEUE, WEBHOOK_QUEUE } from './config.ts';
import { scrubEmails } from './postgresSyncLog.ts';
import type { PgBoss } from 'pg-boss';

type Pool = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

export interface AuditEntry {
  at: string;
  action: string;
  shop: string | null;
  detail: string | null;
}

export class PostgresAudit {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly now: () => Date;
  constructor(pool: Pool, schema: string, now: () => Date = () => new Date()) {
    this.pool = pool;
    this.schema = assertSchemaName(schema);
    this.now = now;
  }
  async record(e: { action: string; shop?: string; detail?: string }): Promise<void> {
    await this.pool.query(`INSERT INTO ${this.schema}.admin_audit (at, action, shop, detail) VALUES ($1, $2, $3, $4)`, [
      this.now().toISOString(), e.action.slice(0, 60), e.shop ?? null, e.detail === undefined ? null : scrubEmails(e.detail).slice(0, 200),
    ]);
  }
  async recent(n: number): Promise<AuditEntry[]> {
    const r = await this.pool.query(`SELECT at, action, shop, detail FROM ${this.schema}.admin_audit ORDER BY at DESC, id DESC LIMIT $1`, [Math.min(Math.max(n, 1), 200)]);
    return r.rows.map((x) => ({ at: new Date(x.at).toISOString(), action: x.action, shop: x.shop, detail: x.detail }));
  }
}

// Has the OPERATOR set this shop up? True only when the shop has a recipe-settings row ("Add a shop" in the admin, or any recipe setting)
// or a stored Salesforce connection. A shop that merely sent us a webhook (it is in the decision log) is NOT set up: anyone can install a
// public app, and the embedded page must not open for them.
export async function isOperatorShop(pool: Pool, schema: string, shop: string): Promise<boolean> {
  assertSchemaName(schema);
  const r = await pool.query(
    `SELECT 1 FROM ${schema}.recipe_config WHERE shop = $1 UNION ALL SELECT 1 FROM ${schema}.salesforce_connection WHERE shop = $1 LIMIT 1`,
    [shop],
  );
  return r.rowCount === 1;
}

// Every shop the system knows anything about (setup rows AND the log): for the operator's own list, never for access decisions.
export async function listShops(pool: Pool, schema: string): Promise<string[]> {
  assertSchemaName(schema);
  const r = await pool.query(
    `SELECT shop FROM (SELECT shop FROM ${schema}.recipe_config UNION SELECT shop FROM ${schema}.salesforce_connection UNION SELECT shop FROM ${schema}.sync_log) s ORDER BY shop LIMIT 200`,
  );
  return r.rows.map((x) => x.shop as string);
}

export interface DeadJob {
  id: string;
  shop: string;
  topic: string;
  webhookId: string;
  businessKey: string;
  deadAt: string;
}

// Failed jobs, WITHOUT their payload (which holds customer data). Uses pg-boss's own API, not its tables.
export function createDeadLetters(boss: PgBoss) {
  return {
    async list(): Promise<DeadJob[]> {
      const jobs: any[] = await boss.findJobs(WEBHOOK_DEAD_QUEUE, { limit: 200 } as any);
      return jobs.map((j) => ({
        id: String(j.id),
        shop: String(j.data?.shop ?? ''),
        topic: String(j.data?.topic ?? ''),
        webhookId: String(j.data?.webhookId ?? ''),
        businessKey: String(j.data?.businessKey ?? ''),
        deadAt: new Date(j.createdOn).toISOString(),
      }));
    },
    // Moves the jobs back to the main queue; the worker picks them up again. Returns how many were moved.
    async replay(ids: string[] | 'all'): Promise<number> {
      const opts: any = { destination: WEBHOOK_QUEUE };
      if (ids !== 'all') {
        if (ids.length === 0) return 0;
        opts.ids = ids;
      }
      return boss.redrive(WEBHOOK_DEAD_QUEUE, opts);
    },
  };
}

export interface ComplianceEntry {
  id: number;
  at: string;
  kind: string;
  shop: string;
  requestRef: string;
  detail: Record<string, unknown>;
}

// Read-only view of the compliance log for the admin UI. The log holds no personal data by construction.
export class PostgresComplianceLog {
  private readonly pool: Pool;
  private readonly schema: string;
  constructor(pool: Pool, schema: string) {
    this.pool = pool;
    this.schema = assertSchemaName(schema);
  }
  private map(x: any): ComplianceEntry {
    return { id: Number(x.id), at: new Date(x.at).toISOString(), kind: x.kind, shop: x.shop, requestRef: x.request_ref, detail: x.detail };
  }
  async recent(n: number): Promise<ComplianceEntry[]> {
    const r = await this.pool.query(`SELECT id, at, kind, shop, request_ref, detail FROM ${this.schema}.compliance_log ORDER BY at DESC, id DESC LIMIT $1`, [Math.min(Math.max(n, 1), 200)]);
    return r.rows.map((x) => this.map(x));
  }
  async get(id: number): Promise<ComplianceEntry | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const r = await this.pool.query(`SELECT id, at, kind, shop, request_ref, detail FROM ${this.schema}.compliance_log WHERE id = $1`, [id]);
    return r.rows[0] ? this.map(r.rows[0]) : null;
  }
}
