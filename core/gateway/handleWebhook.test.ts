import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleWebhook } from './handleWebhook.ts';
import { MemoryIntake } from './memoryIntake.ts';
import type { GatewayDeps, Intake, Job, LogEntry } from './types.ts';

const SECRET = 'test-signing-secret';
// A real (sanitised) orders/paid delivery body from the dev store.
const BODY = readFileSync(
  join(import.meta.dirname, '..', '..', 'recipes', 'retail-b2b-lead-spotter', 'payloads', 'SHOPIFY_real_orders_paid_2026-10_subscribed.json'),
  'utf8',
);
const sign = (raw: Buffer | string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('base64');

function headers(over: Record<string, string | undefined> = {}, raw: Buffer | string = BODY) {
  return {
    'x-shopify-hmac-sha256': sign(raw),
    'x-shopify-topic': 'orders/paid',
    'x-shopify-shop-domain': 'example-store.myshopify.com',
    'x-shopify-webhook-id': 'wh-1',
    'x-shopify-event-id': 'ev-1',
    'x-shopify-api-version': '2026-10',
    ...over,
  };
}

function setup(intake: Intake = new MemoryIntake(), topics = ['orders/paid']) {
  const log: LogEntry[] = [];
  const deps: GatewayDeps = {
    secret: SECRET,
    intake,
    topics: new Set(topics),
    now: () => new Date('2026-10-19T12:00:00.000Z'),
    log: (e) => log.push(e),
  };
  return { deps, log };
}
const raw = Buffer.from(BODY);

// ---- M1 test 1: forged webhook -------------------------------------------------------------------------
test('forged webhook: wrong signature -> 401, nothing enqueued', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  const r = await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-hmac-sha256': sign(raw, 'attacker-secret') }) }, deps);
  assert.deepEqual(r, { status: 401, outcome: 'unauthorized' });
  assert.equal(intake.jobs.length, 0);
});

test('forged webhook: missing, empty or garbage signature -> 401', async () => {
  const { deps } = setup();
  for (const sig of [undefined, '', 'AAAA', 'not base64 !!']) {
    const r = await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-hmac-sha256': sig }) }, deps);
    assert.equal(r.status, 401, String(sig));
  }
});

test('signature is checked BEFORE parsing: invalid JSON with a bad signature is 401, not 400', async () => {
  const { deps } = setup();
  const junk = Buffer.from('{not json');
  const r = await handleWebhook({ rawBody: junk, headers: headers({ 'x-shopify-hmac-sha256': 'AAAA' }, junk) }, deps);
  assert.equal(r.status, 401);
});

test('signature is over the raw bytes: a re-serialised body does not verify', async () => {
  const { deps } = setup();
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(BODY)));
  assert.notEqual(reserialised.toString(), BODY);
  const r = await handleWebhook({ rawBody: reserialised, headers: headers() /* signed over the original */ }, deps);
  assert.equal(r.status, 401);
});

test('a forged request is logged by OUTCOME ONLY: attacker-controlled header values are never written to the log', async () => {
  const { deps, log } = setup();
  await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-hmac-sha256': 'AAAA', 'x-shopify-topic': 'x\n{"level":"error","event":"fake"}', 'x-shopify-shop-domain': '<script>evil', 'x-shopify-webhook-id': 'inject-me' }) }, deps);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], { outcome: 'unauthorized', topic: '', shop: '', webhookId: '' });
});

test('after the signature checks out, the log carries topic, shop and delivery id', async () => {
  const { deps, log } = setup();
  await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  assert.deepEqual(log[0], { outcome: 'accepted', topic: 'orders/paid', shop: 'example-store.myshopify.com', webhookId: 'wh-1' });
});

test('the shop header must look like a Shopify shop domain (verified requests only): anything else is a 400 and queues nothing', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  for (const shop of ['', 'evil.com', 'a b.myshopify.com', '<script>.myshopify.com', 'x.myshopify.com.evil.io', "a'--.myshopify.com", '.myshopify.com', 'shop.myshopify.com/x']) {
    const r = await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-shop-domain': shop }) }, deps);
    assert.equal(r.status, 400, JSON.stringify(shop));
  }
  assert.equal(intake.jobs.length, 0);
  assert.equal((await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-shop-domain': 'Example-Store.MyShopify.com' }) }, deps)).status, 200, 'case is ignored');
});

// ---- M1 test 2: duplicate delivery ---------------------------------------------------------------------
test('valid delivery is accepted once: 200, one job with the expected fields', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  const r = await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  assert.deepEqual(r, { status: 200, outcome: 'accepted' });
  assert.equal(intake.jobs.length, 1);
  const j: Job = intake.jobs[0];
  assert.equal(j.webhookId, 'wh-1');
  assert.equal(j.eventId, 'ev-1');
  assert.equal(j.topic, 'orders/paid');
  assert.equal(j.shop, 'example-store.myshopify.com');
  assert.equal(j.apiVersion, '2026-10');
  assert.equal(j.businessKey, 'orders/paid|example-store.myshopify.com|gid://shopify/Order/18948632412213');
  assert.equal(j.receivedAt, '2026-10-19T12:00:00.000Z');
  assert.equal(j.payload, BODY);
});

test('duplicate delivery (Shopify retry, same Webhook-Id): 200 and still exactly one job', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  const first = await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  const retry = await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  assert.equal(first.outcome, 'accepted');
  assert.deepEqual(retry, { status: 200, outcome: 'duplicate' });
  assert.equal(intake.jobs.length, 1);
});

test('same order, different Webhook-Id (business key): still one job', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  const again = await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-webhook-id': 'wh-2', 'x-shopify-event-id': 'ev-2' }) }, deps);
  assert.equal(again.outcome, 'duplicate');
  assert.equal(intake.jobs.length, 1);
});

test('same Event-Id alone is NOT a duplicate (it is shared across subscriptions)', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  const other = JSON.stringify({ ...JSON.parse(BODY), admin_graphql_api_id: 'gid://shopify/Order/999' });
  const r = await handleWebhook({ rawBody: Buffer.from(other), headers: headers({ 'x-shopify-webhook-id': 'wh-9' }, other) }, deps);
  assert.equal(r.outcome, 'accepted');
  assert.equal(intake.jobs.length, 2);
});

test('different orders are independent jobs', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  const other = JSON.stringify({ ...JSON.parse(BODY), admin_graphql_api_id: 'gid://shopify/Order/2' });
  await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  await handleWebhook({ rawBody: Buffer.from(other), headers: headers({ 'x-shopify-webhook-id': 'wh-2' }, other) }, deps);
  assert.equal(intake.jobs.length, 2);
});

// ---- M1 test 3 (gateway side): outage and recovery ------------------------------------------------------
test('intake outage: 500 (so Shopify retries), nothing recorded; the retry is then accepted, not lost', async () => {
  const inner = new MemoryIntake();
  let down = true;
  const flaky: Intake = {
    async accept(job) {
      if (down) throw new Error('database unavailable');
      return inner.accept(job);
    },
  };
  const { deps } = setup(flaky);
  const during = await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  assert.deepEqual(during, { status: 500, outcome: 'intake_error' });
  assert.equal(inner.jobs.length, 0);
  down = false;
  const retry = await handleWebhook({ rawBody: raw, headers: headers() }, deps); // same Webhook-Id as the failed try
  assert.deepEqual(retry, { status: 200, outcome: 'accepted' });
  assert.equal(inner.jobs.length, 1);
});

// ---- other gateway rules --------------------------------------------------------------------------------
test('verified but malformed: missing topic or webhook id, or invalid JSON -> 400', async () => {
  const { deps } = setup();
  assert.equal((await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-topic': undefined }) }, deps)).status, 400);
  assert.equal((await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-webhook-id': undefined }) }, deps)).status, 400);
  const junk = Buffer.from('{not json');
  assert.equal((await handleWebhook({ rawBody: junk, headers: headers({}, junk) }, deps)).status, 400);
});

test('topic nobody listens to: acknowledged with 200, not queued', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake, ['orders/paid']);
  const r = await handleWebhook({ rawBody: raw, headers: headers({ 'x-shopify-topic': 'products/update' }) }, deps);
  assert.deepEqual(r, { status: 200, outcome: 'ignored_topic' });
  assert.equal(intake.jobs.length, 0);
});

test('payload without an object id: business key falls back to the Webhook-Id', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  const body = Buffer.from('{"hello":"world"}');
  await handleWebhook({ rawBody: body, headers: headers({}, body) }, deps);
  assert.equal(intake.jobs[0].businessKey, 'wh-1');
});

test('header lookup accepts array-valued headers', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake);
  await handleWebhook({ rawBody: raw, headers: { ...headers(), 'x-shopify-topic': ['orders/paid', 'x'] } }, deps);
  assert.equal(intake.jobs[0].topic, 'orders/paid');
});

test('log entries never contain the payload or customer data', async () => {
  const { deps, log } = setup();
  await handleWebhook({ rawBody: raw, headers: headers() }, deps);
  const s = JSON.stringify(log);
  for (const leak of ['test-buyer@example.com', 'Acme Test Co', 'Buyer', '785.95']) assert.ok(!s.includes(leak), leak);
});

// ---- compliance and uninstall deliveries -----------------------------------------------------------------
const redactBody = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ shop_id: 954889, shop_domain: 'example-store.myshopify.com', customer: { id: 191167, email: 'john@example.com', phone: '555-625-1199' }, orders_to_redact: [299938, 280263], ...over }));
const lifecycleHeaders = (raw: Buffer, topic: string, webhookId: string, shop = 'example-store.myshopify.com') => ({
  'x-shopify-hmac-sha256': sign(raw), 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': webhookId, 'x-shopify-event-id': 'ev',
});
const LIFECYCLE = ['customers/data_request', 'customers/redact', 'shop/redact', 'app/uninstalled'];

test('compliance: accepted with 200, queued with ONLY order ids (no email, phone or customer id), keyed by the delivery id', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake, [...LIFECYCLE, 'orders/paid']);
  const raw = redactBody();
  assert.deepEqual(await handleWebhook({ rawBody: raw, headers: lifecycleHeaders(raw, 'customers/redact', 'wh-c1') }, deps), { status: 200, outcome: 'accepted' });
  const j = intake.jobs[0];
  assert.equal(j.businessKey, 'wh-c1');
  assert.deepEqual(JSON.parse(j.payload), { topic: 'customers/redact', shopDomain: 'example-store.myshopify.com', orders: ['299938', '280263'], requestId: null });
  for (const leak of ['john@example.com', '555-625-1199', '191167']) assert.ok(!j.payload.includes(leak), leak);
});

test('compliance: two DIFFERENT requests for the same shop are both processed; a Shopify retry of one is a duplicate', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake, LIFECYCLE);
  const a = redactBody({ orders_to_redact: [1] });
  const b = redactBody({ orders_to_redact: [2] });
  assert.equal((await handleWebhook({ rawBody: a, headers: lifecycleHeaders(a, 'customers/redact', 'wh-a') }, deps)).outcome, 'accepted');
  assert.equal((await handleWebhook({ rawBody: b, headers: lifecycleHeaders(b, 'customers/redact', 'wh-b') }, deps)).outcome, 'accepted', 'must not be deduped as the same shop');
  assert.equal((await handleWebhook({ rawBody: a, headers: lifecycleHeaders(a, 'customers/redact', 'wh-a') }, deps)).outcome, 'duplicate');
  assert.equal(intake.jobs.length, 2);
});

test('compliance: forged signature is 401 and queues nothing; a shop mismatch or bad order ids are 400', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake, LIFECYCLE);
  const raw = redactBody();
  assert.equal((await handleWebhook({ rawBody: raw, headers: { ...lifecycleHeaders(raw, 'customers/redact', 'w'), 'x-shopify-hmac-sha256': 'AAAA' } }, deps)).status, 401);
  const mismatch = redactBody({ shop_domain: 'someone-else.myshopify.com' });
  assert.equal((await handleWebhook({ rawBody: mismatch, headers: lifecycleHeaders(mismatch, 'customers/redact', 'w2') }, deps)).status, 400);
  const bad = redactBody({ orders_to_redact: ['x'] });
  assert.equal((await handleWebhook({ rawBody: bad, headers: lifecycleHeaders(bad, 'customers/redact', 'w3') }, deps)).status, 400);
  assert.equal(intake.jobs.length, 0);
});

test('shop/redact and app/uninstalled are routed the same way', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake, LIFECYCLE);
  for (const topic of ['shop/redact', 'app/uninstalled']) {
    const raw = Buffer.from(JSON.stringify({ shop_id: 1, shop_domain: 'example-store.myshopify.com' }));
    assert.equal((await handleWebhook({ rawBody: raw, headers: lifecycleHeaders(raw, topic, `wh-${topic}`) }, deps)).outcome, 'accepted', topic);
  }
  assert.deepEqual(intake.jobs.map((j) => j.topic), ['shop/redact', 'app/uninstalled']);
});

test('lifecycle topics nobody subscribed to are still acknowledged, not queued', async () => {
  const intake = new MemoryIntake();
  const { deps } = setup(intake, ['orders/paid']);
  const raw = redactBody();
  assert.deepEqual(await handleWebhook({ rawBody: raw, headers: lifecycleHeaders(raw, 'customers/redact', 'w') }, deps), { status: 200, outcome: 'ignored_topic' });
  assert.equal(intake.jobs.length, 0);
});

test('a refused privacy request logs WHY with a fixed reason name and no payload content', async () => {
  const { deps, log } = setup();
  const body = Buffer.from(JSON.stringify({ shop_id: 1, shop_domain: 'someone-else.myshopify.com', customer: { id: 1, email: 'x@y.z' }, orders_to_redact: [1] }));
  const sig = createHmac('sha256', SECRET).update(body).digest('base64');
  const r = await handleWebhook({ rawBody: body, headers: headers({ 'x-shopify-hmac-sha256': sig, 'x-shopify-topic': 'customers/redact' }) }, { ...deps, topics: new Set(['orders/paid', 'customers/redact']) });
  assert.equal(r.status, 400);
  assert.equal(log[0].reason, 'shop_mismatch');
  assert.ok(!JSON.stringify(log).includes('x@y.z') && !JSON.stringify(log).includes('someone-else'));
});
