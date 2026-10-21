import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './decide.ts';
import type { Config, Context, Decision, OrderPaidEvent } from './types.ts';

const fixturesDir = join(import.meta.dirname, 'fixtures');

interface Fixture {
  id: string;
  case: string;
  event: OrderPaidEvent;
  ctx: Context;
  config: Config;
  expected: Decision;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();

test('fixture directory is not empty', () => {
  assert.ok(files.length > 0);
});

for (const file of files) {
  const fx: Fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
  test(`${fx.id}: ${fx.case}`, () => {
    // Frozen inputs: any mutation by decide() throws in strict mode (ES modules).
    const result = decide(deepFreeze(fx.event), deepFreeze(fx.ctx), deepFreeze(fx.config));
    assert.deepEqual(result, fx.expected);
  });
}

// F20: same input twice -> identical output, no mutation, no throw.
test('F20: deterministic and non-mutating', () => {
  const fx: Fixture = JSON.parse(readFileSync(join(fixturesDir, 'F16b.json'), 'utf8'));
  const before = JSON.stringify([fx.event, fx.ctx, fx.config]);
  const event = deepFreeze(fx.event);
  const ctx = deepFreeze(fx.ctx);
  const config = deepFreeze(fx.config);
  const a = decide(event, ctx, config);
  const b = decide(event, ctx, config);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify([event, ctx, config]), before);
});

// F21: Description carries order name, titles and total; nothing else about the customer.
test('F21: Description content and privacy', () => {
  const fx: Fixture = JSON.parse(readFileSync(join(fixturesDir, 'F16.json'), 'utf8'));
  const result = decide(fx.event, fx.ctx, fx.config);
  assert.ok('ops' in result);
  const op = result.ops[0];
  assert.equal(op.kind, 'createLead');
  if (op.kind !== 'createLead') return;
  const d = op.fields.Description;
  assert.ok(d.includes('#1001'));
  assert.ok(d.includes('Widget A') && d.includes('Widget B'));
  assert.ok(d.includes('250 USD'));
  // Not in the description: customer name, email, ids, billing company.
  assert.ok(!d.includes('Smith'));
  assert.ok(!d.includes('buyer@acme.com'));
  assert.ok(!d.includes('gid://shopify/Customer'));
});
