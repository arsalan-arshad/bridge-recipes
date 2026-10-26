import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEmbeddedHandler, failedJobsFor } from './handler.ts';
import type { EmbeddedData } from './handler.ts';
import type { ActionDeps } from '../admin/actions.ts';
import { ConfigValidationError } from '../../recipes/retail-b2b-lead-spotter/validateConfig.ts';
import { MemoryConnectionStore } from '../salesforce/connectionStore.ts';
import type { RecipeSettings } from '../worker/recipe.ts';
import type { LogEntry } from '../worker/syncLog.ts';

const SECRET = 'test-client-secret';
const ID = 'client-id-1234';
const NOW = 1_800_000_000_000;
const S = NOW / 1000;
const SHOP = 'demo-shop.myshopify.com';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function token(over: Record<string, unknown> = {}, secret = SECRET): string {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: ID, sub: '42', exp: S + 60, nbf: S - 5, ...over });
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  at: '2026-10-26T11:04:43.489Z', shop: SHOP, objectId: 'gid://shopify/Order/1', webhookId: 'wh-1', outcome: 'dry_run', dryRun: true,
  reason: undefined, ops: [{ kind: 'createLead', outcome: 'planned' }], ...over,
} as LogEntry);

function fakeData(over: Partial<EmbeddedData> = {}) {
  const calls: string[] = [];
  const data: EmbeddedData = {
    summary: async (shop) => { calls.push(`summary ${shop}`); return { connection: { stored: true, lastVerifiedAt: '2026-10-26T10:00:00Z' }, recipe: { name: 'R1', configured: true, enabled: true, dryRun: true } }; },
    recent: async (f) => { calls.push(`recent ${JSON.stringify(f)}`); return [entry()]; },
    failedJobs: async (shop) => { calls.push(`failed ${shop}`); return 0; },
    ...over,
  };
  return { data, calls };
}

// The shared write actions over in-memory stores, plus a record of every audit entry.
function fakeWrites(opts: { verify?: ActionDeps['verify']; auditFails?: boolean } = {}) {
  const settings = new Map<string, RecipeSettings>();
  const connections = new MemoryConnectionStore();
  const audits: { action: string; shop?: string; detail?: string }[] = [];
  const actions: ActionDeps = {
    recipe: {
      id: 'R', defaultConfig: { minOrderTotal: 0 },
      validate: (c: any) => { if (c.bad) throw new ConfigValidationError(['bad']); return c; },
      fromForm: (f) => ({ bad: false, minOrderTotal: f.get('minOrderTotal') }),
    },
    connections: { get: (s) => connections.get(s), put: (s, c) => connections.put(s, c), markVerified: (s, at) => connections.markVerified(s, at), info: async (s) => ({ stored: (await connections.get(s)) !== null }) } as any,
    configs: {
      get: async (s, r) => settings.get(`${s}|${r}`) ?? null,
      set: async (s, r, v) => { settings.set(`${s}|${r}`, { enabled: v.enabled, dryRun: v.dryRun ?? true, config: v.config }); },
      disable: async (s, r) => { const c = settings.get(`${s}|${r}`); if (!c) return false; settings.set(`${s}|${r}`, { ...c, enabled: false }); return true; },
    },
    verify: opts.verify ?? (async () => ({ ok: true })),
  };
  const audit = { record: async (e: { action: string; shop?: string; detail?: string }) => { if (opts.auditFails) throw new Error('audit down'); audits.push(e); } };
  return { actions, audit, settings, connections, audits };
}

async function withServer(fn: (url: string, logs: string[], calls: string[], w: ReturnType<typeof fakeWrites>) => Promise<void>, opts: { known?: (s: string) => Promise<boolean>; data?: Partial<EmbeddedData>; writes?: Parameters<typeof fakeWrites>[0] } = {}) {
  const logs: string[] = [];
  const w = fakeWrites(opts.writes);
  const { data, calls } = fakeData(opts.data);
  const handle = createEmbeddedHandler({
    clientId: ID, clientSecret: SECRET, now: () => NOW, data, actions: w.actions, audit: w.audit,
    knownShop: opts.known ?? (async (s) => s === SHOP),
    log: (_l, event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
  });
  const server = createServer((req, res) => {
    if (!handle(req, res)) res.writeHead(418).end('not ours');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs, calls, w);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

test('the shell names the shop in frame-ancestors, loads Shopify scripts, is not blocked from framing, and carries no data', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/app?shop=${SHOP}&host=abc&embedded=1`);
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-ancestors https:\/\/demo-shop\.myshopify\.com https:\/\/admin\.shopify\.com(;|$)/);
    assert.match(csp, /script-src 'self' https:\/\/cdn\.shopify\.com/);
    assert.ok(!csp.includes('unsafe-eval') && !/script-src[^;]*unsafe-inline/.test(csp), 'no inline or eval script');
    assert.equal(r.headers.get('x-frame-options'), null, 'X-Frame-Options would block the Shopify admin');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.ok(html.includes(`<meta name="shopify-api-key" content="${ID}">`));
    // every script tag is an external one, and the list of sources is exactly Shopify's two scripts plus ours (no inline script)
    const scripts = html.split('<script').slice(1).map((part) => part.slice(0, part.indexOf('>')));
    assert.deepEqual(scripts, [
      ' src="https://cdn.shopify.com/shopifycloud/app-bridge.js"',
      ' src="https://cdn.shopify.com/shopifycloud/polaris.js"',
      ' src="/app/assets/app.js"',
    ]);
    assert.equal(html.split('</script>').length - 1, scripts.length, 'no script has a body');
    assert.equal(html.split(SHOP).length, 1, 'the shell echoes no shop name from the request');
    assert.equal(html.split('host=abc').length, 1, 'the shell echoes no query value from the request');
  });
});

test('the shop parameter reaches a response header, so only a plain myshopify.com host is accepted', async () => {
  await withServer(async (url) => {
    for (const bad of ['', 'evil.example.com', `${SHOP}.evil.io`, `${SHOP};frame-ancestors *`, `${SHOP} https://evil.io`, 'a.myshopify.com%0d%0aX-Evil: 1', '-bad.myshopify.com', 'https://demo-shop.myshopify.com']) {
      const r = await fetch(`${url}/app?shop=${bad}`);
      assert.equal(r.status, 400, bad);
      assert.equal(r.headers.get('content-security-policy'), null, bad);
      assert.equal(r.headers.get('x-evil'), null, bad);
    }
    assert.equal((await fetch(`${url}/app`)).status, 400);
    assert.equal((await fetch(`${url}/app?shop=DEMO-SHOP.myshopify.com`)).status, 200, 'host names are case-insensitive');
  });
});

test('the browser script is served as JavaScript with nosniff', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/app/assets/app.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const js = await r.text();
    assert.ok(js.includes('idToken') && js.includes('Authorization'));
  });
});

test('the API needs a valid token: missing, malformed, forged, expired and wrong-app tokens get 401 with the retry header', async () => {
  await withServer(async (url, logs) => {
    const bad: Record<string, string>[] = [
      {}, { Authorization: 'Bearer' }, { Authorization: 'Basic abc' }, { Authorization: `Basic ${token()}` }, { Authorization: `bearer ${token()}` }, { Authorization: `Bearer ${token()} extra` }, { Authorization: 'Bearer not.a.jwt!' },
      bearer(token({}, 'other-secret')), bearer(token({ exp: S - 60 })), bearer(token({ aud: 'other-app' })), bearer(token({ dest: 'https://evil.example.com' })),
    ];
    for (const h of bad) {
      const r = await fetch(`${url}/app/api/home`, { headers: h });
      assert.equal(r.status, 401, JSON.stringify(h).slice(0, 40));
      assert.equal(r.headers.get('x-shopify-retry-invalid-session-request'), '1');
      assert.equal(await r.text(), 'unauthorized', 'no detail in the body');
    }
    assert.ok(logs.length >= 11 && logs.every((l) => /^embedded_token_refused \{"reason":"[a-z_]+"\}$/.test(l)), 'only the fixed refusal reason is logged, never the header or token');
    assert.ok(!logs.join('\n').includes(SECRET));
  });
});

test('a valid token for a known shop gets the fragment naming the shop, and no cookie is set', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/app/api/home`, { headers: bearer(token()) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(r.headers.get('set-cookie'), null);
    const html = await r.text();
    assert.ok(html.includes('<s-page heading="Bridge Recipes">') && html.includes('DRY-RUN'));
  });
});

test('the pages are built for the shop in the TOKEN: a shop in the query string is ignored', async () => {
  await withServer(async (url, _logs, calls) => {
    for (const path of ['/app/api/home?shop=other-shop.myshopify.com', '/app/api/log?shop=other-shop.myshopify.com&outcome=failed']) {
      const r = await fetch(`${url}${path}`, { headers: bearer(token()) });
      assert.equal(r.status, 200, path);
    }
    // every data call names the token's shop (shown here as <shop>) and no other shop
    const normalised = calls.map((c) => c.split(SHOP).join('<shop>'));
    assert.ok(normalised.length >= 4, normalised.join(' | '));
    assert.ok(normalised.every((c) => /<shop>/.test(c) && !/myshopify|other-shop/.test(c)), normalised.join(' | '));
  });
});

test('log: outcome and page come from a fixed list and bounds; anything else means all / page 1', async () => {
  await withServer(async (url, _logs, calls) => {
    const get = (q: string) => fetch(`${url}/app/api/log${q}`, { headers: bearer(token()) });
    await get('?outcome=failed&page=3');
    await get("?outcome='%20OR%201=1&page=abc");
    await get('?outcome=failed&page=-1');
    await get('?page=999999');
    await get('?page=2.5');
    const recents = calls.filter((c) => c.startsWith('recent ')).map((c) => JSON.parse(c.slice(7)));
    assert.deepEqual(recents[0], { shop: SHOP, outcome: 'failed', limit: 51, offset: 100 });
    assert.deepEqual(recents[1], { shop: SHOP, limit: 51, offset: 0 }, 'an unknown outcome is not passed on');
    assert.deepEqual(recents[2], { shop: SHOP, outcome: 'failed', limit: 51, offset: 0 });
    assert.deepEqual(recents[3], { shop: SHOP, limit: 51, offset: 0 });
    assert.deepEqual(recents[4], { shop: SHOP, limit: 51, offset: 0 });
  });
});

test('log: paging shows Older only when there is another page, and never more than a page of rows', async () => {
  const many = Array.from({ length: 51 }, (_, i) => entry({ objectId: `gid://shopify/Order/${i}` }));
  await withServer(async (url) => {
    const html = await (await fetch(`${url}/app/api/log`, { headers: bearer(token()) })).text();
    assert.equal(html.split('<s-table-row>').length - 1, 50);
    assert.ok(html.includes('data-view="/app/api/log?page=2"'));
    assert.ok(!html.includes('Newer'));
  }, { data: { recent: async () => many } });
  await withServer(async (url) => {
    const html = await (await fetch(`${url}/app/api/log?page=2`, { headers: bearer(token()) })).text();
    assert.ok(html.includes('data-view="/app/api/log"') && html.includes('Newer') && !html.includes('Older'));
  }, { data: { recent: async () => [entry()] } });
});

test('a failing data read gives a bare 500 and logs only the route', async () => {
  await withServer(async (url, logs) => {
    const r = await fetch(`${url}/app/api/home`, { headers: bearer(token()) });
    assert.equal(r.status, 500);
    assert.equal(await r.text(), 'error');
    assert.deepEqual(logs, ['embedded_data_failed {"route":"home"}']);
  }, { data: { failedJobs: async () => { throw new Error('secret db detail'); } } });
});

test('a valid token for a shop we do not know gets 403 and the shop is logged, nothing else', async () => {
  await withServer(async (url, logs) => {
    const r = await fetch(`${url}/app/api/home`, { headers: bearer(token({ dest: 'https://other-shop.myshopify.com', iss: 'https://other-shop.myshopify.com/admin' })) });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('x-shopify-retry-invalid-session-request'), null, 'a retry cannot fix this');
    assert.deepEqual(logs, ['embedded_unknown_shop {"shop":"other-shop.myshopify.com"}']);
  });
});

test('if the shop lookup fails the answer is 503, not an open door', async () => {
  await withServer(async (url, logs) => {
    const r = await fetch(`${url}/app/api/home`, { headers: bearer(token()) });
    assert.equal(r.status, 503);
    assert.deepEqual(logs, ['embedded_shop_lookup_failed {}']);
  }, { known: async () => { throw new Error('db down'); } });
});

test('only GET; unknown /app paths are 404; other paths are left to the rest of the service', async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/app/api/home`, { method: 'POST', headers: bearer(token()) })).status, 405);
    assert.equal((await fetch(`${url}/app?shop=${SHOP}`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}/app/nothing`)).status, 404);
    assert.equal((await fetch(`${url}/app/api/other`, { headers: bearer(token()) })).status, 404);
    assert.equal((await fetch(`${url}/app/api/log`, { method: 'POST', headers: bearer(token()) })).status, 405);
    assert.equal((await fetch(`${url}/app/api/log`)).status, 401, 'the log needs a token too');
    assert.equal((await fetch(`${url}/application`)).status, 418, '/application is not /app');
    assert.equal((await fetch(`${url}/admin`)).status, 418);
    assert.equal((await fetch(`${url}/webhooks/shopify`, { method: 'POST' })).status, 418);
  });
});

test('failed jobs are counted per shop, never across shops', () => {
  const jobs = [{ shop: SHOP }, { shop: 'other-shop.myshopify.com' }, { shop: SHOP }, { shop: 'demo-shop.myshopify.com.evil.io' }];
  assert.equal(failedJobsFor(jobs, SHOP), 2);
  assert.equal(failedJobsFor(jobs, 'other-shop.myshopify.com'), 1);
  assert.equal(failedJobsFor(jobs, 'nobody.myshopify.com'), 0);
  assert.equal(failedJobsFor([], SHOP), 0);
});

// ---- the write routes -------------------------------------------------------------------------------------------------------------------
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const post = (url: string, path: string, body: Record<string, string>, headers: Record<string, string> = { ...bearer(token()), ...FORM }) =>
  fetch(`${url}${path}`, { method: 'POST', headers, body: new URLSearchParams(body).toString() });

test('setup page: needs a token, shows the connection and recipe controls', async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/app/api/setup`)).status, 401);
    const r = await fetch(`${url}/app/api/setup`, { headers: bearer(token()) });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('data-post="/app/api/connection"') && html.includes('data-post="/app/api/recipe"') && html.includes('DRY-RUN'));
  });
});

test('writes need the token, a form body, a small body, and the right method', async () => {
  await withServer(async (url, logs, _c, w) => {
    const body = { action: 'enable_dry' };
    for (const path of ['/app/api/connection', '/app/api/verify', '/app/api/recipe']) {
      assert.equal((await post(url, path, body, FORM)).status, 401, `${path} without a token`);
      assert.equal((await post(url, path, body, { ...bearer(token({}, 'other')), ...FORM })).status, 401, `${path} with a forged token`);
      assert.equal((await fetch(`${url}${path}`, { headers: bearer(token()) })).status, 405, `${path} by GET`);
      assert.equal((await fetch(`${url}${path}`, { method: 'PUT', headers: { ...bearer(token()), ...FORM }, body: '' })).status, 405, `${path} by PUT`);
    }
    assert.equal((await fetch(`${url}/app/api/recipe`, { method: 'POST', headers: { ...bearer(token()), 'Content-Type': 'application/json' }, body: '{"action":"enable_dry"}' })).status, 415);
    assert.equal((await fetch(`${url}/app/api/recipe`, { method: 'POST', headers: bearer(token()), body: 'action=enable_dry' })).status, 415, 'no content type');
    const big = await fetch(`${url}/app/api/recipe`, { method: 'POST', headers: { ...bearer(token()), ...FORM }, body: `action=enable_dry&pad=${'x'.repeat(70_000)}` });
    assert.equal(big.status, 413);
    assert.equal((await post(url, '/app/api/recipe', { action: 'enable_dry' }, { ...bearer(token()), ...FORM })).status, 200, 'and a good one still works');
    assert.equal(w.audits.length, 1, 'only the good one was recorded');
    assert.ok(!logs.join('\n').includes(SECRET));
  });
});

test('connection: stored for the TOKEN shop (a shop in the body is ignored), audited with the Shopify user, and the secret is never echoed, audited or logged', async () => {
  await withServer(async (url, logs, _c, w) => {
    const r = await post(url, '/app/api/connection', { loginUrl: 'https://acme.my.salesforce.com', clientId: 'KEY-1', clientSecret: 'TOP-SECRET-VALUE', shop: 'other-shop.myshopify.com' });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Salesforce connection saved') && html.includes('client id: KEY-1'));
    assert.ok(!html.includes('TOP-SECRET-VALUE'));
    assert.equal((await w.connections.get(SHOP))?.clientSecret, 'TOP-SECRET-VALUE');
    assert.equal(await w.connections.get('other-shop.myshopify.com'), null);
    assert.deepEqual(w.audits, [{ action: 'connection_saved', shop: SHOP, detail: 'user 42' }]);
    assert.ok(!JSON.stringify(w.audits).includes('TOP-SECRET-VALUE') && !logs.join('\n').includes('TOP-SECRET-VALUE'));
  }, { data: { summary: async (shop) => ({ connection: { stored: true, lastVerifiedAt: null, loginUrl: 'https://acme.my.salesforce.com', clientId: 'KEY-1' }, recipe: { name: 'R', configured: false, enabled: false, dryRun: true } }) } });
});

test('connection: a bad one is refused with the problem shown, nothing is stored or audited', async () => {
  await withServer(async (url, _l, _c, w) => {
    for (const bad of [{ loginUrl: 'https://evil.example.com', clientId: 'a', clientSecret: 'SECRET-B' }, { loginUrl: 'https://acme.my.salesforce.com', clientId: '', clientSecret: 'SECRET-B' }, {}]) {
      const r = await post(url, '/app/api/connection', bad);
      assert.equal(r.status, 400);
      const html = await r.text();
      assert.ok(html.includes('heading="Connection problem"') && !html.includes('SECRET-B'));
    }
    assert.equal(await w.connections.get(SHOP), null);
    assert.deepEqual(w.audits, []);
  });
});

test('go live: the exact word LIVE and a stored connection are both required; every step is audited with the user', async () => {
  await withServer(async (url, _l, _c, w) => {
    const go = (confirm: string) => post(url, '/app/api/recipe', { action: 'go_live', confirm });
    for (const c of ['', 'live', 'LIVE ', 'yes']) assert.equal((await go(c)).status, 400, JSON.stringify(c));
    const noConn = await go('LIVE');
    assert.equal(noConn.status, 400);
    assert.ok((await noConn.text()).includes('connect Salesforce first'));
    assert.equal(w.settings.size, 0, 'nothing written');
    assert.deepEqual(w.audits, []);
    await post(url, '/app/api/connection', { loginUrl: 'https://acme.my.salesforce.com', clientId: 'K', clientSecret: 'S' });
    const live = await go('LIVE');
    assert.equal(live.status, 200);
    assert.deepEqual(w.settings.get(`${SHOP}|R`), { enabled: true, dryRun: false, config: { minOrderTotal: 0 } });
    assert.deepEqual(w.audits.map((a) => [a.action, a.detail]), [['connection_saved', 'user 42'], ['recipe_live', 'user 42']]);
    await post(url, '/app/api/recipe', { action: 'disable' });
    assert.equal(w.settings.get(`${SHOP}|R`)?.enabled, false);
    await post(url, '/app/api/recipe', { action: 'enable_dry' });
    assert.deepEqual([w.settings.get(`${SHOP}|R`)?.enabled, w.settings.get(`${SHOP}|R`)?.dryRun], [true, true]);
    assert.deepEqual(w.audits.map((a) => a.action), ['connection_saved', 'recipe_live', 'recipe_disabled', 'recipe_dry_run']);
  });
});

test('an unknown action is refused with a fixed message and writes nothing', async () => {
  await withServer(async (url, _l, _c, w) => {
    for (const action of ['', 'go-live', 'delete', '<img src=x>']) {
      const r = await post(url, '/app/api/recipe', { action });
      assert.equal(r.status, 400);
      const html = await r.text();
      assert.ok(html.includes('That action is not recognised.') && !html.includes('<img'));
    }
    assert.equal(w.settings.size, 0);
    assert.deepEqual(w.audits, []);
  });
});

test('test connection: a failure shows its reason and is audited as failed, with the user', async () => {
  await withServer(async (url, _l, _c, w) => {
    const bad = await post(url, '/app/api/verify', {});
    assert.equal(bad.status, 200);
    assert.ok((await bad.text()).includes('Connection check failed: invalid_client'));
    assert.deepEqual(w.audits, [{ action: 'connection_failed', shop: SHOP, detail: 'invalid_client · user 42' }]);
  }, { writes: { verify: async () => ({ ok: false, reason: 'invalid_client' }) } });
  await withServer(async (url, _l, _c, w) => {
    assert.ok((await (await post(url, '/app/api/verify', {})).text()).includes('The Salesforce connection works.'));
    assert.deepEqual(w.audits, [{ action: 'connection_verified', shop: SHOP, detail: 'user 42' }]);
  });
});

test('a token without a user id is still audited (no user part); a failing audit does not undo the action but is logged', async () => {
  await withServer(async (url, _l, _c, w) => {
    const r = await post(url, '/app/api/recipe', { action: 'enable_dry' }, { ...bearer(token({ sub: undefined })), ...FORM });
    assert.equal(r.status, 200);
    assert.deepEqual(w.audits, [{ action: 'recipe_dry_run', shop: SHOP, detail: undefined }]);
  });
  await withServer(async (url, logs, _c, w) => {
    const r = await post(url, '/app/api/recipe', { action: 'enable_dry' });
    assert.equal(r.status, 200);
    assert.equal(w.settings.get(`${SHOP}|R`)?.enabled, true);
    assert.deepEqual(logs, ['embedded_audit_failed {"action":"recipe_dry_run"}']);
  }, { writes: { auditFails: true } });
});

test('writes for a shop the operator has not set up are 403 and change nothing', async () => {
  await withServer(async (url, logs, _c, w) => {
    const r = await post(url, '/app/api/recipe', { action: 'enable_dry' });
    assert.equal(r.status, 403);
    assert.equal(w.settings.size, 0);
    assert.deepEqual(w.audits, []);
    assert.deepEqual(logs, [`embedded_unknown_shop {"shop":"${SHOP}"}`]);
  }, { known: async () => false });
});

test('an oversized body with NO declared length (chunked) is refused at the cap, not read to the end', async () => {
  await withServer(async (url, _l, _c, w) => {
    const u = new globalThis.URL(url);
    const status = await new Promise<number | undefined>((resolve) => {
      const req = httpRequest({ host: u.hostname, port: u.port, path: '/app/api/recipe', method: 'POST', headers: { ...bearer(token()), ...FORM, 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(undefined));
      req.write('action=enable_dry&pad=');
      for (let i = 0; i < 80; i++) req.write(Buffer.alloc(1024, 120)); // 80 KB, over the 64 KB cap
      req.end();
    });
    assert.ok(status === 413 || status === undefined, `status ${status}`);
    assert.equal(w.settings.size, 0, 'nothing was done with the oversized body');
    assert.deepEqual(w.audits, []);
  });
});
