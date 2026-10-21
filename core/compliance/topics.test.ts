import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_TOPICS, LIFECYCLE_TOPICS, isLifecycleTopic, minimizeLifecyclePayload } from './topics.ts';

const SHOP = 's.myshopify.com';
const redact = { shop_id: 954889, shop_domain: SHOP, customer: { id: 191167, email: 'john@example.com', phone: '555-625-1199' }, orders_to_redact: [299938, 280263, 220458] };
const request = { shop_id: 954889, shop_domain: SHOP, orders_requested: [299938, '280263'], customer: { id: 191167, email: 'john@example.com', phone: '555-625-1199' }, data_request: { id: 9999 } };

test('the topic lists match the documented mandatory topics plus app/uninstalled', () => {
  assert.deepEqual([...COMPLIANCE_TOPICS], ['customers/data_request', 'customers/redact', 'shop/redact']);
  assert.ok(isLifecycleTopic('app/uninstalled') && isLifecycleTopic('shop/redact'));
  assert.equal(isLifecycleTopic('orders/paid'), false);
  assert.equal(LIFECYCLE_TOPICS.length, 4);
});

test('customers/redact keeps ONLY the order ids: no email, phone or customer id survives', () => {
  const r = minimizeLifecyclePayload('customers/redact', redact, SHOP);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { topic: 'customers/redact', shopDomain: SHOP, orders: ['299938', '280263', '220458'], requestId: null });
  const text = JSON.stringify(r.value);
  for (const leak of ['john@example.com', '555-625-1199', '191167', 'email', 'phone']) assert.ok(!text.includes(leak), leak);
});

test('customers/data_request keeps the order ids and the request id; numeric strings are accepted', () => {
  const r = minimizeLifecyclePayload('customers/data_request', request, SHOP);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { topic: 'customers/data_request', shopDomain: SHOP, orders: ['299938', '280263'], requestId: '9999' });
});

test('shop/redact and app/uninstalled need no more than the shop', () => {
  for (const t of ['shop/redact', 'app/uninstalled']) {
    const r = minimizeLifecyclePayload(t, { shop_id: 1, shop_domain: SHOP, extra: 'ignored', customer: { email: 'x@y.z' } }, SHOP);
    assert.ok(r.ok);
    assert.deepEqual(r.value, { topic: t, shopDomain: SHOP, orders: [], requestId: null });
  }
});

test('the authenticated header decides the shop; a different shop_domain in the body is rejected, case is ignored, a missing body field is fine', () => {
  assert.deepEqual(minimizeLifecyclePayload('customers/redact', { ...redact, shop_domain: 'other.myshopify.com' }, SHOP), { ok: false, reason: 'shop_mismatch' });
  assert.ok(minimizeLifecyclePayload('customers/redact', { ...redact, shop_domain: 'S.MyShopify.com' }, SHOP).ok);
  assert.ok(minimizeLifecyclePayload('customers/redact', { orders_to_redact: [1] }, SHOP).ok);
  assert.deepEqual(minimizeLifecyclePayload('customers/redact', redact, '  '), { ok: false, reason: 'missing_shop' });
});

test('order ids are strictly validated, de-duplicated and bounded', () => {
  const bad = [[0], [-1], [1.5], ['abc'], ['1e3'], [NaN], [null], [{}], ['12345678901234567'], [Number.MAX_SAFE_INTEGER + 2], 'not-an-array', { 0: 1 }, new Array(10_001).fill(1)];
  for (const orders_to_redact of bad) assert.deepEqual(minimizeLifecyclePayload('customers/redact', { shop_domain: SHOP, orders_to_redact }, SHOP), { ok: false, reason: 'invalid_order_ids' }, JSON.stringify(orders_to_redact)?.slice(0, 40));
  const r = minimizeLifecyclePayload('customers/redact', { shop_domain: SHOP, orders_to_redact: [5, '5', 6] }, SHOP);
  assert.ok(r.ok);
  assert.deepEqual(r.value.orders, ['5', '6']);
  const empty = minimizeLifecyclePayload('customers/redact', { shop_domain: SHOP }, SHOP);
  assert.ok(empty.ok);
  assert.deepEqual(empty.value.orders, []);
});

test('non-object payloads and non-lifecycle topics are refused', () => {
  for (const p of [null, 'x', 5, [], undefined]) assert.deepEqual(minimizeLifecyclePayload('shop/redact', p, SHOP), { ok: false, reason: 'payload_not_object' });
  assert.deepEqual(minimizeLifecyclePayload('orders/paid', {}, SHOP), { ok: false, reason: 'not_a_lifecycle_topic' });
});
