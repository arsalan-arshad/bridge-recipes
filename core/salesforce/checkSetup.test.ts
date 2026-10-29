import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSetup, runSetupCheck } from './checkSetup.ts';
import type { Describes, ObjectDescribe } from './checkSetup.ts';
import { SalesforceError } from './client.ts';

const f = (name: string, createable: boolean, updateable: boolean) => ({ name, createable, updateable });
const good = (): Describes => ({
  Lead: { queryable: true, createable: true, updateable: true, deletable: false, fields: [f('Email', true, true), f('LeadSource', true, true), f('Description', true, true)] },
  Task: { createable: true, fields: [f('Description', true, true), f('WhatId', true, true), f('WhoId', true, true)] },
  Account: { queryable: true, createable: false, updateable: false, deletable: false, fields: [f('Website', false, false)] },
  Contact: { queryable: true, createable: false, updateable: false, deletable: false, fields: [f('Email', false, false), f('AccountId', false, false)] },
});
const byId = (d: Describes) => Object.fromEntries(evaluateSetup(d).map((c) => [c.id, c]));

test('a correctly set up integration user passes every check', () => {
  assert.deepEqual(evaluateSetup(good()).map((c) => c.status), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
});

test('a Lead that cannot be created, edited, or read in a field fails and names what is missing', () => {
  const d = good();
  d.Lead = { ...(d.Lead as ObjectDescribe), createable: false, fields: [f('Email', true, true), f('LeadSource', true, false)] };
  const c = byId(d).lead;
  assert.equal(c.status, 'fail');
  assert.ok(c.fix?.includes('create Lead') && c.fix.includes('field LeadSource') && c.fix.includes('field Description') && !c.fix.includes('field Email'));
});

test('Tasks hidden from the user point at the licence; missing Task fields are named', () => {
  const d = good();
  d.Task = null;
  assert.ok(byId(d).task.fix?.includes('Salesforce Integration'));
  const e = good();
  e.Task = { createable: true, fields: [f('Description', true, true), f('WhatId', false, false)] };
  const c = byId(e).task;
  assert.equal(c.status, 'fail');
  assert.ok(c.fix?.includes('field WhatId') && c.fix.includes('field WhoId') && !c.fix.includes('field Description'));
});

test('permissions broader than needed are a warning, not a failure', () => {
  const d = good();
  d.Lead = { ...(d.Lead as ObjectDescribe), deletable: true };
  d.Account = { ...(d.Account as ObjectDescribe), createable: true, updateable: true };
  d.Contact = { ...(d.Contact as ObjectDescribe), deletable: true };
  const r = byId(d);
  assert.equal(r.lead.status, 'pass');
  assert.equal(r.lead_delete.status, 'warn');
  assert.ok(r.account_write.fix?.includes('create and edit'));
  assert.equal(r.contact_write.status, 'warn');
  assert.equal(r.account.status, 'pass');
});

test('objects hidden from the user fail with a fix', () => {
  const d = good();
  d.Lead = null; d.Account = null; d.Contact = null;
  assert.deepEqual(evaluateSetup(d).map((c) => `${c.id}:${c.status}`), ['lead:fail', 'task:pass', 'account:fail', 'contact:fail']);
});

test('a Contact or Account missing a needed field fails', () => {
  const d = good();
  d.Contact = { ...(d.Contact as ObjectDescribe), fields: [f('Email', false, false)] };
  d.Account = { ...(d.Account as ObjectDescribe), fields: [] };
  const r = byId(d);
  assert.ok(r.contact.fix?.includes('field AccountId'));
  assert.ok(r.account.fix?.includes('field Website'));
});

const asked: string[] = [];
const client = (respond: (name: string) => ObjectDescribe | SalesforceError) => ({
  request: async (method: string, path: string) => {
    asked.push(`${method} ${path}`);
    const r = respond(path.split('/')[5]);
    if (r instanceof SalesforceError) throw r;
    return { status: 200, json: r };
  },
});

test('the runner only ever reads: four GET describes, and a good org passes', async () => {
  asked.length = 0;
  const g = good();
  const r = await runSetupCheck(client((n) => g[n as keyof Describes] as ObjectDescribe));
  assert.equal(r.ok && r.checks.every((c) => c.status === 'pass'), true);
  assert.deepEqual(asked, ['Lead', 'Task', 'Account', 'Contact'].map((n) => `GET /services/data/{v}/sobjects/${n}/describe`));
});

test('a 404 or 403 for one object means it is hidden; a login failure stops with auth; anything else is unreachable', async () => {
  const g = good();
  const hidden = await runSetupCheck(client((n) => (n === 'Task' ? new SalesforceError('permanent', 404, 'NOT_FOUND', 'x') : (g[n as keyof Describes] as ObjectDescribe))));
  assert.ok(hidden.ok && hidden.checks.find((c) => c.id === 'task')?.status === 'fail');
  const forbidden = await runSetupCheck(client((n) => (n === 'Lead' ? new SalesforceError('permanent', 403, 'INSUFFICIENT_ACCESS', 'x') : (g[n as keyof Describes] as ObjectDescribe))));
  assert.ok(forbidden.ok && forbidden.checks.find((c) => c.id === 'lead')?.status === 'fail');
  assert.deepEqual(await runSetupCheck(client(() => new SalesforceError('auth', 400, 'invalid_client', 'authentication failed'))), { ok: false, reason: 'auth' });
  assert.deepEqual(await runSetupCheck(client(() => new SalesforceError('transient', 0, 'NETWORK_ERROR', 'x'))), { ok: false, reason: 'unreachable' });
});
