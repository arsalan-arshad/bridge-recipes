import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { AdminError, assertShop, connectShop, loadStoreEnv, setRecipe, shopStatus, validateLoginUrl, verifyShop } from './admin.ts';
import { MemoryConnectionStore } from '../salesforce/connectionStore.ts';
import { startQueue } from '../queue/postgresIntake.ts';
import { PostgresConnectionStore } from '../queue/postgresConnectionStore.ts';
import { PostgresConfigStore } from '../queue/postgresConfigStore.ts';
import { PostgresSyncLog } from '../queue/postgresSyncLog.ts';
import { R1_DEFAULT_CONFIG, R1_ID } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';
import { validateR1Config } from '../../recipes/retail-b2b-lead-spotter/validateConfig.ts';

const URL = process.env.DATABASE_URL ?? '';
const skip = URL === '' ? 'DATABASE_URL not set' : false;
const SECRET = 'S3CR3T-VALUE-for-admin-tests';

test('shop names must be myshopify.com hosts', () => {
  assert.equal(assertShop('my-store.myshopify.com'), 'my-store.myshopify.com');
  for (const bad of ['', 'store', 'a.com', 'x.myshopify.com.evil.io', 'A.myshopify.com', 'a b.myshopify.com', "a';--.myshopify.com", '.myshopify.com']) assert.throws(() => assertShop(bad), AdminError, bad);
});

test('login url: https only (plain http only for localhost), no credentials, normalised to scheme://host', () => {
  assert.equal(validateLoginUrl('org.develop.my.salesforce.com'), 'https://org.develop.my.salesforce.com');
  assert.equal(validateLoginUrl('https://org.my.salesforce.com/some/path?x=1'), 'https://org.my.salesforce.com');
  assert.equal(validateLoginUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const bad of ['http://org.my.salesforce.com', 'https://user:pw@org.my.salesforce.com', 'ftp://x', 'ftp://org.my.salesforce.com', 'javascript://x', 'file:///etc/passwd', '', 'http://']) assert.throws(() => validateLoginUrl(bad), AdminError, bad);
});

test('connectShop validates and stores; errors never include the secret', async () => {
  const store = new MemoryConnectionStore();
  await connectShop(store, 's.myshopify.com', { loginUrl: 'org.my.salesforce.com', clientId: 'cid', clientSecret: SECRET });
  assert.deepEqual(await store.get('s.myshopify.com'), { loginUrl: 'https://org.my.salesforce.com', clientId: 'cid', clientSecret: SECRET });
  for (const bad of [{ loginUrl: 'http://evil.com', clientId: 'c', clientSecret: SECRET }, { loginUrl: 'org.my.salesforce.com', clientId: '', clientSecret: SECRET }, { loginUrl: 'org.my.salesforce.com', clientId: 'c', clientSecret: '' }, { loginUrl: 'org.my.salesforce.com', clientId: 'c', clientSecret: 'x'.repeat(513) }]) {
    await assert.rejects(() => connectShop(store, 's.myshopify.com', bad), (e: any) => e instanceof AdminError && !e.message.includes(SECRET));
  }
  await assert.rejects(() => connectShop(store, 'nope', { loginUrl: 'org.my.salesforce.com', clientId: 'c', clientSecret: SECRET }), AdminError);
});

test('verifyShop: no connection, a working one (marks verified), and failures reported by class only', async () => {
  const store = new MemoryConnectionStore();
  assert.deepEqual(await verifyShop(store, 's.myshopify.com'), { ok: false, reason: 'no_connection' });
  await connectShop(store, 's.myshopify.com', { loginUrl: 'http://127.0.0.1:9', clientId: 'c', clientSecret: SECRET });
  const okFetch = async (url: string) => new Response(url.includes('oauth2/token') ? JSON.stringify({ access_token: 't', instance_url: 'http://127.0.0.1:9' }) : url.endsWith('/services/data/') ? JSON.stringify([{ version: '68.0' }]) : JSON.stringify({ records: [] }), { status: 200 });
  const marked: [string, string][] = [];
  const spy = { get: store.get.bind(store), put: store.put.bind(store), markVerified: async (shop: string, at: Date) => void marked.push([shop, at.toISOString()]) };
  const at = new Date('2026-10-21T12:00:00.000Z');
  assert.deepEqual(await verifyShop(spy, 's.myshopify.com', { fetch: okFetch as any, now: () => at }), { ok: true });
  assert.deepEqual(marked, [['s.myshopify.com', '2026-10-21T12:00:00.000Z']], 'a successful check records the time');
  const failing = await verifyShop(spy, 's.myshopify.com', { fetch: (async () => new Response('{}', { status: 500 })) as any, now: () => at });
  assert.equal(failing.ok, false);
  assert.equal(marked.length, 1, 'a failed check does NOT record a verification');
  assert.deepEqual(await verifyShop(store, 's.myshopify.com', { fetch: okFetch as any }), { ok: true });
  const bad = await verifyShop(store, 's.myshopify.com', { fetch: (async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: SECRET }), { status: 400 })) as any });
  assert.deepEqual(bad, { ok: false, reason: 'auth:invalid_client' });
  assert.ok(!JSON.stringify(bad).includes(SECRET));
  const down = await verifyShop(store, 's.myshopify.com', { fetch: (async () => { throw new Error(SECRET); }) as any });
  assert.deepEqual(down, { ok: false, reason: 'transient:NETWORK_ERROR' });
});

test('store env: needs DATABASE_URL and a 64-hex ENCRYPTION_KEY, but NOT the webhook secret; messages name variables only', () => {
  const key = 'ab'.repeat(32);
  assert.equal(loadStoreEnv({ DATABASE_URL: 'postgres://u@h/db', ENCRYPTION_KEY: key }).schema, 'bridge');
  try {
    loadStoreEnv({ DATABASE_URL: SECRET, ENCRYPTION_KEY: SECRET, BRIDGE_SCHEMA: 'Bad!' });
    assert.fail('should throw');
  } catch (e: any) {
    assert.ok(e instanceof AdminError && !e.message.includes(SECRET));
    for (const n of ['DATABASE_URL', 'ENCRYPTION_KEY', 'BRIDGE_SCHEMA']) assert.ok(e.message.includes(n));
  }
});

test('recipes enable in DRY-RUN unless live is explicitly true; disable is the kill switch; status shows mode without secrets', { skip, timeout: 60_000 }, async () => {
  const schema = `bridge_t_${randomBytes(4).toString('hex')}`;
  const rt = await startQueue({ connectionString: URL, schema });
  try {
    const key = randomBytes(32);
    const connections = new PostgresConnectionStore(rt.pool, schema, key);
    const configs = new PostgresConfigStore(rt.pool, schema, { [R1_ID]: validateR1Config });
    const syncLog = new PostgresSyncLog(rt.pool, schema);
    const deps = { connections, configs, syncLog, pool: rt.pool, schema };
    const shop = 's.myshopify.com';

    let st = await shopStatus(deps, shop, R1_ID);
    assert.deepEqual([st.connection, st.recipe.mode], [false, 'not configured (disabled)']);

    await connectShop(connections, shop, { loginUrl: 'org.my.salesforce.com', clientId: 'cid', clientSecret: SECRET });
    await setRecipe(configs, shop, R1_ID, { enable: true, config: R1_DEFAULT_CONFIG });
    st = await shopStatus(deps, shop, R1_ID);
    assert.deepEqual([st.connection, st.recipe.enabled, st.recipe.mode], [true, true, 'dry-run']);
    await setRecipe(configs, shop, R1_ID, { enable: true, live: false, config: R1_DEFAULT_CONFIG });
    assert.equal((await shopStatus(deps, shop, R1_ID)).recipe.mode, 'dry-run');
    await setRecipe(configs, shop, R1_ID, { enable: true, live: true, config: R1_DEFAULT_CONFIG });
    assert.equal((await shopStatus(deps, shop, R1_ID)).recipe.mode, 'LIVE');
    await setRecipe(configs, shop, R1_ID, { enable: false, config: null });
    assert.equal((await shopStatus(deps, shop, R1_ID)).recipe.enabled, false);
    await assert.rejects(() => setRecipe(configs, shop, R1_ID, { enable: true, config: { ...R1_DEFAULT_CONFIG, minOrderTotal: -1 } }), /minOrderTotal/);

    await syncLog.record({ at: '2026-10-21T10:00:00.000Z', shop, recipeId: R1_ID, topic: 'orders/paid', objectId: 'o', webhookId: 'w', outcome: 'created', dryRun: false });
    st = await shopStatus(deps, shop, R1_ID);
    assert.deepEqual(st.outcomes, { created: 1 });
    assert.ok(!JSON.stringify(st).includes(SECRET));

    const wrong = new PostgresConnectionStore(rt.pool, schema, randomBytes(32));
    assert.equal((await shopStatus({ ...deps, connections: wrong }, shop, R1_ID)).connection, 'unreadable (wrong ENCRYPTION_KEY?)');
  } finally {
    await rt.stop().catch(() => {});
    const p = new pg.Pool({ connectionString: URL, max: 1 });
    await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await p.end();
  }
});

test('validateLoginUrl: only Salesforce hosts (or loopback for local tests); look-alikes, internal hosts and odd ports refused', async () => {
  const { validateLoginUrl } = await import('./admin.ts');
  for (const ok of ['https://acme.my.salesforce.com', 'acme.my.salesforce.com', 'https://acme--dev.sandbox.my.salesforce.com', 'https://login.salesforce.com', 'https://test.salesforce.com', 'http://localhost:9999']) {
    assert.doesNotThrow(() => validateLoginUrl(ok), ok);
  }
  for (const bad of ['https://evil.com', 'https://acme.my.salesforce.com.evil.com', 'https://evilsalesforce.com', 'https://169.254.169.254', 'https://internal.local', 'https://acme.my.salesforce.com:8443', 'http://acme.my.salesforce.com', 'https://u:p@acme.my.salesforce.com', 'ftp://acme.my.salesforce.com']) {
    assert.throws(() => validateLoginUrl(bad), /SF_LOGIN_URL/, bad);
  }
});
