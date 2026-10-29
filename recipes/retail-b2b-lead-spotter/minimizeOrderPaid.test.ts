import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOrderPaid } from './mapOrderPaid.ts';
import { minimizeOrderPaid } from './minimizeOrderPaid.ts';

const DIR = join(import.meta.dirname, 'payloads');

test('minimising never changes what the recipe sees: every real or synthetic payload maps identically', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    assert.deepEqual(mapOrderPaid(minimizeOrderPaid(p)), mapOrderPaid(p), f);
  }
});

test('addresses, phone numbers, payment data and other customer fields are dropped', () => {
  const p = JSON.parse(readFileSync(join(DIR, 'SHOPIFY_real_orders_paid_2026-10_subscribed.json'), 'utf8'));
  const text = JSON.stringify(minimizeOrderPaid(p));
  for (const dropped of ['shipping_address', 'phone', 'address1', 'payment_gateway_names', 'client_details', 'browser_ip', 'first_name']) {
    assert.ok(!text.includes(dropped), `${dropped} must not survive`);
  }
  assert.ok(text.length < JSON.stringify(p).length / 2, 'much smaller than the original');
});

test('odd shapes are passed through for mapOrderPaid to judge, and nothing throws', () => {
  for (const v of [null, 'x', 5, [], { customer: null, line_items: 'x', billing_address: 7 }, { line_items: [1, null, { title: 'T', sku: 'S' }] }]) {
    assert.deepEqual(mapOrderPaid(minimizeOrderPaid(v)), mapOrderPaid(v));
  }
  assert.deepEqual(minimizeOrderPaid({ line_items: [{ title: 'T', sku: 'S' }] }), { line_items: [{ title: 'T' }] });
});
