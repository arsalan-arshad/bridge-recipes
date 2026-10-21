// Handlers for Shopify's privacy webhooks and the uninstall event (docs/SPEC.md section 6, BUILD_PLAN M4).
// Source of the payload shapes and timings: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
//
// Rules this file keeps:
//  - Every request runs in ONE database transaction (including the queue's own job tables): all of it happens or none of it.
//  - Idempotent: running a request twice changes nothing the second time (a retried job is harmless).
//  - It never deletes its own running job, and never touches another shop's rows.
//  - What it records about a request (compliance_log) contains NO personal data: counts, opaque Salesforce record ids, masked
//    log summaries. Salesforce Leads/Tasks already written are the MERCHANT's CRM data; this app has no delete permission there
//    by design, so a redaction lists those record ids for the merchant to review.

import { assertSchemaName } from '../queue/migrate.ts';
import { WEBHOOK_DEAD_QUEUE, WEBHOOK_QUEUE } from '../queue/config.ts';
import { LIFECYCLE_TOPICS, UNINSTALL_TOPIC, isLifecycleTopic } from './topics.ts';
import type { MinimizedRequest } from './topics.ts';
import type { Job } from '../gateway/types.ts';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';

export interface ComplianceDeps {
  pool: pg.Pool;
  schema: string;
  boss: PgBoss;
  now: () => Date;
}

export class ComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceError';
  }
}

const gid = (orderId: string) => `gid://shopify/Order/${orderId}`;
const MAX_REPORT_ORDERS = 500;

function parseRequest(job: Job): MinimizedRequest {
  let v: any;
  try {
    v = JSON.parse(job.payload);
  } catch {
    throw new ComplianceError('lifecycle payload is not JSON');
  }
  if (!v || typeof v !== 'object' || v.topic !== job.topic || !isLifecycleTopic(v.topic) || typeof v.shopDomain !== 'string' || v.shopDomain !== job.shop || !Array.isArray(v.orders) || !v.orders.every((o: unknown) => typeof o === 'string' && /^[0-9]{1,16}$/.test(o))) {
    throw new ComplianceError('lifecycle payload has an unexpected shape');
  }
  return { topic: v.topic, shopDomain: v.shopDomain, orders: v.orders, requestId: typeof v.requestId === 'string' ? v.requestId : null };
}

type Tx = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

// Deletes queue jobs (they carry raw payloads) for a shop inside OUR transaction, via pg-boss's own API.
async function deleteQueueJobs(boss: PgBoss, tx: Tx, shop: string, keep: (data: any) => boolean): Promise<number> {
  const db = { executeSql: (text: string, values?: unknown[]) => tx.query(text, values) };
  let removed = 0;
  for (const queue of [WEBHOOK_QUEUE, WEBHOOK_DEAD_QUEUE]) {
    const jobs: any[] = await boss.findJobs(queue, { data: { shop }, limit: 100_000, db } as any);
    const ids = jobs.filter((j) => keep(j.data)).map((j) => String(j.id));
    if (ids.length > 0) {
      await boss.deleteJob(queue, ids, { db } as any);
      removed += ids.length;
    }
  }
  return removed;
}

async function record(tx: Tx, schema: string, now: Date, req: MinimizedRequest, requestRef: string, detail: Record<string, unknown>): Promise<void> {
  await tx.query(
    `INSERT INTO ${schema}.compliance_log (at, kind, shop, request_ref, detail) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (kind, request_ref) DO NOTHING`,
    [now.toISOString(), req.topic, req.shopDomain, requestRef, JSON.stringify(detail)],
  );
}

async function inTransaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client as unknown as Tx);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// customers/redact: erase everything we hold about the listed orders.
async function redactCustomer(job: Job, req: MinimizedRequest, d: ComplianceDeps) {
  const schema = assertSchemaName(d.schema);
  const gids = req.orders.map(gid);
  const businessKeys = new Set(req.orders.map((o) => `orders/paid|${req.shopDomain}|${gid(o)}`));
  return inTransaction(d.pool, async (tx) => {
    // Salesforce record ids are read BEFORE the mapping is deleted, so the merchant can review those records.
    const map = await tx.query(
      `SELECT sf_type, sf_id FROM ${schema}.entity_map WHERE (shop = $1 OR shop IS NULL) AND substring(match_key FROM position(':' IN match_key) + 1) = ANY($2)`,
      [req.shopDomain, gids],
    );
    const sfRecords = map.rows.map((r) => `${r.sf_type}:${r.sf_id}`);
    const log = await tx.query(`DELETE FROM ${schema}.sync_log WHERE shop = $1 AND object_id = ANY($2)`, [req.shopDomain, gids]);
    const entities = await tx.query(
      `DELETE FROM ${schema}.entity_map WHERE (shop = $1 OR shop IS NULL) AND substring(match_key FROM position(':' IN match_key) + 1) = ANY($2)`,
      [req.shopDomain, gids],
    );
    const intake = await tx.query(`DELETE FROM ${schema}.webhook_intake WHERE shop = $1 AND business_key = ANY($2)`, [req.shopDomain, [...businessKeys]]);
    const jobs = await deleteQueueJobs(d.boss, tx, req.shopDomain, (data) => data?.topic === 'orders/paid' && businessKeys.has(data?.businessKey));
    const deleted = { syncLog: log.rowCount ?? 0, entityMap: entities.rowCount ?? 0, intake: intake.rowCount ?? 0, queueJobs: jobs };
    await record(tx, schema, d.now(), req, job.webhookId, {
      orders: req.orders.length,
      deleted,
      salesforceRecordsToReview: sfRecords.slice(0, 500),
      note: 'Leads/Tasks already written to the merchant Salesforce org are the merchant\'s own CRM records; this app cannot delete them (no delete permission). Review the listed record ids in Salesforce.',
    });
    return deleted;
  });
}

// customers/data_request: report what we hold. Nothing is deleted.
async function dataRequest(job: Job, req: MinimizedRequest, d: ComplianceDeps) {
  const schema = assertSchemaName(d.schema);
  const gids = req.orders.map(gid);
  const businessKeys = req.orders.map((o) => `orders/paid|${req.shopDomain}|${gid(o)}`);
  return inTransaction(d.pool, async (tx) => {
    const log = await tx.query(`SELECT object_id, at, outcome, dry_run, reason FROM ${schema}.sync_log WHERE shop = $1 AND object_id = ANY($2) ORDER BY at`, [req.shopDomain, gids]);
    const map = await tx.query(`SELECT match_key, sf_type, sf_id FROM ${schema}.entity_map WHERE (shop = $1 OR shop IS NULL) AND substring(match_key FROM position(':' IN match_key) + 1) = ANY($2)`, [req.shopDomain, gids]);
    const intake = await tx.query(`SELECT count(*)::int AS n FROM ${schema}.webhook_intake WHERE shop = $1 AND business_key = ANY($2)`, [req.shopDomain, businessKeys]);
    const bks = new Set(businessKeys);
    let queued = 0;
    const db = { executeSql: (text: string, values?: unknown[]) => tx.query(text, values) };
    for (const queue of [WEBHOOK_QUEUE, WEBHOOK_DEAD_QUEUE]) {
      const jobs: any[] = await d.boss.findJobs(queue, { data: { shop: req.shopDomain }, limit: 100_000, db } as any);
      queued += jobs.filter((j) => j.data?.topic === 'orders/paid' && bks.has(j.data?.businessKey)).length;
    }
    const orders = req.orders.slice(0, MAX_REPORT_ORDERS).map((o) => {
      const g = gid(o);
      return {
        shopifyOrderId: o,
        syncLog: log.rows.filter((r) => r.object_id === g).map((r) => ({ at: new Date(r.at).toISOString(), outcome: r.outcome, dryRun: r.dry_run, reason: r.reason })),
        salesforceRecords: map.rows.filter((r) => r.match_key.endsWith(`:${g}`)).map((r) => `${r.sf_type}:${r.sf_id}`),
      };
    });
    const report = {
      requestedOrders: req.orders.length,
      listedOrders: orders.length,
      dataRequestId: req.requestId,
      heldHere: {
        syncLogEntries: log.rows.length,
        salesforceRecordMappings: map.rows.length,
        deliveryRecords: intake.rows[0].n,
        queuedJobsWithRawPayload: queued,
      },
      orders,
      note: 'This app keeps order ids, outcomes and Salesforce record ids, with personal values masked in the log. Names, emails and order details that were written to Salesforce live in those Salesforce records (listed above) and in Shopify; provide those to the customer from there.',
    };
    await record(tx, schema, d.now(), req, job.webhookId, report);
    return report.heldHere;
  });
}

// shop/redact (48 hours after uninstall): erase everything for the shop, credentials included.
async function redactShop(job: Job, req: MinimizedRequest, d: ComplianceDeps) {
  const schema = assertSchemaName(d.schema);
  return inTransaction(d.pool, async (tx) => {
    const sfRecords = (await tx.query(`SELECT sf_type, sf_id FROM ${schema}.entity_map WHERE shop = $1`, [req.shopDomain])).rows.map((r) => `${r.sf_type}:${r.sf_id}`);
    const del = async (table: string, column = 'shop') => (await tx.query(`DELETE FROM ${schema}.${table} WHERE ${column} = $1`, [req.shopDomain])).rowCount ?? 0;
    const deleted = {
      syncLog: await del('sync_log'),
      entityMap: await del('entity_map'),
      // Delivery records of the lifecycle requests themselves are kept (a delivery id and a topic, nothing personal): they stop a
      // Shopify retry of this very request from running it again, and they age out with the intake retention window.
      intake: (await tx.query(`DELETE FROM ${schema}.webhook_intake WHERE shop = $1 AND topic <> ALL($2)`, [req.shopDomain, [...LIFECYCLE_TOPICS]])).rowCount ?? 0,
      recipeConfig: await del('recipe_config'),
      salesforceConnection: await del('salesforce_connection'),
      adminAudit: await del('admin_audit'),
      earlierComplianceRecords: await del('compliance_log'),
      queueJobs: await deleteQueueJobs(d.boss, tx, req.shopDomain, (data) => !isLifecycleTopic(String(data?.topic ?? ''))),
    };
    // The only thing left behind is this non-personal record of the erasure itself (it ages out with the compliance log).
    await record(tx, schema, d.now(), req, job.webhookId, {
      deleted,
      salesforceRecordsToReview: sfRecords.slice(0, 500),
      note: 'All data this app held for the shop was deleted, including the stored Salesforce credentials. Records already written to the merchant Salesforce org are the merchant\'s own and were not touched.',
    });
    return deleted;
  });
}

// app/uninstalled: stop working for the shop and drop its credentials now (the rest is erased by shop/redact 48 hours later).
async function uninstalled(job: Job, req: MinimizedRequest, d: ComplianceDeps) {
  const schema = assertSchemaName(d.schema);
  return inTransaction(d.pool, async (tx) => {
    const recipes = (await tx.query(`UPDATE ${schema}.recipe_config SET enabled = false, updated_at = now() WHERE shop = $1 AND enabled`, [req.shopDomain])).rowCount ?? 0;
    const credentials = (await tx.query(`DELETE FROM ${schema}.salesforce_connection WHERE shop = $1`, [req.shopDomain])).rowCount ?? 0;
    const queueJobs = await deleteQueueJobs(d.boss, tx, req.shopDomain, (data) => !isLifecycleTopic(String(data?.topic ?? '')));
    const done = { recipesDisabled: recipes, credentialsDeleted: credentials, queueJobs };
    await record(tx, schema, d.now(), req, job.webhookId, { ...done, note: 'Recipes disabled, Salesforce credentials deleted and queued jobs removed. Remaining shop data is erased when Shopify sends shop/redact.' });
    return done;
  });
}

export async function handleLifecycleJob(job: Job, d: ComplianceDeps): Promise<Record<string, unknown>> {
  const req = parseRequest(job);
  if (req.topic === 'customers/redact') return redactCustomer(job, req, d);
  if (req.topic === 'customers/data_request') return dataRequest(job, req, d);
  if (req.topic === 'shop/redact') return redactShop(job, req, d);
  if (req.topic === UNINSTALL_TOPIC) return uninstalled(job, req, d);
  throw new ComplianceError('unknown lifecycle topic');
}
