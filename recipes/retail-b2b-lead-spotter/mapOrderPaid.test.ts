import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOrderPaid } from './mapOrderPaid.ts';

const load = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'payloads', name), 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Real signed deliveries (API 2026-10, admin-created paid draft orders), personal values replaced.
const notSubscribed = load('SHOPIFY_real_orders_paid_2026-10_not_subscribed.json'); // #1004
const subscribed = load('SHOPIFY_real_orders_paid_2026-10_subscribed.json'); // #1005
// Shopify's own example webhook (admin "Send test notification"): test:true, fake data.
const example = load('SHOPIFY_example_orders_paid_2026-10.json');
// Hand-written, minimal; proves logic only.
const synthetic = load('SYNTHETIC_orders_paid.json');

test('real #1005 (subscribed): maps to the minimal event with consent true', () => {
  assert.deepEqual(mapOrderPaid(subscribed), {
    ok: true,
    event: {
      orderId: 'gid://shopify/Order/18948632412213',
      orderName: '#1005',
      currency: 'USD',
      total: 785.95,
      productTitles: ['The Compare at Price Snowboard'],
      customer: { id: 'gid://shopify/Customer/31350864445493', email: 'test-buyer@example.com', lastName: 'Buyer', marketingConsent: true },
      billingCompany: 'Acme Test Co',
    },
  });
});

test('real #1004 (not subscribed): same shape, consent false', () => {
  const r = mapOrderPaid(notSubscribed);
  assert.ok(r.ok);
  assert.equal(r.event.orderId, 'gid://shopify/Order/18948630052917');
  assert.equal(r.event.orderName, '#1004');
  assert.equal(r.event.customer.marketingConsent, false);
  assert.equal(r.event.billingCompany, 'Acme Test Co');
});

test('the real payloads really have no customer.email_marketing_consent (why it is not read)', () => {
  assert.equal('email_marketing_consent' in subscribed.customer, false);
  assert.equal('email_marketing_consent' in notSubscribed.customer, false);
  assert.equal(subscribed.buyer_accepts_marketing, true);
  assert.equal(notSubscribed.buyer_accepts_marketing, false);
});

test('consent is only boolean true: missing, null, strings and numbers fail closed', () => {
  for (const v of [undefined, null, 'true', 'TRUE', 1, 0, 'false', {}, []]) {
    const p = clone(subscribed);
    if (v === undefined) delete p.buyer_accepts_marketing;
    else p.buyer_accepts_marketing = v;
    const r = mapOrderPaid(p);
    assert.ok(r.ok);
    assert.equal(r.event.customer.marketingConsent, false, String(JSON.stringify(v)));
  }
  const yes = clone(notSubscribed);
  yes.buyer_accepts_marketing = true;
  const r = mapOrderPaid(yes);
  assert.ok(r.ok);
  assert.equal(r.event.customer.marketingConsent, true);
});

test('customer.email_marketing_consent is ignored, even when present and contradicting', () => {
  const a = clone(notSubscribed);
  a.customer.email_marketing_consent = { state: 'subscribed' };
  const ra = mapOrderPaid(a);
  assert.ok(ra.ok);
  assert.equal(ra.event.customer.marketingConsent, false);
  const b = clone(subscribed);
  b.customer.email_marketing_consent = { state: 'unsubscribed' };
  const rb = mapOrderPaid(b);
  assert.ok(rb.ok);
  assert.equal(rb.event.customer.marketingConsent, true);
});

test('Shopify example payload: real field names map', () => {
  const r = mapOrderPaid(example);
  assert.ok(r.ok);
  assert.equal(r.event.orderId, 'gid://shopify/Order/820982911946154508');
  assert.equal(r.event.orderName, '#9999');
  assert.equal(r.event.total, 1694.88);
  assert.equal(r.event.productTitles.length, 5);
  assert.equal(r.event.customer.email, 'john@example.com'); // customer.email wins over contact_email
  assert.equal(r.event.customer.lastName, 'Smith');
  assert.equal(r.event.customer.marketingConsent, true); // buyer_accepts_marketing is true in the example
  assert.equal(r.event.billingCompany, 'Shipping Company');
});

test('synthetic payload still maps', () => {
  const r = mapOrderPaid(synthetic);
  assert.ok(r.ok);
  assert.equal(r.event.orderName, '#1001');
  assert.equal(r.event.total, 250);
});

test('data minimisation: no phone, address, first name or tokens reach the event', () => {
  for (const p of [subscribed, notSubscribed, example]) {
    const r = mapOrderPaid(p);
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.event).sort(), ['billingCompany', 'currency', 'customer', 'orderId', 'orderName', 'productTitles', 'total']);
    assert.deepEqual(Object.keys(r.event.customer).sort(), ['email', 'id', 'lastName', 'marketingConsent']);
  }
  const s = JSON.stringify(mapOrderPaid(example));
  for (const leak of ['123 Shipping Street', '555-555-SHIP', 'Steve', '123-123-1234', '123456abcd']) assert.ok(!s.includes(leak), leak);
});

test('guest checkout: no customer object -> contact_email, no last name; consent still from the order flag', () => {
  const p = clone(subscribed);
  delete p.customer;
  const r = mapOrderPaid(p);
  assert.ok(r.ok);
  assert.deepEqual(r.event.customer, { id: null, email: 'test-buyer@example.com', lastName: null, marketingConsent: true });
});

test('no email anywhere -> email null (decide() will skip no_email)', () => {
  const p = clone(subscribed);
  delete p.customer.email;
  delete p.contact_email;
  delete p.email;
  const r = mapOrderPaid(p);
  assert.ok(r.ok);
  assert.equal(r.event.customer.email, null);
});

test('invalid payloads are rejected, not guessed', () => {
  assert.deepEqual(mapOrderPaid(null), { ok: false, reason: 'payload_not_object' });
  assert.deepEqual(mapOrderPaid([]), { ok: false, reason: 'payload_not_object' });
  for (const [key, reason] of [
    ['admin_graphql_api_id', 'missing_order_id'],
    ['name', 'missing_order_name'],
    ['currency', 'missing_currency'],
    ['total_price', 'invalid_total'],
  ] as const) {
    const p = clone(subscribed);
    delete p[key];
    if (key === 'admin_graphql_api_id') delete p.id;
    assert.deepEqual(mapOrderPaid(p), { ok: false, reason }, key);
  }
  const neg = clone(subscribed);
  neg.total_price = '-5.00';
  assert.deepEqual(mapOrderPaid(neg), { ok: false, reason: 'invalid_total' });
});

test('order id falls back to numeric id', () => {
  const p = clone(synthetic);
  delete p.admin_graphql_api_id;
  const r = mapOrderPaid(p);
  assert.ok(r.ok);
  assert.equal(r.event.orderId, 'gid://shopify/Order/1001');
});
