import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeOp, runOp } from './executeOp.ts';
import { MemoryEntityStore } from './entityStore.ts';
import { SalesforceError } from '../salesforce/client.ts';
import type { CoreOp, SfWriter } from './ops.ts';

interface Rec { type: string; fields: Record<string, unknown> }
function fakeSf(script: { create?: (type: string, fields: any, n: number) => { id: string } | Error; description?: string } = {}) {
  const creates: Rec[] = [];
  const updates: { type: string; id: string; fields: any }[] = [];
  const gets: string[] = [];
  const sf: SfWriter = {
    async create(type, fields) {
      creates.push({ type, fields });
      const r = script.create ? script.create(type, fields, creates.length) : { id: `ID${creates.length}`.padEnd(15, '0') };
      if (r instanceof Error) throw r;
      return r;
    },
    async update(type, id, fields) { updates.push({ type, id, fields }); },
    async getRecord(type, id) { gets.push(`${type}:${id}`); return { Description: script.description ?? '' }; },
  };
  return { sf, creates, updates, gets };
}

const lead = (over: Record<string, unknown> = {}): CoreOp => ({
  kind: 'createLead', matchKey: 'r1:1',
  fields: { Company: 'Acme', LastName: 'Buyer', Email: 'a@acme.com', LeadSource: 'Shopify Order', Description: 'Order #1: Widget. Total: 10 USD', ...over },
});
const err = (kind: any, code: string, ids: string[] = []) => new SalesforceError(kind, 400, code, 'x', ids);

test('createLead creates a Lead with exactly the given fields', async () => {
  const { sf, creates } = fakeSf();
  const out = await executeOp(lead(), sf);
  assert.equal(out.kind, 'created');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].type, 'Lead');
  assert.deepEqual(creates[0].fields, (lead() as any).fields);
});

test('duplicate rule hit: terminal duplicate_detected with the matched ids, no retry, never forced', async () => {
  const { sf, creates } = fakeSf({ create: () => err('duplicate', 'DUPLICATES_DETECTED', ['00Qaaaaaaaaaaaa1']) });
  const out = await executeOp(lead(), sf);
  assert.deepEqual(out, { kind: 'duplicate_detected', matchedIds: ['00Qaaaaaaaaaaaa1'] });
  assert.equal(creates.length, 1, 'not retried');
});

test('restricted LeadSource: retried once without LeadSource and the wanted value is noted in the Description', async () => {
  const { sf, creates } = fakeSf({ create: (t, f, n) => (n === 1 ? err('restricted_picklist', 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST') : { id: '00Qbbbbbbbbbbbb1' }) });
  const out = await executeOp(lead(), sf);
  assert.deepEqual(out, { kind: 'created', type: 'Lead', id: '00Qbbbbbbbbbbbb1' });
  assert.equal(creates.length, 2);
  assert.ok(!('LeadSource' in creates[1].fields));
  assert.equal(creates[1].fields.Description, 'Order #1: Widget. Total: 10 USD (LeadSource wanted: Shopify Order)');
  assert.equal(creates[1].fields.Company, 'Acme');
});

test('restricted retry that then hits a duplicate rule is still duplicate_detected; a second failure propagates', async () => {
  const a = fakeSf({ create: (t, f, n) => (n === 1 ? err('restricted_picklist', 'X') : err('duplicate', 'DUPLICATES_DETECTED', ['00Qccccccccccc01'])) });
  assert.deepEqual(await executeOp(lead(), a.sf), { kind: 'duplicate_detected', matchedIds: ['00Qccccccccccc01'] });
  const b = fakeSf({ create: (t, f, n) => (n === 1 ? err('restricted_picklist', 'X') : err('permanent', 'REQUIRED_FIELD_MISSING')) });
  await assert.rejects(() => executeOp(lead(), b.sf), (e: any) => e.kind === 'permanent');
  assert.equal(b.creates.length, 2, 'only one retry');
});

test('other Salesforce errors and non-Salesforce errors propagate unchanged', async () => {
  for (const e of [err('transient', 'UNKNOWN_EXCEPTION'), err('permanent', 'REQUIRED_FIELD_MISSING'), err('rate_limit', 'REQUEST_LIMIT_EXCEEDED'), new TypeError('bug')]) {
    const { sf } = fakeSf({ create: () => e });
    await assert.rejects(() => executeOp(lead(), sf), (x: any) => x === e);
  }
});

test('updateLead appends to the existing Description, sets it when empty, and is a no-op when the note is already there', async () => {
  const op: CoreOp = { kind: 'updateLead', matchKey: 'r1:1', targetId: '00Qaaaaaaaaaaaa1', fields: { Description: 'Order #2: Gadget. Total: 5 USD' } };
  const a = fakeSf({ description: 'Earlier note' });
  assert.deepEqual(await executeOp(op, a.sf), { kind: 'updated', type: 'Lead', id: '00Qaaaaaaaaaaaa1', changed: true });
  assert.deepEqual(a.updates, [{ type: 'Lead', id: '00Qaaaaaaaaaaaa1', fields: { Description: 'Earlier note\nOrder #2: Gadget. Total: 5 USD' } }]);
  const b = fakeSf({ description: '' });
  await executeOp(op, b.sf);
  assert.equal(b.updates[0].fields.Description, 'Order #2: Gadget. Total: 5 USD');
  const c = fakeSf({ description: 'x\nOrder #2: Gadget. Total: 5 USD' });
  assert.deepEqual(await executeOp(op, c.sf), { kind: 'updated', type: 'Lead', id: '00Qaaaaaaaaaaaa1', changed: false });
  assert.equal(c.updates.length, 0);
});

test('createTask maps Account -> WhatId, Contact -> WhoId, owner -> OwnerId, and omits null links', async () => {
  const mk = (accountId: string | null, contactId: string | null): CoreOp => ({ kind: 'createTask', matchKey: 'r1:1', ownerId: '005O', accountId, contactId, fields: { Subject: 'S', Description: 'D' } });
  const a = fakeSf();
  await executeOp(mk('001A', null), a.sf);
  assert.deepEqual(a.creates[0], { type: 'Task', fields: { Subject: 'S', Description: 'D', OwnerId: '005O', WhatId: '001A' } });
  const b = fakeSf();
  await executeOp(mk('001A', '003C'), b.sf);
  assert.deepEqual(b.creates[0].fields, { Subject: 'S', Description: 'D', OwnerId: '005O', WhatId: '001A', WhoId: '003C' });
  const c = fakeSf();
  await executeOp(mk(null, '003C'), c.sf);
  assert.ok(!('WhatId' in c.creates[0].fields) && c.creates[0].fields.WhoId === '003C');
});

test('runOp is idempotent: a retried job does not write twice', async () => {
  const entities = new MemoryEntityStore();
  const { sf, creates } = fakeSf();
  const first = await runOp(lead(), { sf, entities, shop: 's.myshopify.com' });
  const second = await runOp(lead(), { sf, entities, shop: 's.myshopify.com' });
  assert.equal(first.kind, 'created');
  assert.deepEqual(second, { kind: 'already_done', type: 'Lead', id: (first as any).id });
  assert.equal(creates.length, 1);
});

test('runOp remembers updates but NOT duplicate_detected or failures (a replay may succeed later)', async () => {
  const entities = new MemoryEntityStore();
  const dup = fakeSf({ create: () => err('duplicate', 'DUPLICATES_DETECTED', ['00Qaaaaaaaaaaaa1']) });
  await runOp(lead(), { sf: dup.sf, entities, shop: 's.myshopify.com' });
  assert.equal(entities.map.size, 0);
  const bad = fakeSf({ create: () => err('transient', 'UNKNOWN_EXCEPTION') });
  await assert.rejects(() => runOp(lead(), { sf: bad.sf, entities, shop: 's.myshopify.com' }));
  assert.equal(entities.map.size, 0);
  const ok = fakeSf();
  const out = await runOp(lead(), { sf: ok.sf, entities, shop: 's.myshopify.com' });
  assert.equal(out.kind, 'created', 'the replay after the duplicate is gone / the outage is over writes');
  assert.equal(entities.map.size, 1);
  const upd: CoreOp = { kind: 'updateLead', matchKey: 'r1:2', targetId: '00Qaaaaaaaaaaaa1', fields: { Description: 'N' } };
  await runOp(upd, { sf: ok.sf, entities, shop: 's.myshopify.com' });
  assert.deepEqual(entities.map.get('r1:2'), { type: 'Lead', id: '00Qaaaaaaaaaaaa1' });
});
