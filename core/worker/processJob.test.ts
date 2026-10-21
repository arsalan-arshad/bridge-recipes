import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processJob } from './processJob.ts';
import { MemoryConfigStore } from './recipe.ts';
import { MemorySyncLog } from './syncLog.ts';
import { MemoryEntityStore } from '../executor/entityStore.ts';
import { SalesforceError } from '../salesforce/client.ts';
import { r1Recipe, R1_DEFAULT_CONFIG, R1_ID } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';
import type { Job } from '../gateway/types.ts';
import type { WorkerDeps } from './processJob.ts';

const payloads = join(import.meta.dirname, '..', '..', 'recipes', 'retail-b2b-lead-spotter', 'payloads');
const SUB = readFileSync(join(payloads, 'SHOPIFY_real_orders_paid_2026-10_subscribed.json'), 'utf8');
const UNSUB = readFileSync(join(payloads, 'SHOPIFY_real_orders_paid_2026-10_not_subscribed.json'), 'utf8');
const SHOP = 's.myshopify.com';

const job = (over: Partial<Job> = {}): Job => ({
  webhookId: 'wh-1', eventId: 'ev-1', topic: 'orders/paid', shop: SHOP, apiVersion: '2026-10',
  businessKey: 'orders/paid|s.myshopify.com|1', receivedAt: '2026-10-20T00:00:00.000Z', payload: SUB, ...over,
});

interface Script {
  accounts?: any[]; leads?: any[]; contacts?: any[];
  create?: (type: string, fields: any, n: number) => { id: string } | Error;
  queryError?: Error;
  description?: string;
}
function setup(settings: { enabled: boolean; dryRun: boolean; config?: any } | null, script: Script = {}) {
  const calls = { queries: [] as string[], creates: [] as { type: string; fields: any }[], updates: [] as any[] };
  const sf = {
    async query(soql: string) {
      calls.queries.push(soql);
      if (script.queryError) throw script.queryError;
      if (soql.includes('FROM Account')) return script.accounts ?? [];
      if (soql.includes('FROM Lead')) return script.leads ?? [];
      return script.contacts ?? [];
    },
    async create(type: string, fields: any) {
      calls.creates.push({ type, fields });
      const r = script.create ? script.create(type, fields, calls.creates.length) : { id: `${type[0]}0${calls.creates.length}`.padEnd(15, '0') };
      if (r instanceof Error) throw r;
      return r;
    },
    async update(type: string, id: string, fields: any) { calls.updates.push({ type, id, fields }); },
    async getRecord() { return { Description: script.description ?? '' }; },
  };
  const configs = new MemoryConfigStore();
  if (settings) configs.set(SHOP, R1_ID, { enabled: settings.enabled, dryRun: settings.dryRun, config: settings.config ?? R1_DEFAULT_CONFIG });
  const log = new MemorySyncLog();
  const entities = new MemoryEntityStore();
  const deps: WorkerDeps = { recipes: [r1Recipe], configs, sf, entities, log, now: () => new Date('2026-10-20T10:00:00.000Z') };
  return { deps, calls, log, entities };
}
const LIVE = { enabled: true, dryRun: false };
const err = (kind: any, code: string) => new SalesforceError(kind, kind === 'transient' ? 503 : 400, code, 'x');

test('live: a subscribed corporate order creates one Lead and logs it', async () => {
  const { deps, calls, log } = setup(LIVE);
  assert.equal(await processJob(job(), deps), 'created');
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].type, 'Lead');
  assert.deepEqual(calls.creates[0].fields, {
    Company: 'Acme Test Co', LastName: 'Buyer', Email: 'test-buyer@example.com', LeadSource: 'Shopify Order',
    Description: 'Order #1005: The Compare at Price Snowboard. Total: 785.95 USD',
  });
  assert.equal(log.entries.length, 1);
  const e = log.entries[0];
  assert.deepEqual([e.outcome, e.recipeId, e.topic, e.shop, e.dryRun, e.objectId], ['created', R1_ID, 'orders/paid', SHOP, false, 'gid://shopify/Order/18948632412213']);
  assert.equal(e.ops![0].sfId!.startsWith('L0'), true);
});

test('dry-run: lookups and decide run, NOTHING is written, and the log shows the planned op with personal values masked', async () => {
  const { deps, calls, log, entities } = setup({ enabled: true, dryRun: true });
  assert.equal(await processJob(job(), deps), 'dry_run');
  assert.equal(calls.creates.length + calls.updates.length, 0);
  assert.ok(calls.queries.length >= 2, 'read-only lookups still ran');
  assert.equal(entities.map.size, 0);
  const planned = log.entries[0].ops![0].planned as any;
  assert.equal(planned.kind, 'createLead');
  assert.equal(planned.fields.Email, 't***@example.com');
  assert.equal(planned.fields.LastName, 'B***');
  assert.equal(planned.fields.Company, 'Acme Test Co');
});

test('kill switch: disabled recipe makes ZERO Salesforce calls; not configured counts as disabled', async () => {
  for (const settings of [{ enabled: false, dryRun: false }, null]) {
    const { deps, calls, log } = setup(settings);
    assert.equal(await processJob(job(), deps), 'recipe_disabled');
    assert.equal(calls.queries.length + calls.creates.length + calls.updates.length, 0);
    assert.equal(log.entries.length, 1);
  }
});

test('unknown topic: logged, no calls, no throw', async () => {
  const { deps, calls, log } = setup(LIVE);
  assert.equal(await processJob(job({ topic: 'products/update' }), deps), 'unknown_topic');
  assert.equal(calls.queries.length + calls.creates.length, 0);
  assert.equal(log.entries.length, 1, 'it is still logged');
  assert.deepEqual([log.entries[0].outcome, log.entries[0].topic, log.entries[0].webhookId], ['unknown_topic', 'products/update', 'wh-1']);
});

test('skips that need no Salesforce data are final and cost ZERO API calls (no consent, free domain, below minimum)', async () => {
  const gmail = JSON.stringify({ ...JSON.parse(SUB), customer: { ...JSON.parse(SUB).customer, email: 'x@gmail.com' }, contact_email: 'x@gmail.com', email: 'x@gmail.com' });
  const cases: [string, string, any][] = [
    ['no_consent', UNSUB, R1_DEFAULT_CONFIG],
    ['free_or_denied_domain', gmail, R1_DEFAULT_CONFIG],
    ['below_minimum', SUB, { ...R1_DEFAULT_CONFIG, minOrderTotal: 100000 }],
  ];
  for (const [reason, payload, config] of cases) {
    const { deps, calls, log } = setup({ ...LIVE, config });
    assert.equal(await processJob(job({ payload }), deps), 'skipped', reason);
    assert.equal(log.entries[0].reason, reason);
    assert.equal(calls.queries.length + calls.creates.length, 0, `${reason}: no Salesforce call`);
  }
});

test('an existing Lead (found by lookup) is updated, not duplicated', async () => {
  const { deps, calls } = setup(LIVE, { leads: [{ Id: '00Qaaaaaaaaaaaa1' }], description: 'old' });
  assert.equal(await processJob(job(), deps), 'updated');
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.updates[0].id, '00Qaaaaaaaaaaaa1');
});

test('an existing Account by domain gets a Task for its owner; an existing Contact gets a Task for the Contact', async () => {
  const a = setup(LIVE, { accounts: [{ Id: '001Aaaaaaaaaaaa1', OwnerId: '005OWNER00000001', Website: 'https://www.example.com' }] });
  assert.equal(await processJob(job(), a.deps), 'created');
  assert.equal(a.calls.creates[0].type, 'Task');
  assert.equal(a.calls.creates[0].fields.WhatId, '001Aaaaaaaaaaaa1');
  assert.equal(a.calls.creates[0].fields.OwnerId, '005OWNER00000001');
  const c = setup(LIVE, { contacts: [{ Id: '003Caaaaaaaaaaa1', AccountId: '001Bbbbbbbbbbbb1', OwnerId: '005OWNER00000002' }] });
  assert.equal(await processJob(job(), c.deps), 'created');
  assert.equal(c.calls.creates[0].fields.WhoId, '003Caaaaaaaaaaa1');
  assert.equal(c.calls.creates[0].fields.OwnerId, '005OWNER00000002');
});

test('transient failure: logged as retry and re-thrown; the retry then writes once; a redelivery after that writes nothing', async () => {
  const { deps, calls, log, entities } = setup(LIVE, { create: (t, f, n) => (n === 1 ? err('transient', 'UNKNOWN_EXCEPTION') : { id: '00Qdddddddddddd1' }) });
  await assert.rejects(() => processJob(job(), deps), (e: any) => e instanceof SalesforceError && e.kind === 'transient');
  assert.equal(log.entries.at(-1)!.outcome, 'retry');
  assert.equal(log.entries.at(-1)!.errorClass, 'transient');
  assert.equal(entities.map.size, 0);
  assert.equal(await processJob(job(), deps), 'created');
  assert.equal(calls.creates.length, 2);
  assert.equal(await processJob(job(), deps), 'already_done');
  assert.equal(calls.creates.length, 2, 'the redelivery wrote nothing');
});

test('a failing LOOKUP (rate limit) is retryable too, and nothing is written', async () => {
  const { deps, calls, log } = setup(LIVE, { queryError: err('rate_limit', 'REQUEST_LIMIT_EXCEEDED') });
  await assert.rejects(() => processJob(job(), deps), (e: any) => e.kind === 'rate_limit');
  assert.equal(log.entries[0].outcome, 'retry');
  assert.equal(calls.creates.length, 0);
});

test('permanent Salesforce error: logged as failed (not retry) with its class and code, then re-thrown', async () => {
  const { deps, log } = setup(LIVE, { create: () => err('permanent', 'REQUIRED_FIELD_MISSING') });
  await assert.rejects(() => processJob(job(), deps), (e: any) => e.kind === 'permanent');
  assert.deepEqual([log.entries[0].outcome, log.entries[0].errorClass, log.entries[0].errorCode], ['failed', 'permanent', 'REQUIRED_FIELD_MISSING']);
});

test('unexpected (non-Salesforce) error: logged as failed/internal WITHOUT its message, re-thrown', async () => {
  const boom = { ...r1Recipe, decide: () => { throw new TypeError('secret customer@acme.com detail'); } };
  const { deps, log } = setup(LIVE);
  await assert.rejects(() => processJob(job(), { ...deps, recipes: [boom] }), TypeError);
  assert.equal(log.entries[0].outcome, 'failed');
  assert.equal(log.entries[0].errorClass, 'internal');
  assert.ok(!JSON.stringify(log.entries).includes('customer@acme.com'));
});

test('duplicate rule hit: duplicate_detected is logged, NOT thrown and NOT remembered; a later replay can succeed', async () => {
  let dup = true;
  const { deps, calls, log, entities } = setup(LIVE, { create: () => (dup ? new SalesforceError('duplicate', 400, 'DUPLICATES_DETECTED', 'x', ['00Qaaaaaaaaaaaa1']) : { id: '00Qeeeeeeeeeeee1' }) });
  assert.equal(await processJob(job(), deps), 'duplicate_detected');
  assert.equal(calls.creates.length, 1);
  assert.equal(entities.map.size, 0);
  dup = false;
  assert.equal(await processJob(job(), deps), 'created');
  assert.equal(log.entries.length, 2);
});

test('invalid payloads are logged and dropped without calls or retries', async () => {
  for (const [payload, reason] of [['{not json', 'not_json'], [JSON.stringify({ hello: 'world' }), 'missing_order_id']] as const) {
    const { deps, calls, log } = setup(LIVE);
    assert.equal(await processJob(job({ payload }), deps), 'invalid_payload');
    assert.equal(log.entries[0].reason, reason);
    assert.equal(calls.queries.length + calls.creates.length, 0);
  }
});

test('the sync log never contains the payload, the customer email or the last name (live, dry-run, skip, failure)', async () => {
  const runs: [any, Script?][] = [[LIVE], [{ enabled: true, dryRun: true }], [{ ...LIVE, config: { ...R1_DEFAULT_CONFIG, minOrderTotal: 1e9 } }], [LIVE, { create: () => err('permanent', 'X') }]];
  for (const [settings, script] of runs) {
    const { deps, log } = setup(settings, script);
    await processJob(job(), deps).catch(() => {});
    const text = JSON.stringify(log.entries);
    for (const leak of ['test-buyer@example.com', '"Buyer"', '"payload"', '100 Example Way']) assert.ok(!text.includes(leak), `leak: ${leak}`);
  }
});

// ---- per-shop Salesforce client resolved lazily --------------------------------------------------------
test('sf as a function: resolved with the job shop, only when Salesforce is actually needed', async () => {
  const base = setup(LIVE);
  const asked: string[] = [];
  const deps = { ...base.deps, sf: async (shop: string) => { asked.push(shop); return base.deps.sf as any; } } as WorkerDeps;
  assert.equal(await processJob(job(), deps), 'created');
  assert.deepEqual(asked, [SHOP]);
});

test('sf as a function is NEVER resolved for a disabled recipe, an unknown topic, an early skip or an invalid payload', async () => {
  const mk = (settings: any) => {
    const base = setup(settings);
    let resolved = 0;
    return { deps: { ...base.deps, sf: async () => { resolved++; throw new Error('should not be asked'); } } as unknown as WorkerDeps, resolved: () => resolved };
  };
  const disabled = mk({ enabled: false, dryRun: false });
  await processJob(job(), disabled.deps);
  const unknown = mk(LIVE);
  await processJob(job({ topic: 'products/update' }), unknown.deps);
  const early = mk(LIVE);
  await processJob(job({ payload: UNSUB }), early.deps);
  const invalid = mk(LIVE);
  await processJob(job({ payload: '{nope' }), invalid.deps);
  assert.deepEqual([disabled.resolved(), unknown.resolved(), early.resolved(), invalid.resolved()], [0, 0, 0, 0]);
});

test('a missing Salesforce connection is logged as a retry (not a crash) and re-thrown, so the owner can add one in time', async () => {
  const base = setup(LIVE);
  const deps = { ...base.deps, sf: async () => { throw new SalesforceError('auth', 0, 'NO_CONNECTION', 'no Salesforce connection is stored for this shop'); } } as unknown as WorkerDeps;
  await assert.rejects(() => processJob(job(), deps), (e: any) => e.errorCode === 'NO_CONNECTION');
  assert.deepEqual([base.log.entries[0].outcome, base.log.entries[0].errorClass, base.log.entries[0].errorCode], ['retry', 'auth', 'NO_CONNECTION']);
});

// ---- lifecycle (privacy / uninstall) jobs --------------------------------------------------------------------
test('lifecycle jobs go to the lifecycle handler: no recipe, no Salesforce, NO sync-log entry', async () => {
  const base = setup(LIVE);
  const seen: string[] = [];
  const deps = { ...base.deps, lifecycle: async (j: Job) => void seen.push(j.topic) } as WorkerDeps;
  for (const topic of ['customers/redact', 'customers/data_request', 'shop/redact', 'app/uninstalled']) {
    assert.equal(await processJob(job({ topic, payload: '{}' }), deps), 'lifecycle_done', topic);
  }
  assert.deepEqual(seen, ['customers/redact', 'customers/data_request', 'shop/redact', 'app/uninstalled']);
  assert.equal(base.log.entries.length, 0, 'a shop being erased must not get a new log row');
  assert.equal(base.calls.queries.length + base.calls.creates.length, 0);
});

test('a failing lifecycle handler propagates (so the queue retries, then dead-letters) and logs nothing', async () => {
  const base = setup(LIVE);
  const deps = { ...base.deps, lifecycle: async () => { throw new Error('database down'); } } as WorkerDeps;
  await assert.rejects(() => processJob(job({ topic: 'customers/redact', payload: '{}' }), deps), /database down/);
  assert.equal(base.log.entries.length, 0);
});

test('ordinary topics never reach the lifecycle handler', async () => {
  const base = setup(LIVE);
  let called = 0;
  const deps = { ...base.deps, lifecycle: async () => void called++ } as WorkerDeps;
  assert.equal(await processJob(job(), deps), 'created');
  assert.equal(called, 0);
});

test('describeOp (what a dry-run stores) keeps no names, phone or free text: only masked values and sizes (Company stays for the preview)', async () => {
  const { describeOp } = await import('./syncLog.ts');
  const d: any = describeOp({ kind: 'create', matchKey: 'r1:x', type: 'Lead', fields: { Email: 'jane.doe@acme.com', LastName: 'Doe', FirstName: 'Jane', Company: 'Jane Doe Consulting', Description: 'Order #1 shipping to 1 Example Way', Phone: '555-1234', Status: 'Open' } } as any);
  const text = JSON.stringify(d);
  for (const leak of ['jane.doe', 'Doe"', 'Jane"', 'Example Way', '555-1234']) assert.ok(!text.includes(leak), leak);
  assert.equal(d.fields.Status, 'Open');
  assert.equal(d.fields.Email, 'j***@acme.com');
});
