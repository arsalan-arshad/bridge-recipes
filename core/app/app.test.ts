// The whole service, for real: createApp on real Postgres + an HTTP server, with a LOCAL FAKE SALESFORCE (a tiny http server,
// so the real SalesforceClient code and its wire format are exercised). Skipped without DATABASE_URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createApp } from './app.ts';
import { makeLogger } from './logger.ts';
import { DEFAULT_RETENTION } from '../queue/retention.ts';
import { PostgresConnectionStore } from '../queue/postgresConnectionStore.ts';
import { configToForm } from '../../recipes/retail-b2b-lead-spotter/adminForm.ts';
import { R1_DEFAULT_CONFIG, R1_ID } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';
import type { AppConfig } from './env.ts';

const URL = process.env.DATABASE_URL ?? '';
const skip = URL === '' ? 'DATABASE_URL not set' : false;
const SIGNING = 'test-signing-secret';
const SF_SECRET = 'SF-CLIENT-SECRET-VALUE-xyz';
const SHOP = 'example-store.myshopify.com';
const BODY = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'recipes', 'retail-b2b-lead-spotter', 'payloads', 'SHOPIFY_real_orders_paid_2026-10_subscribed.json'), 'utf8'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 20_000) {
  for (let t = 0; t < ms; t += 100) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error('timed out waiting for condition');
}

// ---- a fake Salesforce ---------------------------------------------------------------------------------
async function fakeSalesforce(opts: { createDelayMs?: number } = {}) {
  const requests: { method: string; path: string; auth: string | null; body: string }[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, auth: (req.headers.authorization as string) ?? null, body });
      const json = (status: number, v: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (path === '/services/oauth2/token') return json(200, { access_token: 'FAKE-TOKEN', instance_url: base, token_type: 'Bearer', scope: 'api' });
      if (path === '/services/data/') return json(200, [{ version: '68.0' }]);
      if (path.startsWith('/services/data/v68.0/query')) return json(200, { totalSize: 0, records: [] });
      if (req.method === 'POST' && path === '/services/data/v68.0/sobjects/Lead') {
        if (opts.createDelayMs) await sleep(opts.createDelayMs);
        return json(201, { id: `00Q${String(++n).padStart(12, '0')}`, success: true, errors: [] });
      }
      return json(404, [{ errorCode: 'NOT_FOUND', message: 'nope' }]);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    posts: () => requests.filter((r) => r.method === 'POST' && r.path.includes('/sobjects/')),
    queries: () => requests.filter((r) => r.path.includes('/query')),
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

// ---- the app under test ----------------------------------------------------------------------------------
async function withApp(
  fn: (c: { app: Awaited<ReturnType<typeof createApp>>; sf: Awaited<ReturnType<typeof fakeSalesforce>>; url: string; lines: string[]; schema: string; key: Buffer; deliver: (o?: { order?: number; shop?: string; webhookId?: string; sign?: string }) => Promise<number> }) => Promise<void>,
  opts: { createDelayMs?: number; purgeEveryMs?: number; stopAfter?: boolean; adminPassword?: string; apiKey?: string } = {},
) {
  const sf = await fakeSalesforce({ createDelayMs: opts.createDelayMs });
  const schema = `bridge_t_${randomBytes(4).toString('hex')}`;
  const lines: string[] = [];
  const key = randomBytes(32);
  const config: AppConfig = {
    databaseUrl: URL, schema, webhookSecret: SIGNING, encryptionKey: key, host: '127.0.0.1', port: 0,
    retention: DEFAULT_RETENTION, purgeEveryMinutes: 360, pollingSeconds: 1, shutdownTimeoutMs: 5000, adminPassword: opts.adminPassword ?? null, apiKey: opts.apiKey ?? null, trustProxy: false,
  };
  const app = await createApp(config, { log: makeLogger((l) => lines.push(l)), purgeEveryMs: opts.purgeEveryMs });
  const url = `http://127.0.0.1:${app.port}`;
  await app.stores.connections.put(SHOP, { loginUrl: sf.url, clientId: 'CLIENT-ID', clientSecret: SF_SECRET });
  const deliver = async (o: { order?: number; shop?: string; webhookId?: string; sign?: string } = {}) => {
    const order = o.order ?? 1;
    const raw = Buffer.from(JSON.stringify({ ...BODY, admin_graphql_api_id: `gid://shopify/Order/${order}`, name: `#${order}` }));
    const r = await fetch(`${url}/webhooks/shopify`, {
      method: 'POST',
      headers: {
        'X-Shopify-Hmac-SHA256': o.sign ?? createHmac('sha256', SIGNING).update(raw).digest('base64'),
        'X-Shopify-Topic': 'orders/paid', 'X-Shopify-Shop-Domain': o.shop ?? SHOP, 'X-Shopify-Webhook-Id': o.webhookId ?? `wh-${order}`,
      },
      body: raw,
    });
    return r.status;
  };
  try {
    await fn({ app, sf, url, lines, schema, key, deliver });
  } finally {
    await app.stop().catch(() => {});
    await sf.close();
    const p = new pg.Pool({ connectionString: URL, max: 1 });
    await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await p.end();
  }
}
const outcomes = (app: Awaited<ReturnType<typeof createApp>>) => app.stores.syncLog.recent({ limit: 100 }).then((e) => e.map((x) => x.outcome));

// ---------------------------------------------------------------------------------------------------------
test('live: a signed webhook over HTTP becomes a Lead in (fake) Salesforce, the log records it, and the secret is encrypted at rest', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, sf, deliver, schema, key }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    assert.equal(await deliver({ order: 1 }), 200);
    await until(async () => (await outcomes(app)).includes('created'));

    const post = sf.posts();
    assert.equal(post.length, 1);
    assert.equal(post[0].path, '/services/data/v68.0/sobjects/Lead');
    assert.equal(post[0].auth, 'Bearer FAKE-TOKEN');
    assert.deepEqual(JSON.parse(post[0].body), {
      Company: 'Acme Test Co', LastName: 'Buyer', Email: 'test-buyer@example.com', LeadSource: 'Shopify Order',
      Description: 'Order #1: The Compare at Price Snowboard. Total: 785.95 USD',
    });
    const entry = (await app.stores.syncLog.recent())[0];
    assert.deepEqual([entry.outcome, entry.shop, entry.objectId, entry.dryRun], ['created', SHOP, 'gid://shopify/Order/1', false]);
    assert.ok(entry.ops![0].sfId!.startsWith('00Q'));

    const raw = (await app.runtime.pool.query(`SELECT row_to_json(t)::text AS j FROM ${schema}.salesforce_connection t`)).rows[0].j as string;
    assert.ok(!raw.includes(SF_SECRET), 'the Salesforce secret is not in the table');
    // ...and it is encrypted with the CONFIGURED key: an independent store built from that key reads it back
    const independent = new PostgresConnectionStore(app.runtime.pool, schema, key);
    assert.equal((await independent.get(SHOP))!.clientSecret, SF_SECRET);
    // a Shopify retry of the same delivery changes nothing
    assert.equal(await deliver({ order: 1 }), 200);
    await sleep(1500);
    assert.equal(sf.posts().length, 1);
  });
});

test('a recipe that is only just enabled is DRY-RUN: lookups happen, nothing is written', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, sf, deliver }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, config: R1_DEFAULT_CONFIG }); // dryRun not given
    assert.equal(await deliver({ order: 2 }), 200);
    await until(async () => (await outcomes(app)).includes('dry_run'));
    assert.equal(sf.posts().length, 0);
    assert.ok(sf.queries().length >= 2, 'read-only lookups ran');
    const planned = (await app.stores.syncLog.recent())[0].ops![0].planned as any;
    assert.equal(planned.fields.Email, 't***@example.com');
  });
});

test('kill switch: after disabling, the next order makes ZERO Salesforce requests', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, sf, deliver }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await deliver({ order: 3 });
    await until(async () => (await outcomes(app)).includes('created'));
    const before = sf.requests.length;
    assert.equal(await app.stores.configs.disable(SHOP, R1_ID), true);
    await deliver({ order: 4 });
    await until(async () => (await outcomes(app)).includes('recipe_disabled'));
    assert.equal(sf.requests.length, before, 'no Salesforce traffic at all after the kill switch');
  });
});

test('a shop with the recipe enabled but no stored Salesforce connection: logged as a retry (NO_CONNECTION), nothing written', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, sf, deliver }) => {
    await app.stores.configs.set('lonely.myshopify.com', R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    assert.equal(await deliver({ order: 5, shop: 'lonely.myshopify.com' }), 200);
    await until(async () => (await app.stores.syncLog.recent()).some((e) => e.outcome === 'retry' && e.errorCode === 'NO_CONNECTION'));
    assert.equal(sf.requests.length, 0);
  });
});

test('forged and malformed requests: 401 / 404 / 413, nothing queued, nothing logged as a job', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, sf, url, deliver }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    assert.equal(await deliver({ order: 6, sign: createHmac('sha256', 'attacker').update('x').digest('base64') }), 401);
    assert.equal((await fetch(`${url}/webhooks/shopify`)).status, 404);
    assert.equal((await fetch(`${url}/anything-else`, { method: 'POST', body: 'x' })).status, 404);
    await sleep(1500);
    assert.equal(sf.requests.length, 0);
    assert.deepEqual(await outcomes(app), []);
  });
});

test('health: /healthz always ok, /readyz ready; after draining /readyz is 503 while /healthz stays 200; bodies carry no data', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, url }) => {
    const h = await fetch(`${url}/healthz`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { status: 'ok' });
    const r = await fetch(`${url}/readyz`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ready' });
    app.drain();
    const r2 = await fetch(`${url}/readyz`);
    assert.equal(r2.status, 503);
    assert.deepEqual(await r2.json(), { status: 'stopping' });
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/healthz`, { method: 'POST' })).status, 404);
  });
});

test('/readyz is 503 when the database is unreachable', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, url }) => {
    const realQuery = app.runtime.pool.query.bind(app.runtime.pool);
    (app.runtime.pool as any).query = (text: any, ...rest: any[]) => (String(text) === 'SELECT 1' ? Promise.reject(new Error('db down')) : (realQuery as any)(text, ...rest));
    const r = await fetch(`${url}/readyz`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { status: 'database unavailable' });
    assert.equal((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) })).status, 200, 'liveness does not depend on the database');
  });
});

test('retention runs on a schedule: an expired log row disappears without anyone asking', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, lines }) => {
    await app.stores.syncLog.record({ at: '2020-01-01T00:00:00.000Z', shop: SHOP, recipeId: R1_ID, topic: 'orders/paid', objectId: 'gid://shopify/Order/old', webhookId: 'old', outcome: 'created', dryRun: false });
    assert.equal((await app.stores.syncLog.recent()).length, 1);
    await until(async () => (await app.stores.syncLog.recent()).length === 0, 10_000);
    assert.ok(lines.some((l) => JSON.parse(l).event === 'purge'));
  }, { purgeEveryMs: 300 });
});

test('graceful shutdown: a job that is running FINISHES before the service exits; the port closes; stopping twice is safe', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, sf, url, deliver, lines, schema }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    assert.equal(await deliver({ order: 7 }), 200);
    await until(() => sf.posts().length === 1, 15_000); // the job is now inside the slow Lead create
    const stopping = app.stop();
    await stopping;
    // the app's own pool is closed now, so read the result through a fresh pool
    const p = new pg.Pool({ connectionString: URL, max: 1 });
    try {
      const rows = (await p.query(`SELECT outcome FROM ${schema}.sync_log`)).rows.map((r) => r.outcome);
      assert.deepEqual(rows, ['created'], 'the running job completed and was logged before shutdown finished');
    } finally {
      await p.end();
    }
    await assert.rejects(() => fetch(`${url}/healthz`), 'the port is closed');
    await app.stop(); // idempotent
    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.indexOf('stopping') < events.indexOf('stopped'));
    assert.equal(events.filter((e) => e === 'stopping').length, 1, 'shutdown ran exactly once');
    assert.equal(events.filter((e) => e === 'stopped').length, 1);
  }, { createDelayMs: 1500 });
});

test('logs never contain the signing secret, the Salesforce secret, the token, the customer email or the last name', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, deliver, lines }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await deliver({ order: 8 });
    await deliver({ order: 9, sign: 'AAAA' });
    await until(async () => (await outcomes(app)).includes('created'));
    const text = lines.join('\n');
    assert.ok(text.length > 0);
    for (const leak of [SIGNING, SF_SECRET, 'FAKE-TOKEN', 'test-buyer@example.com', '"Buyer"', 'Snowboard']) assert.ok(!text.includes(leak), `leak: ${leak}`);
    const stored = JSON.stringify(await app.stores.syncLog.recent());
    for (const leak of [SIGNING, SF_SECRET, 'FAKE-TOKEN', 'test-buyer@example.com', '"Buyer"']) assert.ok(!stored.includes(leak), `stored leak: ${leak}`);
  });
});

test('a failed start (port already in use) rejects and leaks no database connections', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app }) => {
    // Count ONLY this test's own connections (unique application_name): other test files use the same database at the same time.
    const tag = `leak_app_${randomBytes(4).toString('hex')}`;
    const tagged = new globalThis.URL(URL); // (URL is shadowed by the connection string)
    tagged.searchParams.set('application_name', tag);
    const probe = new pg.Pool({ connectionString: URL, max: 1 });
    const count = async () => (await probe.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`, [tag])).rows[0].n as number;
    const schema2 = `bridge_t_${randomBytes(4).toString('hex')}`;
    const cfg: AppConfig = { databaseUrl: tagged.toString(), schema: schema2, webhookSecret: SIGNING, encryptionKey: randomBytes(32), host: '127.0.0.1', port: app.port, retention: DEFAULT_RETENTION, purgeEveryMinutes: 360, pollingSeconds: 1, shutdownTimeoutMs: 3000, adminPassword: null, apiKey: null, trustProxy: false };
    await assert.rejects(() => createApp(cfg, { log: () => {} }), /EADDRINUSE|address already in use/);
    let left = -1;
    for (let i = 0; i < 20; i++) { // closing is asynchronous: wait for it, up to 4 s
      left = await count();
      if (left === 0) break;
      await sleep(200);
    }
    await probe.query(`DROP SCHEMA IF EXISTS ${schema2} CASCADE`);
    await probe.end();
    assert.equal(left, 0, `connections still open under the failed start's tag: ${left}`);
  });
});


// ---- the admin UI inside the running service ---------------------------------------------------------------
const ADMIN_PW = 'admin-password-123';

function browser(base: string) {
  let cookie = '';
  const call = async (method: string, path: string, fields?: Record<string, string>) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: fields ? new URLSearchParams(fields).toString() : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc && !sc.includes('Max-Age=0')) cookie = sc.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const b = {
    get cookie() { return cookie; },
    get: (p: string) => call('GET', p),
    post: (p: string, f: Record<string, string>) => call('POST', p, f),
    async csrf(p = '/admin') { const m = /name="csrf" value="([^"]+)"/.exec((await call('GET', p)).text); assert.ok(m, `csrf on ${p}`); return m![1]; },
  };
  return b;
}

test('admin is OFF unless ADMIN_PASSWORD is set: /admin does not exist', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ url }) => {
    for (const path of ['/admin', '/admin/login', '/admin/shops/x.myshopify.com']) assert.equal((await fetch(`${url}${path}`, { redirect: 'manual' })).status, 404, path);
  });
});

test('admin end to end: add shop, connect Salesforce, test it, dry-run, go live, kill switch; the worker obeys every step', { skip, timeout: 90_000 }, async () => {
  await withApp(async ({ app, sf, url, deliver, schema }) => {
    const NEW = 'ui-store.myshopify.com';
    const b = browser(url);
    assert.equal((await b.post('/admin/login', { password: ADMIN_PW })).location, '/admin');
    let csrf = await b.csrf();

    assert.equal((await b.post('/admin/shops', { csrf, shop: NEW })).location, `/admin/shops/${NEW}?msg=shop_added`);
    const conn = await b.post(`/admin/shops/${NEW}/connection`, { csrf, loginUrl: sf.url, clientId: 'UI-CLIENT-ID', clientSecret: SF_SECRET });
    assert.equal(conn.location, `/admin/shops/${NEW}?msg=connection_saved`);
    assert.equal((await b.post(`/admin/shops/${NEW}/verify`, { csrf })).location, `/admin/shops/${NEW}?msg=verified_ok`);
    assert.ok(sf.queries().length >= 1, 'Test connection ran a real read against the (fake) Salesforce');

    // the page never shows the secret; the database never holds it in plaintext
    const page = await b.get(`/admin/shops/${NEW}`);
    assert.ok(!page.text.includes(SF_SECRET) && page.text.includes('stored (encrypted)'));
    const raw = (await app.runtime.pool.query(`SELECT row_to_json(t)::text AS j FROM ${schema}.salesforce_connection t WHERE shop = $1`, [NEW])).rows[0].j as string;
    assert.ok(!raw.includes(SF_SECRET));

    // enable in dry-run -> an order is only PLANNED
    assert.equal((await b.post(`/admin/shops/${NEW}/recipe`, { csrf, action: 'enable_dry' })).location, `/admin/shops/${NEW}?msg=enabled_dry`);
    assert.equal(await deliver({ order: 11, shop: NEW }), 200);
    await until(async () => (await outcomes(app)).includes('dry_run'));
    assert.equal(sf.posts().length, 0, 'dry-run wrote nothing');

    // wrong confirmation does not go live
    assert.equal((await b.post(`/admin/shops/${NEW}/recipe`, { csrf, action: 'go_live', confirm: 'yes' })).status, 400);
    assert.equal((await app.stores.configs.get(NEW, R1_ID))!.dryRun, true);

    // go live -> the next order is written
    assert.equal((await b.post(`/admin/shops/${NEW}/recipe`, { csrf, action: 'go_live', confirm: 'LIVE' })).location, `/admin/shops/${NEW}?msg=live`);
    assert.equal(await deliver({ order: 12, shop: NEW }), 200);
    await until(async () => (await outcomes(app)).includes('created'));
    assert.equal(sf.posts().length, 1);

    // kill switch -> the next order makes zero Salesforce traffic
    assert.equal((await b.post(`/admin/shops/${NEW}/recipe`, { csrf, action: 'disable' })).location, `/admin/shops/${NEW}?msg=disabled`);
    const before = sf.requests.length;
    assert.equal(await deliver({ order: 13, shop: NEW }), 200);
    await until(async () => (await outcomes(app)).includes('recipe_disabled'));
    assert.equal(sf.requests.length, before);

    // settings change is validated, stored, and visible
    csrf = await b.csrf(`/admin/shops/${NEW}`);
    const saved = await b.post(`/admin/shops/${NEW}/config`, { csrf, leadSource: 'Web', minOrderTotal: '5', requireConsent: 'on', existingLeadAction: 'update', companyOverride: '', leadOwnerId: '', allowDomains: '', denyDomains: '', freeEmailBlocklist: 'gmail.com' });
    assert.equal(saved.location, `/admin/shops/${NEW}?msg=config_saved`);
    assert.equal(((await app.stores.configs.get(NEW, R1_ID))!.config as any).leadSource, 'Web');
    assert.equal((await b.post(`/admin/shops/${NEW}/config`, { csrf, leadSource: '', minOrderTotal: 'x', existingLeadAction: 'update', companyOverride: '', leadOwnerId: '', allowDomains: '', denyDomains: '', freeEmailBlocklist: '' })).status, 422);

    // the log viewer shows what the worker did
    const log = await b.get(`/admin/shops/${NEW}/log`);
    for (const o of ['dry_run', 'created', 'recipe_disabled']) assert.ok(log.text.includes(o), o);
    assert.ok(!log.text.includes('test-buyer@example.com') && !log.text.includes('Buyer'));

    // the audit trail recorded the actions, without the secret
    const audit = await app.runtime.pool.query(`SELECT action, detail FROM ${schema}.admin_audit ORDER BY id`);
    const actions = audit.rows.map((r) => r.action);
    for (const a of ['login_ok', 'shop_added', 'connection_saved', 'connection_verified', 'recipe_dry_run', 'recipe_live', 'recipe_disabled', 'config_saved']) assert.ok(actions.includes(a), a);
    assert.ok(!JSON.stringify(audit.rows).includes(SF_SECRET));
  }, { adminPassword: ADMIN_PW });
});

test('admin: a dead-lettered job is listed (without payload) and replaying it runs it through the worker again', { skip, timeout: 90_000 }, async () => {
  await withApp(async ({ app, url }) => {
    const { WEBHOOK_DEAD_QUEUE } = await import('../queue/config.ts');
    await app.runtime.boss.send(WEBHOOK_DEAD_QUEUE, {
      webhookId: 'dead-1', eventId: 'e', topic: 'orders/paid', shop: SHOP, apiVersion: '2026-10', businessKey: 'orders/paid|s|dead-1',
      receivedAt: '2026-10-21T00:00:00.000Z', payload: JSON.stringify({ ...BODY, admin_graphql_api_id: 'gid://shopify/Order/77', name: '#77' }),
    });
    const b = browser(url);
    await b.post('/admin/login', { password: ADMIN_PW });
    const page = await b.get('/admin/replay');
    assert.ok(page.text.includes('orders/paid|s|dead-1'));
    assert.ok(!page.text.includes('test-buyer@example.com') && !page.text.includes('"payload"') && !page.text.includes('Snowboard'), 'no payload or customer data on the page');
    const id = /name="id" value="([0-9a-f-]{36})"/.exec(page.text)![1];
    const csrf = await b.csrf('/admin/replay');
    assert.equal((await b.post('/admin/replay', { csrf, id })).location, '/admin/replay?msg=replayed');
    // no recipe is configured for this shop, so the replayed job is processed and logged as recipe_disabled: proof the worker ran it
    await until(async () => (await outcomes(app)).includes('recipe_disabled'), 20_000);
    assert.ok(!(await b.get('/admin/replay')).text.includes('orders/paid|s|dead-1'), 'it left the failed list');
    assert.equal((await b.post('/admin/replay', { csrf, id })).location, '/admin/replay?msg=nothing_to_replay');
  }, { adminPassword: ADMIN_PW });
});

test('admin: unauthenticated and forged requests against the REAL service change nothing', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, url }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    const anon = await fetch(`${url}/admin/shops/${SHOP}/recipe`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=disable' });
    assert.equal(anon.status, 303);
    assert.equal((await app.stores.configs.get(SHOP, R1_ID))!.enabled, true);
    const b = browser(url);
    await b.post('/admin/login', { password: ADMIN_PW });
    const forged = await fetch(`${url}/admin/shops/${SHOP}/recipe`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: b.cookie }, body: 'action=disable&csrf=nope' });
    assert.ok(b.cookie.startsWith('bridge_admin='), 'the test really is logged in');
    assert.equal(forged.status, 403, 'a logged-in request with a wrong CSRF token is refused');
    assert.equal((await app.stores.configs.get(SHOP, R1_ID))!.enabled, true);
    assert.equal((await b.post('/admin/login', { password: 'wrong-password-here' })).status, 401);
  }, { adminPassword: ADMIN_PW });
});

// ---- privacy webhooks through the real service ------------------------------------------------------------------
async function lifecycleDeliver(url: string, topic: string, body: Record<string, unknown>, o: { shop?: string; webhookId: string; sign?: string }) {
  const raw = Buffer.from(JSON.stringify(body));
  const r = await fetch(`${url}/webhooks/shopify`, {
    method: 'POST',
    headers: { 'X-Shopify-Hmac-SHA256': o.sign ?? createHmac('sha256', SIGNING).update(raw).digest('base64'), 'X-Shopify-Topic': topic, 'X-Shopify-Shop-Domain': o.shop ?? SHOP, 'X-Shopify-Webhook-Id': o.webhookId },
    body: raw,
  });
  return r.status;
}
const complianceRows = (app: Awaited<ReturnType<typeof createApp>>, schema: string) =>
  app.runtime.pool.query(`SELECT kind, shop, request_ref, detail FROM ${schema}.compliance_log ORDER BY id`).then((r) => r.rows);

test('privacy webhooks: customers/redact really erases the order end to end, records it, and shows it in the admin', { skip, timeout: 90_000 }, async () => {
  await withApp(async ({ app, url, deliver, schema }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await deliver({ order: 21 });
    await until(async () => (await outcomes(app)).includes('created'));
    await deliver({ order: 22 });
    await until(async () => (await outcomes(app)).filter((o) => o === 'created').length === 2);
    const gid21 = 'gid://shopify/Order/21';
    assert.equal((await app.runtime.pool.query(`SELECT count(*)::int n FROM ${schema}.sync_log WHERE object_id = $1`, [gid21])).rows[0].n, 1);

    // Shopify's documented payload, including the customer's email and phone, which must not be stored anywhere
    const status = await lifecycleDeliver(url, 'customers/redact', { shop_id: 954889, shop_domain: SHOP, customer: { id: 191167, email: 'john@example.com', phone: '555-625-1199' }, orders_to_redact: [21] }, { webhookId: 'wh-redact-21' });
    assert.equal(status, 200);
    await until(async () => (await complianceRows(app, schema)).length === 1);

    const q = async (sql: string, v: unknown[] = []) => (await app.runtime.pool.query(sql, v)).rows[0].n as number;
    assert.equal(await q(`SELECT count(*)::int n FROM ${schema}.sync_log WHERE object_id = $1`, [gid21]), 0, 'order 21 erased from the log');
    assert.equal(await q(`SELECT count(*)::int n FROM ${schema}.entity_map WHERE match_key = $1`, [`r1:${gid21}`]), 0);
    assert.equal(await q(`SELECT count(*)::int n FROM ${schema}.sync_log WHERE object_id = $1`, ['gid://shopify/Order/22']), 1, 'order 22 untouched');
    const rows = await complianceRows(app, schema);
    assert.equal(rows[0].kind, 'customers/redact');
    assert.ok(rows[0].detail.salesforceRecordsToReview[0].startsWith('Lead:00Q'), 'the merchant is told which Salesforce record to review');

    // the customer's email/phone never reached the database
    const everything = JSON.stringify((await app.runtime.pool.query(`SELECT * FROM ${schema}.webhook_intake`)).rows) + JSON.stringify(rows);
    for (const leak of ['john@example.com', '555-625-1199', '191167']) assert.ok(!everything.includes(leak), leak);
    const jobs = JSON.stringify(await app.runtime.boss.findJobs('webhook-jobs', { limit: 100 } as any));
    for (const leak of ['john@example.com', '555-625-1199']) assert.ok(!jobs.includes(leak), `queued job holds ${leak}`);

    // and the sync log has no entry for the privacy job itself
    assert.ok(!(await outcomes(app)).includes('lifecycle_done'));

    // the admin shows it
    const b = browser(url);
    await b.post('/admin/login', { password: ADMIN_PW });
    const list = await b.get('/admin/compliance');
    assert.ok(list.text.includes('Customer data deleted') && list.text.includes('wh-redact-21'));
    const detail = await b.get(`/admin/compliance/${/\/admin\/compliance\/(\d+)/.exec(list.text)![1]}`);
    assert.ok(detail.text.includes('Lead:00Q'));
  }, { adminPassword: ADMIN_PW });
});

test('privacy webhooks: shop/redact erases the shop including its stored Salesforce credentials; uninstall disables and drops credentials', { skip, timeout: 90_000 }, async () => {
  await withApp(async ({ app, url, deliver, schema, sf }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await deliver({ order: 31 });
    await until(async () => (await outcomes(app)).includes('created'));
    assert.ok(await app.stores.connections.get(SHOP));

    assert.equal(await lifecycleDeliver(url, 'app/uninstalled', { id: 954889, domain: SHOP }, { webhookId: 'wh-un' }), 200);
    await until(async () => (await complianceRows(app, schema)).some((r) => r.kind === 'app/uninstalled'));
    assert.equal(await app.stores.connections.get(SHOP), null, 'credentials dropped at uninstall');
    const afterUninstall = await app.stores.configs.get(SHOP, R1_ID);
    assert.equal(afterUninstall?.enabled, false, 'the recipe is switched off at uninstall');
    assert.deepEqual(afterUninstall?.config, R1_DEFAULT_CONFIG, 'its settings are kept until shop/redact');
    // after uninstall the next order does nothing at Salesforce
    const before = sf.requests.length;
    await deliver({ order: 32 });
    await until(async () => (await outcomes(app)).includes('recipe_disabled'));
    assert.equal(sf.requests.length, before);

    assert.equal(await lifecycleDeliver(url, 'shop/redact', { shop_id: 954889, shop_domain: SHOP }, { webhookId: 'wh-sr' }), 200);
    await until(async () => (await complianceRows(app, schema)).some((r) => r.kind === 'shop/redact'));
    for (const t of ['sync_log', 'entity_map', 'recipe_config', 'salesforce_connection']) {
      assert.equal((await app.runtime.pool.query(`SELECT count(*)::int n FROM ${schema}.${t} WHERE shop = $1`, [SHOP])).rows[0].n, 0, t);
    }
    const left = await complianceRows(app, schema);
    assert.deepEqual(left.map((r) => r.kind).sort(), ['shop/redact'], 'only the record of the erasure remains');
  });
});

test('privacy webhooks: a forged signature is 401 and erases nothing; a body naming another shop is 400; a data request deletes nothing', { skip, timeout: 90_000 }, async () => {
  await withApp(async ({ app, url, deliver, schema }) => {
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await deliver({ order: 41 });
    await until(async () => (await outcomes(app)).includes('created'));
    const body = { shop_id: 1, shop_domain: SHOP, customer: { id: 1, email: 'x@y.z' }, orders_to_redact: [41] };
    assert.equal(await lifecycleDeliver(url, 'customers/redact', body, { webhookId: 'wh-f1', sign: 'AAAA' }), 401);
    assert.equal(await lifecycleDeliver(url, 'customers/redact', { ...body, shop_domain: 'someone-else.myshopify.com' }, { webhookId: 'wh-f2' }), 400);
    assert.equal(await lifecycleDeliver(url, 'customers/redact', { ...body, orders_to_redact: ['not-a-number'] }, { webhookId: 'wh-f3' }), 400);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await complianceRows(app, schema)).length, 0);
    assert.equal((await app.runtime.pool.query(`SELECT count(*)::int n FROM ${schema}.sync_log WHERE object_id = 'gid://shopify/Order/41'`)).rows[0].n, 1, 'nothing was erased');

    assert.equal(await lifecycleDeliver(url, 'customers/data_request', { shop_id: 1, shop_domain: SHOP, orders_requested: [41], customer: { id: 1, email: 'x@y.z' }, data_request: { id: 7 } }, { webhookId: 'wh-dr' }), 200);
    await until(async () => (await complianceRows(app, schema)).length === 1);
    assert.equal((await complianceRows(app, schema))[0].detail.requestedOrders, 1);
    assert.equal((await app.runtime.pool.query(`SELECT count(*)::int n FROM ${schema}.sync_log WHERE object_id = 'gid://shopify/Order/41'`)).rows[0].n, 1, 'a data request never deletes');
  });
});

test('infrastructure errors are logged as a fixed event without the error text', { skip, timeout: 60_000 }, async () => {
  await withApp(async ({ app, lines }) => {
    app.runtime.pool.emit('error', new Error('connection lost postgres://user:hunter2@db.internal/prod'));
    const text = lines.join('\n');
    assert.ok(text.includes('infrastructure_error') && text.includes('"source":"pool"'));
    assert.ok(!text.includes('hunter2') && !text.includes('db.internal'));
  });
});

test('the embedded /app surface: absent without SHOPIFY_API_KEY; with it, only a Shopify-signed token for a shop the service knows gets in', { skip, timeout: 60_000 }, async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (shop: string) => {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const p = b64({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: 'APP-CLIENT-ID', exp: now + 60, nbf: now - 5, sub: '1' });
    return `${h}.${p}.${createHmac('sha256', SIGNING).update(`${h}.${p}`).digest('base64url')}`;
  };
  await withApp(async ({ url }) => {
    assert.equal((await fetch(`${url}/app?shop=${SHOP}`)).status, 404, 'switched off without the client id');
    assert.equal((await fetch(`${url}/app/api/home`, { headers: { Authorization: `Bearer ${tok(SHOP)}` } })).status, 404);
  });
  await withApp(async ({ app, url, deliver }) => {
    const OTHER = 'second-store.myshopify.com';
    await app.stores.configs.set(SHOP, R1_ID, { enabled: true, dryRun: true, config: R1_DEFAULT_CONFIG });
    assert.equal(await deliver({ order: 1 }), 200);
    assert.equal(await deliver({ order: 2, shop: OTHER }), 200);
    await until(async () => (await app.stores.syncLog.recent({ limit: 10 })).length === 2);
    const page = async (shop: string, route: string) => (await fetch(`${url}/app/api/${route}`, { headers: { Authorization: `Bearer ${tok(shop)}` } })).text();
    const mine = await page(SHOP, 'home');
    assert.ok(mine.includes('DRY-RUN') && mine.includes('gid://shopify/Order/1') && !mine.includes('gid://shopify/Order/2'), 'a shop sees only its own decisions (home)');
    const mineLog = await page(SHOP, 'log');
    assert.ok(mineLog.includes('gid://shopify/Order/1') && !mineLog.includes('gid://shopify/Order/2'), 'and in the log');
    const token = (shop: string) => ({ Authorization: `Bearer ${tok(shop)}` });
    // A store that merely installed the app and sent a webhook (it is in the log) is NOT set up by the operator: no page for it.
    for (const route of ['home', 'log']) assert.equal((await fetch(`${url}/app/api/${route}`, { headers: token(OTHER) })).status, 403, `${route}: logged but never set up`);
    // Once the operator adds it ("Add a shop" stores a recipe-settings row), it sees only its own data.
    await app.stores.configs.set(OTHER, R1_ID, { enabled: false, dryRun: true, config: R1_DEFAULT_CONFIG });
    const theirs = await page(OTHER, 'log');
    assert.ok(theirs.includes('<s-badge tone="neutral">recipe_disabled</s-badge>') && !theirs.includes('gid://shopify/Order/1') && !theirs.includes('<s-badge tone="neutral">dry_run</s-badge>'), 'the other shop sees only its own (its recipe is off, so its row is recipe_disabled)');
    assert.ok((await page(OTHER, 'home')).includes('DISABLED'), 'an added shop whose recipe is off shows as disabled');
    // A stored Salesforce connection also counts as set up by the operator.
    const THIRD = 'third-store.myshopify.com';
    assert.equal((await fetch(`${url}/app/api/home`, { headers: token(THIRD) })).status, 403);
    await app.stores.connections.put(THIRD, { loginUrl: 'http://127.0.0.1:1', clientId: 'C', clientSecret: 'S' });
    assert.equal((await fetch(`${url}/app/api/home`, { headers: token(THIRD) })).status, 200);

    const shell = await fetch(`${url}/app?shop=${SHOP}`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-security-policy') ?? '', /frame-ancestors https:\/\/example-store\.myshopify\.com https:\/\/admin\.shopify\.com/);
    // the shop was connected by withApp, so it is known
    const ok = await fetch(`${url}/app/api/home`, { headers: { Authorization: `Bearer ${tok(SHOP)}` } });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`${url}/app/api/home`, { headers: { Authorization: `Bearer ${tok('stranger.myshopify.com')}` } })).status, 403);
    assert.equal((await fetch(`${url}/app/api/home`)).status, 401);
    assert.equal(await app.stores.connections.get('stranger.myshopify.com'), null, 'a valid token does not create a shop');
    assert.equal((await fetch(`${url}/healthz`)).status, 200, 'the rest of the service is untouched');
  }, { apiKey: 'APP-CLIENT-ID' });
});

test('embedded writes end to end: connect, test, dry-run, go-live refused, kill switch - real stores, audited with the Shopify user, secrets never stored in the clear', { skip, timeout: 60_000 }, async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (shop: string) => {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const p = b64({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: 'APP-CLIENT-ID', exp: now + 60, nbf: now - 5, sub: 'staff-7' });
    return `${h}.${p}.${createHmac('sha256', SIGNING).update(`${h}.${p}`).digest('base64url')}`;
  };
  const NEW_SECRET = 'EMBEDDED-ENTERED-SECRET-123';
  await withApp(async ({ app, sf, url, schema, key }) => {
    const NEWSHOP = 'fresh-store.myshopify.com';
    const call = (shop: string, path: string, body: Record<string, string>) => fetch(`${url}/app/api/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok(shop)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
    });
    // The operator set the shop up ("Add a shop" stores a settings row); only then may it use the page.
    assert.equal((await call(NEWSHOP, 'recipe', { action: 'enable_dry' })).status, 403, 'not set up yet');
    await app.stores.configs.set(NEWSHOP, R1_ID, { enabled: false, dryRun: true, config: R1_DEFAULT_CONFIG });

    // a connection to an org that is not there must FAIL the test (never a canned "works")
    assert.equal((await call(NEWSHOP, 'connection', { loginUrl: 'http://127.0.0.1:9', clientId: 'CID-0', clientSecret: NEW_SECRET })).status, 200);
    const failed = await (await call(NEWSHOP, 'verify', {})).text();
    assert.ok(failed.includes('Connection check failed') && !failed.includes('The Salesforce connection works.') && !failed.includes(NEW_SECRET), failed.slice(0, 300));
    const saved = await call(NEWSHOP, 'connection', { loginUrl: sf.url, clientId: 'CID-2', clientSecret: NEW_SECRET });
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes(NEW_SECRET));
    assert.equal((await app.stores.connections.get(NEWSHOP))?.clientSecret, NEW_SECRET);
    const verified = await (await call(NEWSHOP, 'verify', {})).text();
    assert.ok(verified.includes('The Salesforce connection works.'), verified.slice(0, 300));
    assert.equal((await call(NEWSHOP, 'recipe', { action: 'enable_dry' })).status, 200);
    assert.deepEqual(await app.stores.configs.get(NEWSHOP, R1_ID).then((x) => [x?.enabled, x?.dryRun]), [true, true]);
    // settings: the same validation as the operator page, stored for this shop only, mode untouched, audited with the user
    const form = configToForm(R1_DEFAULT_CONFIG);
    const body = (over: Record<string, string>): Record<string, string> => ({ ...Object.fromEntries(Object.entries(form).filter(([, v]) => v !== false).map(([k, v]) => [k, v === true ? 'on' : String(v)])), ...over });
    const saved2 = await call(NEWSHOP, 'settings', body({ leadSource: 'Embedded Test Source' }));
    assert.equal(saved2.status, 200);
    assert.equal((await app.stores.configs.get(NEWSHOP, R1_ID))?.config.leadSource, 'Embedded Test Source');
    assert.deepEqual(await app.stores.configs.get(NEWSHOP, R1_ID).then((x) => [x?.enabled, x?.dryRun]), [true, true], 'saving settings left the mode alone');
    const refused = await call(NEWSHOP, 'settings', body({ minOrderTotal: 'not-a-number' }));
    assert.equal(refused.status, 422);
    assert.equal((await app.stores.configs.get(NEWSHOP, R1_ID))?.config.leadSource, 'Embedded Test Source', 'a refused save changed nothing');
    assert.equal((await app.stores.configs.get(SHOP, R1_ID)), null, 'the other shop was not touched');
    const page = await (await fetch(`${url}/app/api/settings`, { headers: { Authorization: `Bearer ${tok(NEWSHOP)}` } })).text();
    assert.ok(page.includes('value="Embedded Test Source"'));
    const jobsPage = await fetch(`${url}/app/api/jobs`, { headers: { Authorization: `Bearer ${tok(NEWSHOP)}` } });
    assert.equal(jobsPage.status, 200);
    assert.ok((await jobsPage.text()).includes('No failed jobs.'));
    assert.equal((await call(NEWSHOP, 'replay', { id: 'all' })).status, 200, 'replay with nothing failed is a harmless no-op');

    // privacy requests: each shop sees only its own records, selected in the database (another shop's volume cannot hide them)
    const pp = new pg.Pool({ connectionString: URL, max: 1 });
    try {
      const ins = (kind: string, shop: string, ref: string, at: string) => pp.query(`INSERT INTO ${schema}.compliance_log (at, kind, shop, request_ref, detail) VALUES ($1, $2, $3, $4, $5)`, [at, kind, shop, ref, { ordersRedacted: 3, salesforceRecordsToReview: ['00Qxx0000099999'] }]);
      await ins('app/uninstalled', NEWSHOP, 'mine-1', '2026-10-20T10:00:00Z');
      for (let i = 0; i < 205; i++) await ins('customers/redact', SHOP, `busy-${i}`, `2026-10-26T10:00:00Z`);
      const mineHtml = await (await fetch(`${url}/app/api/privacy`, { headers: { Authorization: `Bearer ${tok(NEWSHOP)}` } })).text();
      assert.ok(mineHtml.includes('mine-1') && !mineHtml.includes('busy-'), 'my record is shown even though another shop has 205 newer ones');
      const rowId = (await pp.query(`SELECT id FROM ${schema}.compliance_log WHERE request_ref = 'busy-0'`)).rows[0].id;
      const foreign = await (await fetch(`${url}/app/api/privacy?id=${rowId}`, { headers: { Authorization: `Bearer ${tok(NEWSHOP)}` } })).text();
      assert.ok(!foreign.includes('00Qxx0000099999') && foreign.includes('<s-page heading="Privacy requests">'), "another shop's request id shows nothing");
      const ownId = (await pp.query(`SELECT id FROM ${schema}.compliance_log WHERE request_ref = 'mine-1'`)).rows[0].id;
      const detail = await (await fetch(`${url}/app/api/privacy?id=${ownId}`, { headers: { Authorization: `Bearer ${tok(NEWSHOP)}` } })).text();
      assert.ok(detail.includes('00Qxx0000099999') && detail.includes('ordersRedacted</s-text>: 3'));
    } finally {
      await pp.end();
    }

    // going LIVE is not possible from the embedded page, with or without the word and a stored connection
    for (const confirm of ['live', 'LIVE']) assert.equal((await call(NEWSHOP, 'recipe', { action: 'go_live', confirm })).status, 403);
    assert.deepEqual(await app.stores.configs.get(NEWSHOP, R1_ID).then((x) => [x?.enabled, x?.dryRun]), [true, true], 'still dry-run');
    assert.equal((await call(NEWSHOP, 'recipe', { action: 'disable' })).status, 200);
    assert.equal((await app.stores.configs.get(NEWSHOP, R1_ID))?.enabled, false);
    // the other shop was not touched by any of it
    assert.equal((await app.stores.configs.get(SHOP, R1_ID)), null);

    const p = new pg.Pool({ connectionString: URL, max: 1 });
    try {
      const rows = (await p.query(`SELECT action, shop, detail FROM ${schema}.admin_audit ORDER BY id`)).rows;
      const s_fail_detail = (all: any[]) => { const d = String(all.find((r) => r.action === 'connection_failed')?.detail ?? ''); assert.match(d, / · user staff-7$/); return d; };
      assert.deepEqual(rows.map((r) => [r.action, r.shop, r.detail]), [
        ['connection_saved', NEWSHOP, 'user staff-7'], ['connection_failed', NEWSHOP, s_fail_detail(rows)], ['connection_saved', NEWSHOP, 'user staff-7'],
        ['connection_verified', NEWSHOP, 'user staff-7'], ['recipe_dry_run', NEWSHOP, 'user staff-7'], ['config_saved', NEWSHOP, 'user staff-7'],
        ['recipe_disabled', NEWSHOP, 'user staff-7'],
      ]);
      const raw = JSON.stringify((await p.query(`SELECT * FROM ${schema}.salesforce_connection WHERE shop = $1`, [NEWSHOP])).rows);
      assert.ok(!raw.includes(NEW_SECRET), 'the entered secret is encrypted at rest');
      assert.ok(!JSON.stringify(rows).includes(NEW_SECRET));
    } finally {
      await p.end();
    }
    assert.ok(key.length === 32);
  }, { apiKey: 'APP-CLIENT-ID' });
});
