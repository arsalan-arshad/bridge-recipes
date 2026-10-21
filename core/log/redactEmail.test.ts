import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactEmail } from './redactEmail.ts';

test('keeps first letter and domain only', () => {
  assert.equal(redactEmail('alice@acme.com'), 'a***@acme.com');
  assert.equal(redactEmail(' Bob@ACME.com '), 'B***@acme.com');
});

test('never leaks the local part', () => {
  assert.ok(!redactEmail('longlocalpart@acme.com').includes('longlocalpart'));
  assert.ok(!redactEmail('longlocalpart@acme.com').includes('ong'));
});

test('malformed or missing input is fully masked', () => {
  for (const bad of [null, undefined, '', 'nope', 'a@@b.com', '@x.com', 'a@']) {
    assert.equal(redactEmail(bad), '***');
  }
});
