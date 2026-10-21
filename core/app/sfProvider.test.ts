import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSalesforceProvider } from './sfProvider.ts';
import { MemoryConnectionStore } from '../salesforce/connectionStore.ts';
import { SalesforceError } from '../salesforce/client.ts';

const CONN = { loginUrl: 'https://org.example', clientId: 'cid', clientSecret: 'S3CR3T-VALUE' };

test('no stored connection: a retryable NO_CONNECTION error that names no secret', async () => {
  const provide = createSalesforceProvider({ connections: new MemoryConnectionStore() });
  await assert.rejects(() => provide('s.myshopify.com'), (e: any) => e instanceof SalesforceError && e.kind === 'auth' && e.retryable && e.errorCode === 'NO_CONNECTION');
});

test('a client is built per shop from its own connection and cached within the TTL', async () => {
  const connections = new MemoryConnectionStore();
  let gets = 0;
  const counting = { ...connections, get: async (s: string) => { gets++; return connections.get(s); }, put: connections.put.bind(connections), markVerified: connections.markVerified.bind(connections) };
  await connections.put('a.myshopify.com', CONN);
  await connections.put('b.myshopify.com', { ...CONN, clientId: 'other' });
  let t = 0;
  const provide = createSalesforceProvider({ connections: counting, now: () => t, ttlMs: 1000 });
  const a1 = await provide('a.myshopify.com');
  const a2 = await provide('a.myshopify.com');
  const b = await provide('b.myshopify.com');
  assert.equal(a1, a2, 'cached');
  assert.notEqual(a1, b, 'a client per shop');
  assert.equal(gets, 2);
  t = 1001;
  assert.notEqual(await provide('a.myshopify.com'), a1, 'rebuilt after the TTL so a changed connection takes effect');
  assert.equal(gets, 3);
});

test('a connection added after a failed lookup is picked up (failures are not cached)', async () => {
  const connections = new MemoryConnectionStore();
  const provide = createSalesforceProvider({ connections });
  await assert.rejects(() => provide('s.myshopify.com'));
  await connections.put('s.myshopify.com', CONN);
  assert.ok(await provide('s.myshopify.com'));
});

test('the secret never appears in the error or the client string form', async () => {
  const connections = new MemoryConnectionStore();
  await connections.put('s.myshopify.com', CONN);
  const failing = createSalesforceProvider({ connections, fetch: async () => { throw new Error(`down https://org?secret=${CONN.clientSecret}`); } });
  const client = await failing('s.myshopify.com');
  await assert.rejects(() => client.query('SELECT Id FROM Lead'), (e: any) => !e.message.includes(CONN.clientSecret) && !JSON.stringify(e).includes(CONN.clientSecret));
});
