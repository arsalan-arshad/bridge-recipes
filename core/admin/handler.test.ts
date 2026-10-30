// The admin UI over real HTTP (a local server around createAdminHandler) with in-memory fakes behind it.
// These are mostly SECURITY tests: authentication, CSRF, origin, escaping, secrets, headers, validation, replay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createAdminHandler } from './handler.ts';
import type { AdminDeps } from './handler.ts';
import { deriveSessionKey } from './security.ts';
import { MemoryConnectionStore } from '../salesforce/connectionStore.ts';
import { r1Recipe, R1_DEFAULT_CONFIG, R1_ID } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';
import { validateR1Config } from '../../recipes/retail-b2b-lead-spotter/validateConfig.ts';
import { configToForm, formToConfig } from '../../recipes/retail-b2b-lead-spotter/adminForm.ts';
import type { LogEntry } from '../worker/syncLog.ts';
import type { DeadJob } from '../queue/postgresAdminData.ts';

const PASSWORD = 'correct-horse-battery';
const SHOP = 'demo-store.myshopify.com';
const SECRET = 'TOPSECRET-SALESFORCE-VALUE';

function build(over: Partial<AdminDeps> = {}) {
  const clock = { t: 1_000_000 };
  const connections = new MemoryConnectionStore();
  const configs = new Map<string, any>();
  const entries: LogEntry[] = [];
  const dead: DeadJob[] = [];
  const replays: (string[] | 'all')[] = [];
  const audit: { action: string; shop?: string; detail?: string }[] = [];
  const verifyResult: { v: { ok: true } | { ok: false; reason: string } } = { v: { ok: true } };
  const logCalls: { shop?: string; outcome?: string; limit?: number; offset?: number }[] = [];
  const deps: AdminDeps = {
    password: PASSWORD,
    sessionKey: deriveSessionKey(randomBytes(32)),
    now: () => clock.t,
    recipe: { id: R1_ID, name: 'Retail-to-B2B Lead Spotter', defaultConfig: R1_DEFAULT_CONFIG, validate: validateR1Config, toForm: configToForm, fromForm: formToConfig },
    connections,
    configs: {
      async get(shop, id) { return configs.get(`${shop}|${id}`) ?? null; },
      async set(shop, id, s) { configs.set(`${shop}|${id}`, { enabled: s.enabled, dryRun: s.dryRun !== false, config: validateR1Config(s.config) }); },
      async disable(shop, id) { const c = configs.get(`${shop}|${id}`); if (!c) return false; c.enabled = false; return true; },
    },
    syncLog: { async recent(f) { logCalls.push(f); let r = entries.filter((e) => (!f.shop || e.shop === f.shop) && (!f.outcome || e.outcome === f.outcome)); r = r.slice(f.offset ?? 0); return r.slice(0, f.limit ?? 50); } },
    async shops() { return [...new Set([...configs.keys()].map((k) => k.split('|')[0]))].sort(); },
    async verify() { return verifyResult.v; },
    dead: { async list() { return dead; }, async replay(ids) { replays.push(ids); return ids === 'all' ? dead.length : ids.length; } },
    audit: { async record(e) { audit.push(e); }, async recent(n) { return audit.slice(-n).map((a) => ({ at: 't', action: a.action, shop: a.shop ?? null, detail: a.detail ?? null })); } },
    compliance: { async recent() { return []; }, async get() { return null; } },
    ...over,
  };
  return { deps, clock, connections, configs, entries, dead, replays, audit, verifyResult, logCalls };
}

async function serve(b: ReturnType<typeof build>) {
  const handler = createAdminHandler(b.deps);
  const server = createServer((req, res) => { if (!handler(req, res)) res.writeHead(418).end('not-admin'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

async function withAdmin(fn: (c: { b: ReturnType<typeof build>; base: string; req: ReturnType<typeof client> }) => Promise<void>, over: Partial<AdminDeps> = {}) {
  const b = build(over);
  const s = await serve(b);
  try {
    await fn({ b, base: s.base, req: client(s.base) });
  } finally {
    await s.close();
  }
}

// A tiny browser: keeps one cookie, never follows redirects, and can read the CSRF token off any page.
function client(base: string) {
  let cookie = '';
  const api = {
    get cookie() { return cookie; },
    set cookie(v: string) { cookie = v; },
    async get(path: string, headers: Record<string, string> = {}) {
      const r = await fetch(base + path, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
      return { status: r.status, headers: r.headers, text: await r.text() };
    },
    async post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}, rawBody?: string) {
      const body = rawBody ?? new URLSearchParams(fields).toString();
      const r = await fetch(base + path, { method: 'POST', redirect: 'manual', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers } });
      return { status: r.status, headers: r.headers, text: await r.text() };
    },
    async login(password = PASSWORD, headers: Record<string, string> = {}) {
      const r = await api.post('/admin/login', { password }, headers);
      const sc = r.headers.get('set-cookie');
      if (r.status === 303 && sc) cookie = sc.split(';')[0];
      return r;
    },
    async csrf(path = '/admin') {
      const r = await api.get(path);
      const m = /name="csrf" value="([^"]+)"/.exec(r.text);
      assert.ok(m, `no csrf token on ${path} (status ${r.status})`);
      return m![1];
    },
  };
  return api;
}

// Sends the path EXACTLY as given (fetch would normalise ".." away before it reached the server).
function rawGet(base: string, path: string, cookie = ''): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET', headers: cookie ? { cookie } : {} }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    r.on('error', reject);
    r.end();
  });
}

const HEADER_KEYS = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'cache-control'];

// ---------------------------------------------------------------------------------------------------------
test('without a session every route redirects to the login page and reveals nothing; no state changes', async () => {
  await withAdmin(async ({ b, req }) => {
    b.configs.set(`${SHOP}|${R1_ID}`, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    b.entries.push({ at: 'x', shop: SHOP, recipeId: R1_ID, topic: 't', objectId: 'SECRET-ORDER', webhookId: 'w', outcome: 'created', dryRun: false });
    for (const path of ['/admin', '/admin/replay', `/admin/shops/${SHOP}`, `/admin/shops/${SHOP}/log`, '/admin/nope']) {
      const r = await req.get(path);
      assert.equal(r.status, 303, path);
      assert.equal(r.headers.get('location'), '/admin/login');
      assert.ok(!r.text.includes(SHOP) && !r.text.includes('SECRET-ORDER'));
    }
    for (const [path, fields] of [[`/admin/shops/${SHOP}/recipe`, { action: 'disable' }], ['/admin/shops', { shop: 'new.myshopify.com' }], ['/admin/replay', { id: 'all' }], ['/admin/logout', {}]] as const) {
      const r = await req.post(path, { ...fields });
      assert.equal(r.status, 303, path);
    }
    assert.equal(b.configs.get(`${SHOP}|${R1_ID}`).enabled, true, 'the kill switch was NOT triggered by an unauthenticated request');
    assert.equal(b.configs.has('new.myshopify.com|' + R1_ID), false);
    assert.equal(b.replays.length, 0);
  });
});

test('security headers are on every response: login, redirects, errors, authenticated pages', async () => {
  await withAdmin(async ({ req }) => {
    const responses = [await req.get('/admin/login'), await req.get('/admin'), await req.post('/admin/login', { password: 'wrong' }), await req.login(), await req.get('/admin'), await req.get('/admin/nope'), await req.get('/admin/replay')];
    for (const r of responses) for (const h of HEADER_KEYS) assert.ok(r.headers.get(h), `${h} on ${r.status}`);
    assert.equal(responses[0].headers.get('x-frame-options'), 'DENY');
    assert.ok(responses[0].headers.get('content-security-policy')!.includes("default-src 'none'"));
  });
});

test('login: wrong password -> 401, no cookie, the password is not echoed; right password -> session cookie with safe flags', async () => {
  await withAdmin(async ({ req }) => {
    const bad = await req.post('/admin/login', { password: 'Wr0ng-Guess-Value' });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);
    assert.ok(!bad.text.includes('Wr0ng-Guess-Value'));
    const good = await req.login();
    assert.equal(good.status, 303);
    assert.equal(good.headers.get('location'), '/admin');
    const c = good.headers.get('set-cookie')!;
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/admin', 'Max-Age=28800']) assert.ok(c.includes(flag), flag);
    assert.ok(!c.includes('Secure'), 'plain http locally');
    assert.equal((await req.get('/admin')).status, 200);
  });
});

test('the session cookie is Secure behind a TRUSTED https proxy; the header is ignored when no proxy is trusted', async () => {
  await withAdmin(async ({ req }) => {
    const r = await req.login(PASSWORD, { 'X-Forwarded-Proto': 'https' });
    assert.ok(r.headers.get('set-cookie')!.endsWith('; Secure'));
  }, { trustProxy: true });
  await withAdmin(async ({ req }) => {
    const r = await req.login(PASSWORD, { 'X-Forwarded-Proto': 'https' });
    assert.ok(!r.headers.get('set-cookie')!.includes('Secure'), 'a client-supplied header must not be believed');
  });
});

test('behind a trusted proxy the login limiter counts the real client (last X-Forwarded-For entry), so one attacker cannot lock out the operator', async () => {
  await withAdmin(async ({ req }) => {
    const attacker = { 'X-Forwarded-For': '1.1.1.1, 9.9.9.9' }; // spoofed first entry is ignored; the proxy appended 9.9.9.9
    for (let i = 0; i < 5; i++) assert.equal((await req.post('/admin/login', { password: `bad${i}` }, attacker)).status, 401);
    assert.equal((await req.post('/admin/login', { password: 'bad' }, attacker)).status, 429, 'the attacker is blocked');
    assert.equal((await req.login(PASSWORD, { 'X-Forwarded-For': '8.8.8.8' })).status, 303, 'the operator on another address still gets in');
  }, { trustProxy: true });
  // X-Real-IP wins when the proxy sends it (Railway's documented client address)
  await withAdmin(async ({ req }) => {
    const a = { 'X-Real-IP': '2.2.2.2', 'X-Forwarded-For': '5.5.5.5' };
    for (let i = 0; i < 5; i++) await req.post('/admin/login', { password: `bad${i}` }, a);
    assert.equal((await req.post('/admin/login', { password: 'x' }, a)).status, 429);
    assert.equal((await req.login(PASSWORD, { 'X-Real-IP': '3.3.3.3', 'X-Forwarded-For': '5.5.5.5' })).status, 303, 'same forwarded entry, different real IP: not blocked');
  }, { trustProxy: true });
});

test('login rate limit: after 5 wrong passwords even the right one is refused (429) until the window passes', async () => {
  await withAdmin(async ({ b, req }) => {
    for (let i = 0; i < 5; i++) assert.equal((await req.post('/admin/login', { password: `bad${i}` })).status, 401);
    const blocked = await req.login(PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('set-cookie'), null);
    b.clock.t += 15 * 60 * 1000 + 1;
    assert.equal((await req.login(PASSWORD)).status, 303);
  });
});

test('sessions expire, and forged or tampered cookies are rejected', async () => {
  await withAdmin(async ({ b, req }) => {
    await req.login();
    assert.equal((await req.get('/admin')).status, 200);
    const good = req.cookie;
    for (const bad of [good.slice(0, -3) + 'AAA', 'bridge_admin=garbage', `bridge_admin=${Buffer.from('{"exp":9999999999999,"nonce":"x"}').toString('base64url')}.AAAA`]) {
      req.cookie = bad;
      assert.equal((await req.get('/admin')).status, 303, bad.slice(0, 30));
    }
    req.cookie = good;
    b.clock.t += 8 * 3600 * 1000 + 1;
    assert.equal((await req.get('/admin')).status, 303, 'expired');
  });
});

test('logout revokes the session on the server: the old cookie stops working even though it has not expired', async () => {
  await withAdmin(async ({ req }) => {
    await req.login();
    const old = req.cookie;
    const csrf = await req.csrf();
    const out = await req.post('/admin/logout', { csrf });
    assert.equal(out.status, 303);
    assert.ok(out.headers.get('set-cookie')!.includes('Max-Age=0'));
    req.cookie = old; // an attacker who copied the cookie earlier
    assert.equal((await req.get('/admin')).status, 303);
  });
});

test('CSRF: a POST without or with a wrong token is refused (403) and changes nothing', async () => {
  await withAdmin(async ({ b, req }) => {
    b.configs.set(`${SHOP}|${R1_ID}`, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await req.login();
    for (const fields of [{ action: 'disable' }, { action: 'disable', csrf: '' }, { action: 'disable', csrf: 'wrong-token' }]) {
      assert.equal((await req.post(`/admin/shops/${SHOP}/recipe`, fields)).status, 403);
    }
    assert.equal(b.configs.get(`${SHOP}|${R1_ID}`).enabled, true);
    const csrf = await req.csrf();
    assert.equal((await req.post(`/admin/shops/${SHOP}/recipe`, { action: 'disable', csrf })).status, 303);
    assert.equal(b.configs.get(`${SHOP}|${R1_ID}`).enabled, false);
  });
});

test('a token from another session does not work', async () => {
  await withAdmin(async ({ b, base, req }) => {
    b.configs.set(`${SHOP}|${R1_ID}`, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await req.login();
    const other = client(base);
    await other.login();
    const otherToken = await other.csrf();
    assert.equal((await req.post(`/admin/shops/${SHOP}/recipe`, { action: 'disable', csrf: otherToken })).status, 403);
  });
});

test('cross-site requests are refused by Origin / Referer even with a valid token', async () => {
  await withAdmin(async ({ b, req }) => {
    b.configs.set(`${SHOP}|${R1_ID}`, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await req.login();
    const csrf = await req.csrf();
    for (const h of [{ Origin: 'http://evil.example' }, { Referer: 'http://evil.example/page' }, { Origin: 'null' }]) {
      assert.equal((await req.post(`/admin/shops/${SHOP}/recipe`, { action: 'disable', csrf }, h)).status, 403, JSON.stringify(h));
    }
    assert.equal(b.configs.get(`${SHOP}|${R1_ID}`).enabled, true);
  });
});

test('login also refuses cross-site posts', async () => {
  await withAdmin(async ({ req }) => {
    assert.equal((await req.post('/admin/login', { password: PASSWORD }, { Origin: 'http://evil.example' })).status, 403);
  });
});

test('request hygiene: wrong content type 415, oversized body 413, duplicate fields 400, unknown and traversal paths 404', async () => {
  await withAdmin(async ({ base, req }) => {
    await req.login();
    const csrf = await req.csrf();
    assert.equal((await req.post('/admin/shops', {}, { 'Content-Type': 'application/json' }, '{"shop":"x.myshopify.com"}')).status, 415);
    assert.equal((await req.post('/admin/shops', {}, {}, `csrf=${csrf}&pad=${'x'.repeat(70_000)}`)).status, 413);
    assert.equal((await req.post('/admin/shops', {}, {}, `csrf=${csrf}&shop=a.myshopify.com&shop=b.myshopify.com`)).status, 400);
    assert.equal((await req.get('/admin/shops/not-a-shop')).status, 404);
    assert.equal((await req.get('/admin/shops/evil.com')).status, 404);
    for (const raw of ['/admin/shops/../../etc/passwd', '/admin/shops/%2e%2e/%2e%2e/etc', '/admin/../etc/passwd', '/admin/shops/x.myshopify.com/../../..', '/admin//shops']) {
      assert.equal(await rawGet(base, raw, req.cookie), 404, raw);
    }
  });
});

test('only /admin and /admin/* are handled; lookalike paths fall through to the rest of the app', async () => {
  const handler = createAdminHandler(build().deps);
  const fake = (url: string, method = 'GET') => ({ url, method, headers: {}, socket: {} } as any);
  for (const p of ['/administrator', '/admin-x', '/adminx/login', '/webhooks/shopify', '/', '/healthz', '/api/admin']) {
    assert.equal(handler(fake(p), { writeHead() { return this; }, end() {} } as any), false, p);
  }
});

test('methods other than GET and POST are 405', async () => {
  await withAdmin(async ({ base }) => {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const r = await fetch(`${base}/admin`, { method, redirect: 'manual' });
      assert.equal(r.status, 405, method);
    }
  });
});

// ---- escaping -----------------------------------------------------------------------------------------------
test('attacker-controlled text in the log, settings and shop pages is HTML-escaped', async () => {
  await withAdmin(async ({ b, req }) => {
    const evil = `<script>alert('x')</script>"><img src=x onerror=alert(1)>`;
    b.configs.set(`${SHOP}|${R1_ID}`, { enabled: true, dryRun: true, config: { ...R1_DEFAULT_CONFIG, leadSource: evil, companyOverride: evil, allowDomains: [] } });
    b.entries.push({ at: evil, shop: SHOP, recipeId: R1_ID, topic: evil, objectId: evil, webhookId: 'w', outcome: 'failed', dryRun: false, reason: evil, errorClass: evil, errorCode: evil, ops: [{ kind: evil, outcome: evil, sfId: evil }] });
    await req.login();
    for (const path of [`/admin/shops/${SHOP}`, `/admin/shops/${SHOP}/log`, `/admin/shops/${SHOP}/log?outcome=failed`]) {
      const r = await req.get(path);
      assert.equal(r.status, 200, path);
      assert.ok(!r.text.includes('<script>alert'), `raw script on ${path}`);
      assert.ok(!r.text.includes('<img src=x'), `raw img on ${path}`);
      assert.ok(r.text.includes('&lt;script&gt;'), `escaped text expected on ${path}`);
    }
  });
});

test('the failed-jobs and dashboard pages escape their data too', async () => {
  await withAdmin(async ({ b, req }) => {
    b.dead.push({ id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), shop: '<b>x</b>', topic: '"><script>1</script>', webhookId: 'w', businessKey: '<i>k</i>', deadAt: '<u>t</u>' });
    b.audit.push({ action: '<script>a</script>', shop: '<s>', detail: '"><x>' });
    await req.login();
    for (const path of ['/admin/replay', '/admin']) {
      const r = await req.get(path);
      assert.ok(!/<script>\d?a?<\/script>|<b>x<\/b>|<i>k<\/i>|<u>t<\/u>/.test(r.text), path);
      assert.ok(r.text.includes('&lt;'), path);
    }
  });
});

test('flash messages come from a fixed list: arbitrary text in ?msg= is never reflected', async () => {
  await withAdmin(async ({ b, req }) => {
    b.configs.set(`${SHOP}|${R1_ID}`, { enabled: false, dryRun: true, config: R1_DEFAULT_CONFIG });
    await req.login();
    for (const path of ['/admin', `/admin/shops/${SHOP}`, '/admin/replay']) {
      const r = await req.get(`${path}?msg=<script>alert(1)</script>`);
      assert.ok(!r.text.includes('alert(1)'), path);
    }
    assert.ok((await req.get(`/admin/shops/${SHOP}?msg=disabled`)).text.includes('Recipe disabled'));
  });
});

// ---- secrets and the connection -----------------------------------------------------------------------------
test('the Salesforce secret is stored but NEVER rendered back, not even in an error page', async () => {
  await withAdmin(async ({ b, req }) => {
    await req.login();
    const csrf = await req.csrf();
    const ok = await req.post(`/admin/shops/${SHOP}/connection`, { csrf, loginUrl: 'https://org.my.salesforce.com', clientId: 'cid-123', clientSecret: SECRET });
    assert.equal(ok.status, 303);
    assert.equal((await b.connections.get(SHOP))!.clientSecret, SECRET);
    const page = await req.get(`/admin/shops/${SHOP}`);
    assert.ok(!page.text.includes(SECRET));
    assert.ok(page.text.includes('stored (encrypted)') && page.text.includes('cid-123'));
    const bad = await req.post(`/admin/shops/${SHOP}/connection`, { csrf, loginUrl: 'http://evil.example', clientId: 'cid', clientSecret: SECRET });
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes(SECRET));
    assert.ok(bad.text.includes('https'));
    for (const a of b.audit) assert.ok(!JSON.stringify(a).includes(SECRET));
  });
});

test('connection input is validated: bad URL, missing id or secret store nothing', async () => {
  await withAdmin(async ({ b, req }) => {
    await req.login();
    const csrf = await req.csrf();
    for (const fields of [{ loginUrl: 'ftp://x', clientId: 'c', clientSecret: 's' }, { loginUrl: 'https://u:p@org.my.salesforce.com', clientId: 'c', clientSecret: 's' }, { loginUrl: 'https://org.my.salesforce.com', clientId: '', clientSecret: 's' }, { loginUrl: 'https://org.my.salesforce.com', clientId: 'c', clientSecret: '' }]) {
      assert.equal((await req.post(`/admin/shops/${SHOP}/connection`, { csrf, ...fields })).status, 400, JSON.stringify(fields).slice(0, 40));
    }
    assert.equal(await b.connections.get(SHOP), null);
  });
});

test('"Test connection": success is recorded and audited; failure shows only a class and code', async () => {
  await withAdmin(async ({ b, req }) => {
    await b.connections.put(SHOP, { loginUrl: 'https://org.my.salesforce.com', clientId: 'c', clientSecret: SECRET });
    await req.login();
    const csrf = await req.csrf();
    assert.equal((await req.post(`/admin/shops/${SHOP}/verify`, { csrf })).headers.get('location'), `/admin/shops/${SHOP}?msg=verified_ok`);
    b.verifyResult.v = { ok: false, reason: 'auth:invalid_client' };
    const bad = await req.post(`/admin/shops/${SHOP}/verify`, { csrf });
    assert.equal(bad.status, 200);
    assert.ok(bad.text.includes('auth:invalid_client'));
    assert.ok(!bad.text.includes(SECRET));
    assert.deepEqual(b.audit.map((a) => a.action).filter((a) => a.startsWith('connection_')), ['connection_verified', 'connection_failed']);
  });
});

// ---- recipe control -----------------------------------------------------------------------------------------
test('going live needs the exact word LIVE and a stored connection; enabling is always dry-run; disabling is the kill switch', async () => {
  await withAdmin(async ({ b, req }) => {
    await req.login();
    const csrf = await req.csrf();
    const path = `/admin/shops/${SHOP}/recipe`;
    const state = () => b.configs.get(`${SHOP}|${R1_ID}`);
    assert.equal((await req.post(path, { csrf, action: 'enable_dry' })).status, 303);
    assert.deepEqual([state().enabled, state().dryRun], [true, true]);

    assert.equal((await req.post(path, { csrf, action: 'go_live', confirm: 'LIVE' })).status, 400, 'no connection yet');
    await b.connections.put(SHOP, { loginUrl: 'https://org.my.salesforce.com', clientId: 'c', clientSecret: 's' });
    for (const confirm of ['', 'live', 'Live', 'LIVE ', 'yes']) assert.equal((await req.post(path, { csrf, action: 'go_live', confirm })).status, 400, confirm);
    assert.equal(state().dryRun, true, 'still dry-run after the refused attempts');

    assert.equal((await req.post(path, { csrf, action: 'go_live', confirm: 'LIVE' })).status, 303);
    assert.deepEqual([state().enabled, state().dryRun], [true, false]);
    assert.equal((await req.post(path, { csrf, action: 'enable_dry' })).status, 303);
    assert.equal(state().dryRun, true, 'enabling again returns to dry-run');
    await req.post(path, { csrf, action: 'go_live', confirm: 'LIVE' });
    assert.equal((await req.post(path, { csrf, action: 'disable' })).status, 303);
    assert.equal(state().enabled, false);
    assert.equal((await req.post(path, { csrf, action: 'explode' })).status, 400);
    assert.deepEqual(b.audit.map((a) => a.action).filter((a) => a.startsWith('recipe_')), ['recipe_dry_run', 'recipe_live', 'recipe_dry_run', 'recipe_live', 'recipe_disabled']);
  });
});

test('adding a shop: valid names create a disabled, dry-run entry; anything else is refused', async () => {
  await withAdmin(async ({ b, req }) => {
    await req.login();
    const csrf = await req.csrf();
    const r = await req.post('/admin/shops', { csrf, shop: ' New-Store.myshopify.com ' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin/shops/new-store.myshopify.com?msg=shop_added');
    assert.deepEqual([b.configs.get(`new-store.myshopify.com|${R1_ID}`).enabled, b.configs.get(`new-store.myshopify.com|${R1_ID}`).dryRun], [false, true]);
    for (const bad of ['evil.com', '<script>.myshopify.com', 'a b.myshopify.com', '', 'x.myshopify.com.evil.io', "a'--.myshopify.com"]) {
      assert.equal((await req.post('/admin/shops', { csrf, shop: bad })).status, 400, bad);
    }
    assert.equal(b.configs.size, 1);
  });
});

test('saving settings: valid values are stored and the mode is preserved; invalid values store nothing and show every problem', async () => {
  await withAdmin(async ({ b, req }) => {
    b.configs.set(`${SHOP}|${R1_ID}`, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await req.login();
    const csrf = await req.csrf();
    const path = `/admin/shops/${SHOP}/config`;
    const valid = { csrf, leadSource: 'Web', minOrderTotal: '25', requireConsent: 'on', existingLeadAction: 'skip', companyOverride: '', leadOwnerId: '005AAAAAAAAAAAA', allowDomains: 'acme.com\nbeta.io', denyDomains: '', freeEmailBlocklist: 'gmail.com' };
    assert.equal((await req.post(path, valid)).status, 303);
    const s = b.configs.get(`${SHOP}|${R1_ID}`);
    assert.deepEqual([s.enabled, s.dryRun], [true, false], 'the mode is untouched by a settings change');
    assert.deepEqual([s.config.leadSource, s.config.minOrderTotal, s.config.existingLeadAction, s.config.allowDomains], ['Web', 25, 'skip', ['acme.com', 'beta.io']]);

    const bad = await req.post(path, { ...valid, leadSource: '', minOrderTotal: '-5', leadOwnerId: 'nope', existingLeadAction: 'explode' });
    assert.equal(bad.status, 422);
    for (const problem of ['leadSource', 'minOrderTotal', 'leadOwnerId', 'existingLeadAction']) assert.ok(bad.text.includes(problem), problem);
    assert.equal(b.configs.get(`${SHOP}|${R1_ID}`).config.leadSource, 'Web', 'nothing was stored');
    assert.ok(bad.text.includes('value="nope"'), 'what you typed is shown back so you can fix it');
  });
});

test('an invalid-settings echo is escaped too', async () => {
  await withAdmin(async ({ req }) => {
    await req.login();
    const csrf = await req.csrf();
    const evil = `"><script>alert(1)</script>`;
    const r = await req.post(`/admin/shops/${SHOP}/config`, { csrf, leadSource: evil, minOrderTotal: '-1', requireConsent: 'on', existingLeadAction: 'update', companyOverride: evil, leadOwnerId: '', allowDomains: '', denyDomains: '', freeEmailBlocklist: '' });
    assert.equal(r.status, 422);
    assert.ok(!r.text.includes('<script>alert'));
  });
});

// ---- log viewer ----------------------------------------------------------------------------------------------
test('log viewer: filter by outcome, ignore unknown outcomes, paging with older/newer links, garbage page numbers are safe', async () => {
  await withAdmin(async ({ b, req }) => {
    for (let i = 0; i < 120; i++) b.entries.push({ at: `2026-10-21T10:${String(i % 60).padStart(2, '0')}:00Z`, shop: SHOP, recipeId: R1_ID, topic: 'orders/paid', objectId: `order-${i}`, webhookId: `w${i}`, outcome: i % 4 === 0 ? 'failed' : 'created', dryRun: false });
    await req.login();
    const p1 = await req.get(`/admin/shops/${SHOP}/log`);
    assert.equal((p1.text.match(/<tr><td class="mut">/g) ?? []).length, 50);
    assert.ok(p1.text.includes('page=2') && !p1.text.includes('newer'));
    const p3 = await req.get(`/admin/shops/${SHOP}/log?page=3`);
    assert.equal((p3.text.match(/<tr><td class="mut">/g) ?? []).length, 20);
    assert.ok(!p3.text.includes('older') && p3.text.includes('newer'));
    const failed = await req.get(`/admin/shops/${SHOP}/log?outcome=failed`);
    assert.equal((failed.text.match(/<tr><td class="mut">/g) ?? []).length, 30);
    const unknown = await req.get(`/admin/shops/${SHOP}/log?outcome=${encodeURIComponent("x'; DROP TABLE sync_log;--")}`);
    assert.equal((unknown.text.match(/<tr><td class="mut">/g) ?? []).length, 50, 'unknown outcome is ignored, not used');
    for (const q of ['?page=abc', '?page=-5', '?page=0', '?page=99999999999999999999']) assert.equal((await req.get(`/admin/shops/${SHOP}/log${q}`)).status, 200, q);
    assert.ok(!/<th>[^<]*payload/i.test(p1.text), 'the log page has no payload column');
  });
});

// ---- replay --------------------------------------------------------------------------------------------------
test('failed jobs: listed without payload; replay needs CSRF and a valid id; "all" replays everything', async () => {
  await withAdmin(async ({ b, req }) => {
    const id = '11111111-1111-4111-8111-111111111111';
    b.dead.push({ id, shop: SHOP, topic: 'orders/paid', webhookId: 'w1', businessKey: 'orders/paid|s|1', deadAt: '2026-10-21T10:00:00Z' });
    await req.login();
    const page = await req.get('/admin/replay');
    assert.ok(page.text.includes('orders/paid|s|1') && page.text.includes(id));
    assert.ok(!/<th>[^<]*(payload|email|customer)/i.test(page.text), 'no payload or customer column');
    assert.equal((await req.post('/admin/replay', { id })).status, 403, 'no token');
    assert.equal(b.replays.length, 0);
    const csrf = await req.csrf('/admin/replay');
    assert.equal((await req.post('/admin/replay', { csrf, id: 'not-a-job-id' })).status, 400);
    assert.equal((await req.post('/admin/replay', { csrf, id: "1; DROP TABLE job" })).status, 400);
    assert.equal((await req.post('/admin/replay', { csrf, id })).headers.get('location'), '/admin/replay?msg=replayed');
    assert.equal((await req.post('/admin/replay', { csrf, id: 'all' })).status, 303);
    assert.deepEqual(b.replays, [[id], 'all']);
    assert.deepEqual(b.audit.filter((a) => a.action === 'replay').map((a) => a.detail), ['jobs=1', 'jobs=1']);
  });
});

test('replay with nothing to move says so', async () => {
  await withAdmin(async ({ req }) => {
    await req.login();
    const csrf = await req.csrf('/admin/replay');
    assert.equal((await req.post('/admin/replay', { csrf, id: 'all' })).headers.get('location'), '/admin/replay?msg=nothing_to_replay');
  });
});

// ---- misc ----------------------------------------------------------------------------------------------------
test('an unexpected error shows a generic page and never leaks the cause', async () => {
  const lines: string[] = [];
  await withAdmin(async ({ req }) => {
    await req.login();
    const r = await req.get('/admin');
    assert.equal(r.status, 500);
    assert.ok(r.text.includes('Something went wrong'));
    assert.ok(!r.text.includes('database exploded') && !r.text.includes('password=hunter2'));
    assert.ok(lines.some((l) => l.includes('admin_error')) && !lines.join('').includes('hunter2'));
  }, { async shops() { throw new Error('database exploded password=hunter2'); }, log: (_l, e) => void lines.push(e) });
});

test('the dashboard lists shops with their connection and mode', async () => {
  await withAdmin(async ({ b, req }) => {
    b.configs.set(`a.myshopify.com|${R1_ID}`, { enabled: true, dryRun: true, config: R1_DEFAULT_CONFIG });
    b.configs.set(`b.myshopify.com|${R1_ID}`, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    b.configs.set(`c.myshopify.com|${R1_ID}`, { enabled: false, dryRun: true, config: R1_DEFAULT_CONFIG });
    await b.connections.put('a.myshopify.com', { loginUrl: 'https://o', clientId: 'c', clientSecret: 's' });
    await req.login();
    const t = (await req.get('/admin')).text;
    for (const s of ['a.myshopify.com', 'b.myshopify.com', 'c.myshopify.com']) assert.ok(t.includes(s));
    assert.ok(t.includes('connected') && t.includes('no connection') && t.includes('dry-run') && t.includes('LIVE') && t.includes('disabled'));
  });
});

test('the admin UI uses the configured recipe wiring (smoke): r1Recipe id matches', () => {
  assert.equal(r1Recipe.id, R1_ID);
});


test('garbage page numbers reach the data layer as safe, bounded offsets', async () => {
  await withAdmin(async ({ b, req }) => {
    await req.login();
    for (const [q, offset] of [['?page=abc', 0], ['?page=-5', 0], ['?page=0', 0], ['?page=', 0], ['?page=3', 100], ['?page=99999999999999999999', 1999 * 50], ['?page=1e9', 0]] as const) {
      b.logCalls.length = 0;
      assert.equal((await req.get(`/admin/shops/${SHOP}/log${q}`)).status, 200, q);
      const call = b.logCalls.at(-1)!;
      assert.equal(call.offset, offset, q);
      assert.ok(Number.isInteger(call.offset) && call.offset! >= 0, q);
      assert.equal(call.limit, 51, 'one extra row is fetched to know whether there is a next page');
    }
  });
});

test('logins are audited, failed and successful, and the audit never holds the password', async () => {
  await withAdmin(async ({ b, req }) => {
    await req.post('/admin/login', { password: 'Wr0ng-Password-Guess' });
    await req.login();
    assert.deepEqual(b.audit.map((a) => a.action), ['login_failed', 'login_ok']);
    assert.ok(!JSON.stringify(b.audit).includes('Wr0ng-Password-Guess') && !JSON.stringify(b.audit).includes(PASSWORD));
  });
});

test('a failing audit write can NEVER block an action: the kill switch still works and the failure is logged', async () => {
  const logged: string[] = [];
  await withAdmin(async ({ b, req }) => {
    b.configs.set(`${SHOP}|${R1_ID}`, { enabled: true, dryRun: false, config: R1_DEFAULT_CONFIG });
    await req.login();
    const csrf = await req.csrf();
    const r = await req.post(`/admin/shops/${SHOP}/recipe`, { csrf, action: 'disable' });
    assert.equal(r.status, 303);
    assert.equal(b.configs.get(`${SHOP}|${R1_ID}`).enabled, false, 'disabled even though the audit store is down');
    assert.ok(logged.includes('admin_audit_failed'));
  }, { audit: { async record() { throw new Error('audit database down'); }, async recent() { return []; } }, log: (_l, e) => void logged.push(e) });
});

// ---- compliance pages ---------------------------------------------------------------------------------------
const complianceEntry = (over: Record<string, unknown> = {}) => ({ id: 7, at: '2026-10-21T12:00:00.000Z', kind: 'customers/redact', shop: SHOP, requestRef: 'wh-1', detail: { orders: 2, deleted: { syncLog: 2 }, salesforceRecordsToReview: ['Lead:00Q111', 'Task:00T222'], note: 'n' }, ...over });

test('compliance pages need a session; the list and the detail show the records to review', async () => {
  const compliance = { async recent() { return [complianceEntry()]; }, async get(id: number) { return id === 7 ? complianceEntry() : null; } };
  await withAdmin(async ({ req }) => {
    assert.equal((await req.get('/admin/compliance')).status, 303);
    assert.equal((await req.get('/admin/compliance/7')).status, 303);
    await req.login();
    const list = await req.get('/admin/compliance');
    assert.equal(list.status, 200);
    assert.ok(list.text.includes('Customer data deleted') && list.text.includes('wh-1') && list.text.includes('/admin/compliance/7'));
    assert.ok(list.text.includes('href="/admin/compliance"'), 'the menu links to it');
    const detail = await req.get('/admin/compliance/7');
    assert.equal(detail.status, 200);
    assert.ok(detail.text.includes('Lead:00Q111') && detail.text.includes('Task:00T222') && detail.text.includes('cannot delete in Salesforce'));
    assert.equal((await req.get('/admin/compliance/8')).status, 404);
    for (const bad of ['/admin/compliance/abc', '/admin/compliance/-1', '/admin/compliance/1;DROP', '/admin/compliance/7/extra', '/admin/compliance/99999999999999']) assert.equal((await req.get(bad)).status, 404, bad);
  }, { compliance });
});

test('compliance pages escape everything', async () => {
  const evil = `<script>alert(1)</script>"><img src=x onerror=alert(1)>`;
  const compliance = { async recent() { return [complianceEntry({ kind: evil, shop: evil, requestRef: evil })]; }, async get() { return complianceEntry({ kind: evil, shop: evil, requestRef: evil, detail: { salesforceRecordsToReview: [evil], note: evil } }); } };
  await withAdmin(async ({ req }) => {
    await req.login();
    for (const path of ['/admin/compliance', '/admin/compliance/7']) {
      const t = (await req.get(path)).text;
      assert.ok(!t.includes('<script>alert') && !t.includes('<img src=x'), path);
      assert.ok(t.includes('&lt;script&gt;'), path);
    }
  }, { compliance });
});

test('browser compatibility: the admin lets browsers send their real Origin (same-origin policy), and a null or foreign Origin is still refused', async () => {
  await withAdmin(async ({ req, base }) => {
    const r = await req.get('/admin/login');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin', 'no-referrer would make browsers post forms with Origin: null');
    const host = new URL(base).host;
    assert.equal((await req.post('/admin/login', { password: 'wrong' }, { Origin: `http://${host}`, Referer: `http://${host}/admin/login` })).status, 401, 'a real browser sign-in reaches the password check');
    for (const origin of ['null', 'http://evil.example', `http://${host}.evil.example`]) {
      assert.equal((await req.post('/admin/login', { password: 'wrong' }, { Origin: origin })).status, 403, origin);
    }
  });
});

test('the log shows each decision\'s Shopify webhook id (an opaque delivery id), escaped, so a decision can be tied to its delivery', async () => {
  await withAdmin(async ({ b, req }) => {
    b.entries.push({ at: '2026-10-26T11:04:43.489Z', shop: SHOP, recipeId: R1_ID, topic: 'orders/paid', objectId: 'order-1', webhookId: '19ec8866-1042-57b7-a839-42d329414940', outcome: 'dry_run', dryRun: true });
    b.entries.push({ at: '2026-10-26T11:05:00.000Z', shop: SHOP, recipeId: R1_ID, topic: 'orders/paid', objectId: 'order-2', webhookId: '<script>alert(1)</script>', outcome: 'created', dryRun: false });
    await req.login();
    for (const path of [`/admin/shops/${SHOP}/log`, `/admin/shops/${SHOP}`]) {
      const t = (await req.get(path)).text;
      assert.ok(t.includes('Webhook id'), path);
      assert.ok(t.includes('<code>19ec8866-1042-57b7-a839-42d329414940</code>'), path);
      assert.ok(!t.includes('<script>alert(1)</script>') && t.includes('&lt;script&gt;'), `${path}: a hostile id must be escaped`);
    }
  });
});

test('reading the decision log or the privacy records is audited; other pages and refused requests are not', async () => {
  const compliance = { async recent() { return [complianceEntry()]; }, async get(id: number) { return id === 7 ? complianceEntry() : null; } };
  await withAdmin(async ({ b, req }) => {
    await req.get(`/admin/shops/${SHOP}/log`);
    assert.deepEqual(b.audit, [], 'not logged in: nothing recorded');
    await req.login();
    const base = b.audit.length;
    await req.get('/admin');
    await req.get(`/admin/shops/${SHOP}`);
    assert.equal(b.audit.length, base, 'dashboard and shop pages show no customer-derived data');
    await req.get(`/admin/shops/${SHOP}/log`);
    await req.get('/admin/compliance');
    await req.get('/admin/compliance/7');
    await req.get('/admin/compliance/999');
    assert.deepEqual(b.audit.slice(base), [
      { action: 'viewed_log', shop: SHOP, detail: undefined },
      { action: 'viewed_privacy', shop: undefined, detail: undefined },
      { action: 'viewed_privacy', shop: SHOP, detail: undefined },
    ]);
  }, { compliance });
});
