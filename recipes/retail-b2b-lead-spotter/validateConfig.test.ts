import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigValidationError, validateR1Config } from './validateConfig.ts';
import { R1_DEFAULT_CONFIG } from './recipe.ts';

const ok = () => JSON.parse(JSON.stringify(R1_DEFAULT_CONFIG));
const bad = (patch: Record<string, unknown>, remove: string[] = []) => {
  const c = { ...ok(), ...patch };
  for (const k of remove) delete (c as any)[k];
  return c;
};

test('the shipped defaults are valid and returned unchanged', () => {
  assert.deepEqual(validateR1Config(ok()), R1_DEFAULT_CONFIG);
});

test('a fully specified valid config passes, including an owner id and override', () => {
  const c = bad({ allowDomains: ['acme.com'], denyDomains: ['evil.io'], minOrderTotal: 50.5, requireConsent: false, existingLeadAction: 'skip', leadSource: 'Web', companyOverride: 'Acme', leadOwnerId: '005AAAAAAAAAAAA' });
  assert.deepEqual(validateR1Config(c), c);
});

test('unknown keys and non-objects are rejected', () => {
  for (const v of [null, undefined, 'x', 5, [], bad({ extra: 1 })]) assert.throws(() => validateR1Config(v), ConfigValidationError);
});

test('missing keys are rejected (no silent defaults)', () => {
  for (const k of Object.keys(R1_DEFAULT_CONFIG)) assert.throws(() => validateR1Config(bad({}, [k])), ConfigValidationError, k);
});

test('wrong types and values are rejected, never coerced', () => {
  const cases: Record<string, unknown>[] = [
    { minOrderTotal: '10' }, { minOrderTotal: -1 }, { minOrderTotal: NaN }, { minOrderTotal: Infinity }, { minOrderTotal: 1e13 },
    { requireConsent: 'true' }, { requireConsent: 1 }, { requireConsent: null },
    { existingLeadAction: 'delete' }, { existingLeadAction: 'UPDATE' },
    { leadSource: '' }, { leadSource: '   ' }, { leadSource: 5 }, { leadSource: 'x'.repeat(256) },
    { companyOverride: '' }, { companyOverride: 5 }, { companyOverride: 'x'.repeat(256) },
    { leadOwnerId: 'abc' }, { leadOwnerId: '001g700000CmFvVAAV' }, { leadOwnerId: '' }, { leadOwnerId: 5 },
    { allowDomains: 'acme.com' }, { allowDomains: [5] }, { allowDomains: ['ACME.com'] }, { allowDomains: ['a b.com'] },
    { denyDomains: ["a'.com"] }, { freeEmailBlocklist: [''] }, { allowDomains: new Array(5001).fill('a.com') },
  ];
  for (const patch of cases) assert.throws(() => validateR1Config(bad(patch)), ConfigValidationError, JSON.stringify(patch).slice(0, 80));
});

test('all problems are reported together', () => {
  try {
    validateR1Config(bad({ minOrderTotal: -1, requireConsent: 'x', leadSource: '' }));
    assert.fail('should throw');
  } catch (e: any) {
    assert.equal(e.problems.length, 3);
  }
});

test('the result is a copy: later changes to the input do not leak in', () => {
  const input = ok();
  const out = validateR1Config(input);
  input.allowDomains.push('x.com');
  assert.deepEqual(out.allowDomains, []);
});
