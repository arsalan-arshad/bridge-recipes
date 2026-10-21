import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from './buildContext.ts';
import type { OrderPaidEvent } from './types.ts';

const ev = (email: string | null): OrderPaidEvent => ({
  orderId: 'gid://shopify/Order/1', orderName: '#1', currency: 'USD', total: 10, productTitles: ['W'],
  customer: { id: null, email, lastName: 'B', marketingConsent: true }, billingCompany: null,
});

function fake(rows: { accounts?: any[]; leads?: any[]; contacts?: any[] }) {
  const queries: string[] = [];
  return { queries, sf: { async query(q: string) { queries.push(q); return q.includes('FROM Account') ? rows.accounts ?? [] : q.includes('FROM Lead') ? rows.leads ?? [] : rows.contacts ?? []; } } };
}

test('no match anywhere -> empty context', async () => {
  const { sf, queries } = fake({});
  assert.deepEqual(await buildContext(ev('buyer@acme.com'), sf), { accountByDomain: null, existingByEmail: null });
  assert.equal(queries.length, 3);
});

test('Lead wins over Contact when both match (owner ruling 2026-10-19), and the Contact is not even queried', async () => {
  const { sf, queries } = fake({ leads: [{ Id: '00Qaaaaaaaaaaaa1' }], contacts: [{ Id: '003Caaaaaaaaaaa1', AccountId: null, OwnerId: '005O' }] });
  const ctx = await buildContext(ev('buyer@acme.com'), sf);
  assert.deepEqual(ctx.existingByEmail, { type: 'Lead', id: '00Qaaaaaaaaaaaa1' });
  assert.ok(!queries.some((q) => q.includes('FROM Contact')));
});

test('Contact is used when there is no Lead; a Contact without an account has accountId null', async () => {
  const a = fake({ contacts: [{ Id: '003Caaaaaaaaaaa1', AccountId: '001Aaaaaaaaaaaa1', OwnerId: '005O' }] });
  assert.deepEqual((await buildContext(ev('buyer@acme.com'), a.sf)).existingByEmail, { type: 'Contact', id: '003Caaaaaaaaaaa1', accountId: '001Aaaaaaaaaaaa1', ownerId: '005O' });
  const b = fake({ contacts: [{ Id: '003Cbbbbbbbbbbb1', OwnerId: '005O' }] });
  assert.deepEqual((await buildContext(ev('buyer@acme.com'), b.sf)).existingByEmail, { type: 'Contact', id: '003Cbbbbbbbbbbb1', accountId: null, ownerId: '005O' });
});

test('Account is matched by the Website HOST: LIKE false positives are ignored, the oldest real match wins', async () => {
  const { sf } = fake({ accounts: [
    { Id: '001Xaaaaaaaaaaa1', OwnerId: '005X', Website: 'https://notacme.com' },
    { Id: '001Yaaaaaaaaaaa1', OwnerId: '005Y', Website: 'https://shop.acme.com' },
    { Id: '001Zaaaaaaaaaaa1', OwnerId: '005Z', Website: 'http://www.acme.com/about' },
    { Id: '001Waaaaaaaaaaa1', OwnerId: '005W', Website: 'acme.com' },
  ] });
  assert.deepEqual((await buildContext(ev('buyer@acme.com'), sf)).accountByDomain, { id: '001Zaaaaaaaaaaa1', ownerId: '005Z' });
});

test('queries are built from the normalised email and only look for non-converted Leads', async () => {
  const { sf, queries } = fake({});
  await buildContext(ev('  Buyer@ACME.com '), sf);
  assert.ok(queries.some((q) => q.includes("FROM Lead WHERE Email = 'buyer@acme.com' AND IsConverted = false")));
  assert.ok(queries.some((q) => q.includes("FROM Contact WHERE Email = 'buyer@acme.com'")));
  assert.ok(queries.some((q) => q.includes("Website LIKE '%acme.com%'")));
});

test('no email or malformed email -> no Salesforce query at all', async () => {
  for (const email of [null, '', '   ', 'a@@b.com', '@x.com', 'a@', 'nope']) {
    const { sf, queries } = fake({});
    assert.deepEqual(await buildContext(ev(email), sf), { accountByDomain: null, existingByEmail: null });
    assert.equal(queries.length, 0, String(email));
  }
});

test('an address the query builders refuse (quote, space) is treated as no match, with no query and no injection', async () => {
  for (const email of ["a'b@acme.com", 'a b@acme.com', 'a"b@acme.com', 'a\\b@acme.com']) {
    const { sf, queries } = fake({});
    assert.deepEqual(await buildContext(ev(email), sf), { accountByDomain: null, existingByEmail: null });
    assert.equal(queries.length, 0, email);
  }
});

test('a failing lookup propagates (so the job retries) instead of being swallowed', async () => {
  const sf = { async query() { throw new Error('boom'); } };
  await assert.rejects(() => buildContext(ev('buyer@acme.com'), sf), /boom/);
});

test('EACH lookup failing on its own propagates (a swallowed Account/Lead/Contact error would cause the wrong write)', async () => {
  for (const failing of ['FROM Account', 'FROM Lead', 'FROM Contact']) {
    const sf = { async query(q: string) { if (q.includes(failing)) throw new Error(`down: ${failing}`); return []; } };
    await assert.rejects(() => buildContext(ev('buyer@acme.com'), sf), new RegExp(failing), failing);
  }
});
