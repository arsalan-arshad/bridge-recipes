import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEmbeddedHandler, failedJobsFor, jobsFor, privacyEntryFor, privacyFor } from './handler.ts';
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
    jobs: async (shop) => { calls.push(`jobs ${shop}`); return []; },
    privacyList: async (shop) => { calls.push(`privacyList ${shop}`); return [{ id: 7, at: '2026-10-28T10:00:00Z', kind: 'shop/redact', requestRef: 'req-7', detail: { ordersRedacted: 4, salesforceRecordsToReview: ['00Qxx0000012345'] } }]; },
    privacyEntry: async (shop, id) => { calls.push(`privacyEntry ${shop} ${id}`); return id === 7 ? { id: 7, at: '2026-10-28T10:00:00Z', kind: 'shop/redact', requestRef: 'req-7', detail: { ordersRedacted: 4, salesforceRecordsToReview: ['00Qxx0000012345'] } } : null; },
    settingsForm: async (shop) => { calls.push(`settingsForm ${shop}`); return { leadSource: 'Stored', minOrderTotal: '5', requireConsent: true, existingLeadAction: 'update', companyOverride: '', leadOwnerId: '', allowDomains: '', denyDomains: '', freeEmailBlocklist: '' }; },
    ...over,
  };
  return { data, calls };
}

// The shared write actions over in-memory stores, plus a record of every audit entry.
function fakeWrites(opts: { verify?: ActionDeps['verify']; check?: ActionDeps['check']; auditFails?: boolean } = {}) {
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
    check: opts.check ?? (async () => ({ ok: true, checks: [{ id: 'lead', title: 'Leads: read, create and update', status: 'pass' }] })),
  };
  const audit = { record: async (e: { action: string; shop?: string; detail?: string }) => { if (opts.auditFails) throw new Error('audit down'); audits.push(e); } };
  return { actions, audit, settings, connections, audits };
}

const OWN_A = '11111111-1111-4111-8111-111111111111';
const OWN_B = '33333333-3333-4333-8333-333333333333';
const OTHER_JOB = '22222222-2222-4222-8222-222222222222';

async function withServer(fn: (url: string, logs: string[], calls: string[], w: ReturnType<typeof fakeWrites>, replays: string[][]) => Promise<void>, opts: { known?: (s: string) => Promise<boolean>; data?: Partial<EmbeddedData>; writes?: Parameters<typeof fakeWrites>[0]; dead?: { id: string; shop: string }[]; replayMoves?: number; goLive?: { minDryRun: number } | null } = {}) {
  const replays: string[][] = [];
  const logs: string[] = [];
  const w = fakeWrites(opts.writes);
  const { data, calls } = fakeData(opts.data);
  const handle = createEmbeddedHandler({
    clientId: ID, clientSecret: SECRET, now: () => NOW, data, actions: w.actions, audit: w.audit,
    dead: { list: async () => opts.dead ?? [{ id: OWN_A, shop: SHOP }, { id: OTHER_JOB, shop: 'other-shop.myshopify.com' }, { id: OWN_B, shop: SHOP }], replay: async (ids) => { replays.push(ids); return opts.replayMoves ?? ids.length; } },
    goLive: opts.goLive, knownShop: opts.known ?? (async (s) => s === SHOP),
    log: (_l, event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
  });
  const server = createServer((req, res) => {
    if (!handle(req, res)) res.writeHead(418).end('not ours');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs, calls, w, replays);
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
    assert.ok(html.includes('Salesforce connection saved') && html.includes('client id: ••••') && !html.includes('KEY-1'), 'the key is masked');
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

test('go live is NOT available from the embedded page: refused with 403 whatever is sent, nothing written or audited; the safe actions still work', async () => {
  await withServer(async (url, logs, _c, w) => {
    await post(url, '/app/api/connection', { loginUrl: 'https://acme.my.salesforce.com', clientId: 'K', clientSecret: 'S' });
    for (const body of [{ action: 'go_live', confirm: 'LIVE' }, { action: 'go_live' }, { action: 'go_live', confirm: 'live' }, { action: 'go_live', confirm: 'LIVE', extra: 'x' }]) {
      const r = await post(url, '/app/api/recipe', body);
      assert.equal(r.status, 403, JSON.stringify(body));
      const html = await r.text();
      assert.ok(html.includes('Going live is done from the operator admin page') && html.includes('heading="Not done"'));
    }
    assert.equal(w.settings.size, 0, 'a refused go-live writes nothing');
    assert.deepEqual(w.audits.map((a) => a.action), ['connection_saved'], 'and is not recorded as a change');
    assert.ok(logs.filter((l) => l.startsWith('embedded_go_live_refused')).length === 4);
    await post(url, '/app/api/recipe', { action: 'enable_dry' });
    assert.deepEqual([w.settings.get(`${SHOP}|R`)?.enabled, w.settings.get(`${SHOP}|R`)?.dryRun], [true, true]);
    await post(url, '/app/api/recipe', { action: 'disable' });
    assert.equal(w.settings.get(`${SHOP}|R`)?.enabled, false);
    assert.deepEqual(w.audits.map((a) => [a.action, a.detail]), [['connection_saved', 'user 42'], ['recipe_dry_run', 'user 42'], ['recipe_disabled', 'user 42']]);
  });
});

test('the kill switch and dry-run work on a recipe that is already LIVE (set from the operator page); the mode goes back to dry-run, never forward', async () => {
  await withServer(async (url, _l, _c, w) => {
    w.settings.set(`${SHOP}|R`, { enabled: true, dryRun: false, config: { minOrderTotal: 9 } });
    await post(url, '/app/api/recipe', { action: 'enable_dry' });
    assert.deepEqual(w.settings.get(`${SHOP}|R`), { enabled: true, dryRun: true, config: { minOrderTotal: 9 } });
    w.settings.set(`${SHOP}|R`, { enabled: true, dryRun: false, config: { minOrderTotal: 9 } });
    await post(url, '/app/api/recipe', { action: 'disable' });
    assert.deepEqual(w.settings.get(`${SHOP}|R`), { enabled: false, dryRun: false, config: { minOrderTotal: 9 } });
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

// ---- settings ----------------------------------------------------------------------------------------------------------------------------
test('settings page: needs a token and shows the stored values for the TOKEN shop', async () => {
  await withServer(async (url, _l, calls) => {
    assert.equal((await fetch(`${url}/app/api/settings`)).status, 401);
    const r = await fetch(`${url}/app/api/settings?shop=other-shop.myshopify.com`, { headers: bearer(token()) });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('value="Stored"') && html.includes('<form data-post="/app/api/settings">'));
    assert.deepEqual(calls.filter((c) => c.startsWith('settingsForm')), [`settingsForm ${SHOP}`]);
  });
});

test('settings: a valid save is stored for the token shop, audited with the user, and does not change the mode', async () => {
  await withServer(async (url, _l, _c, w) => {
    w.settings.set(`${SHOP}|R`, { enabled: true, dryRun: false, config: { minOrderTotal: '1' } });
    const r = await post(url, '/app/api/settings', { minOrderTotal: '75', shop: 'other-shop.myshopify.com' });
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('Settings saved.'));
    assert.deepEqual(w.settings.get(`${SHOP}|R`), { enabled: true, dryRun: false, config: { bad: false, minOrderTotal: '75' } }, 'the mode is untouched');
    assert.equal(w.settings.get('other-shop.myshopify.com|R'), undefined);
    assert.deepEqual(w.audits, [{ action: 'config_saved', shop: SHOP, detail: 'user 42' }]);
  });
});

test('settings: an invalid save is refused with 422, the problems and what was typed; nothing is stored or audited', async () => {
  await withServer(async (url, _l, _c, w) => {
    w.actions.recipe.validate = () => { throw new ConfigValidationError(['minimum must be a number']); };
    const r = await post(url, '/app/api/settings', { minOrderTotal: 'abc<img>', leadSource: 'Typed' });
    assert.equal(r.status, 422);
    const html = await r.text();
    assert.ok(html.includes('minimum must be a number'), 'the problem is shown');
    assert.ok(html.includes('value="abc&lt;img&gt;"'), 'what was typed is shown back, escaped');
    assert.ok(html.includes('value="Typed"') && !html.includes('<img'));
    assert.equal(w.settings.size, 0);
    assert.deepEqual(w.audits, []);
  });
});

test('settings: only GET and POST; the save needs the token, a form body and a small body', async () => {
  await withServer(async (url, _l, _c, w) => {
    const put = await fetch(`${url}/app/api/settings`, { method: 'PUT', headers: { ...bearer(token()), ...FORM }, body: '' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, POST');
    assert.equal((await post(url, '/app/api/settings', { minOrderTotal: '1' }, FORM)).status, 401);
    assert.equal((await fetch(`${url}/app/api/settings`, { method: 'POST', headers: { ...bearer(token()), 'Content-Type': 'application/json' }, body: '{}' })).status, 415);
    assert.equal((await post(url, '/app/api/settings', { pad: 'x'.repeat(70_000) })).status, 413);
    assert.equal(w.settings.size, 0);
    assert.equal((await fetch(`${url}/app/api/log`, { method: 'POST', headers: { ...bearer(token()), ...FORM }, body: '' })).headers.get('allow'), 'GET');
  });
});

// ---- failed jobs and replay ----------------------------------------------------------------------------------------------------------------
test('failed jobs page: shows the token shop\'s jobs only', async () => {
  const mine = [{ id: OWN_A, topic: 'orders/paid', businessKey: 'orders/paid|x|gid://shopify/Order/1', webhookId: 'w', deadAt: '2026-10-26T12:00:00Z' }];
  const asked: string[] = [];
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/app/api/jobs`)).status, 401);
    const html = await (await fetch(`${url}/app/api/jobs?shop=other-shop.myshopify.com`, { headers: bearer(token()) })).text();
    assert.ok(html.includes(OWN_A) && html.includes('Replay all (1)'));
    assert.deepEqual(asked, [SHOP], 'the jobs were asked for the token shop only');
  }, { data: { jobs: async (shop) => { asked.push(shop); return shop === SHOP ? mine : []; } } });
});

test('replay: a shop can replay only its OWN jobs; another shop\'s job id and "all" never touch them', async () => {
  await withServer(async (url, _l, _c, w, replays) => {
    const one = await post(url, '/app/api/replay', { id: OWN_A });
    assert.equal(one.status, 200);
    assert.ok((await one.text()).includes('Jobs moved back to the queue'));
    const foreign = await post(url, '/app/api/replay', { id: OTHER_JOB });
    assert.equal(foreign.status, 200);
    assert.ok((await foreign.text()).includes('Nothing to replay.'));
    await post(url, '/app/api/replay', { id: 'all' });
    assert.deepEqual(replays, [[OWN_A], [OWN_A, OWN_B]], "never the other shop's job, and the foreign id replayed nothing");
    assert.deepEqual(w.audits.map((a) => [a.action, a.detail]), [['replay', 'jobs=1 · user 42'], ['replay', 'jobs=2 · user 42']], 'only real replays are audited');
  });
});

test('replay: unknown ids, non-ids and extra fields are refused; nothing replayed or audited; no token means no replay', async () => {
  await withServer(async (url, _l, _c, w, replays) => {
    for (const body of [{}, { id: '' }, { id: 'ALL' }, { id: 'a' }, { id: `${OWN_A},${OWN_B}` }, { id: "'; drop" }]) {
      const r = await post(url, '/app/api/replay', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok((await r.text()).includes('That request was not understood.'));
    }
    assert.equal((await post(url, '/app/api/replay', { id: 'all' }, FORM)).status, 401);
    assert.equal((await fetch(`${url}/app/api/replay`, { headers: bearer(token()) })).status, 405);
    assert.deepEqual(replays, []);
    assert.deepEqual(w.audits, []);
  });
});

test('replay: with no failed jobs it says so and writes nothing; a replay that moves none is not audited', async () => {
  await withServer(async (url, _l, _c, w, replays) => {
    const r = await post(url, '/app/api/replay', { id: 'all' });
    assert.ok((await r.text()).includes('Nothing to replay.'));
    assert.deepEqual([replays, w.audits], [[], []]);
  }, { dead: [] });
  await withServer(async (url, _l, _c, w) => {
    const r = await post(url, '/app/api/replay', { id: OWN_A });
    assert.ok((await r.text()).includes('Nothing to replay.'));
    assert.deepEqual(w.audits, []);
  }, { replayMoves: 0 });
});

test('writes for a shop the operator has not set up are refused for settings and replay too', async () => {
  await withServer(async (url, _l, _c, w, replays) => {
    assert.equal((await post(url, '/app/api/settings', { minOrderTotal: '1' })).status, 403);
    assert.equal((await post(url, '/app/api/replay', { id: 'all' })).status, 403);
    assert.equal(w.settings.size, 0);
    assert.deepEqual(replays, []);
  }, { known: async () => false });
});

test("the failed-jobs list is this shop's jobs only, with look-alike shop names kept apart, and carries no payload", () => {
  const j = (id: string, shop: string) => ({ id, shop, topic: 'orders/paid', businessKey: `k-${id}`, webhookId: `w-${id}`, deadAt: '2026-10-26T12:00:00Z', payload: 'CUSTOMER DATA', data: { email: 'x@y.z' } });
  const all = [j('a', SHOP), j('b', 'other-shop.myshopify.com'), j('c', `${SHOP}.evil.io`), j('d', `x${SHOP}`), j('e', SHOP)];
  const mine = jobsFor(all as any, SHOP);
  assert.deepEqual(mine.map((x) => x.id), ['a', 'e']);
  assert.deepEqual(Object.keys(mine[0]).sort(), ['businessKey', 'deadAt', 'id', 'topic', 'webhookId']);
  assert.ok(!JSON.stringify(mine).includes('CUSTOMER DATA') && !JSON.stringify(mine).includes('x@y.z'));
  assert.deepEqual(failedJobsFor(all as any, SHOP), 2);
  assert.deepEqual(jobsFor([], SHOP), []);
});

// ---- privacy requests ------------------------------------------------------------------------------------------------------------------------
test('privacy page: needs a token; lists the token shop\'s requests; a shop in the query is ignored', async () => {
  await withServer(async (url, _l, calls) => {
    assert.equal((await fetch(`${url}/app/api/privacy`)).status, 401);
    const r = await fetch(`${url}/app/api/privacy?shop=other-shop.myshopify.com`, { headers: bearer(token()) });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Shop data erased') && html.includes('req-7'));
    assert.deepEqual(calls.filter((c) => c.startsWith('privacy')), [`privacyList ${SHOP}`]);
    assert.equal((await post(url, '/app/api/privacy', {})).status, 405, 'read only');
    assert.equal((await fetch(`${url}/app/api/privacy`, { method: 'PUT', headers: { ...bearer(token()), ...FORM }, body: '' })).headers.get('allow'), 'GET');
  });
});

test('privacy details: ?id= shows that request only when it is this shop\'s; anything else falls back to the list', async () => {
  await withServer(async (url, _l, calls) => {
    const own = await (await fetch(`${url}/app/api/privacy?id=7&shop=other-shop.myshopify.com`, { headers: bearer(token()) })).text();
    assert.ok(own.includes('00Qxx0000012345') && own.includes('Back to privacy requests'));
    assert.deepEqual(calls.filter((c) => c.startsWith('privacyEntry')), [`privacyEntry ${SHOP} 7`]);
    for (const id of ['8', '0', '-1', 'abc', '7.5', '7 ', '99999999999999', '1e3', '%00', "7'; --"]) {
      const html = await (await fetch(`${url}/app/api/privacy?id=${encodeURIComponent(id)}`, { headers: bearer(token()) })).text();
      assert.ok(!html.includes('00Qxx0000012345') && html.includes('<s-page heading="Privacy requests">'), JSON.stringify(id));
    }
  });
});

test('privacy scoping: only this shop\'s records, look-alike shop names kept apart, only the fields the page needs', () => {
  const e = (id: number, shop: string) => ({ id, at: 't', kind: 'shop/redact', shop, requestRef: `r${id}`, detail: { n: id }, extra: 'must not pass' });
  const all = [e(1, SHOP), e(2, 'other-shop.myshopify.com'), e(3, `${SHOP}.evil.io`), e(4, `x${SHOP}`), e(5, SHOP)];
  const mine = privacyFor(all as any, SHOP);
  assert.deepEqual(mine.map((x) => x.id), [1, 5]);
  assert.deepEqual(Object.keys(mine[0]).sort(), ['at', 'detail', 'id', 'kind', 'requestRef']);
  assert.equal(privacyEntryFor(all[0] as any, SHOP)?.id, 1);
  for (const foreign of [all[1], all[2], all[3]]) assert.equal(privacyEntryFor(foreign as any, SHOP), null);
  assert.equal(privacyEntryFor(null, SHOP), null);
  assert.deepEqual(privacyFor([], SHOP), []);
});

test('the setup guide shows the steps and offers the check; the check reports each result, is audited with the user, and is POST-only', async () => {
  await withServer(async (url, _l, _c, w) => {
    const g = await fetch(`${url}/app/api/guide`, { headers: bearer(token()) });
    assert.equal(g.status, 200);
    const html = await g.text();
    assert.ok(html.includes('Salesforce setup guide') && html.includes('data-post="/app/api/check"'));
    assert.equal((await fetch(`${url}/app/api/guide`)).status, 401, 'no token, no guide');
    assert.equal((await fetch(`${url}/app/api/check`, { headers: bearer(token()) })).status, 405, 'a check is a POST');
    const r = await post(url, '/app/api/check', {});
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('Everything the recipe needs is in place'));
    assert.deepEqual(w.audits, [{ action: 'setup_checked', shop: SHOP, detail: 'checks=1 attention=0 · user 42' }]);
  });
});

test('a check that finds a problem or cannot log in says so in fixed words and never shows the reason Salesforce gave', async () => {
  await withServer(async (url, _l, _c, w) => {
    const html = await (await post(url, '/app/api/check', {})).text();
    assert.ok(html.includes('Some things need attention.') && html.includes('Move the user to a full licence'));
    assert.deepEqual(w.audits, [{ action: 'setup_checked', shop: SHOP, detail: 'checks=2 attention=1 · user 42' }]);
  }, { writes: { check: async () => ({ ok: true, checks: [{ id: 'a', title: 'A', status: 'pass' }, { id: 't', title: 'Tasks', status: 'fail', fix: 'Move the user to a full licence' }] }) } });
  await withServer(async (url, _l, _c, w) => {
    const html = await (await post(url, '/app/api/check', {})).text();
    assert.ok(html.includes('Check not completed') && html.includes('Salesforce did not accept the connection'));
    assert.deepEqual(w.audits, [{ action: 'setup_checked', shop: SHOP, detail: 'not_completed auth · user 42' }]);
  }, { writes: { check: async () => ({ ok: false, reason: 'auth' }) } });
});

test('per-store limits: Salesforce calls are limited hardest, writes more loosely, reads not at all, and one store never uses another store\'s allowance', async () => {
  await withServer(async (url, logs) => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(url, '/app/api/check', {})).status);
    assert.deepEqual(codes, [...Array(10).fill(200), 429]);
    const refused = await post(url, '/app/api/verify', {});
    assert.equal(refused.status, 429, 'test connection shares the Salesforce allowance');
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    assert.equal((await refused.text()), 'too many requests');
    assert.equal((await post(url, '/app/api/recipe', { action: 'disable' })).status, 200, 'the kill switch is a different allowance: never locked out by a busy check');
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${url}/app/api/home`, { headers: bearer(token()) })).status, 200, 'reads are not limited');
    assert.ok(logs.some((l) => l.startsWith('embedded_rate_limited')));
  }, { known: async () => true });
  await withServer(async (url) => {
    for (let i = 0; i < 10; i++) await post(url, '/app/api/check', {});
    assert.equal((await post(url, '/app/api/check', {})).status, 429);
    assert.equal((await post(url, '/app/api/check', {}, { ...bearer(token({ iss: 'https://b-shop.myshopify.com/admin', dest: 'https://b-shop.myshopify.com' })), ...FORM })).status, 200, 'another store has its own allowance');
  }, { known: async () => true });
});

const dry = (n: number) => async () => Array.from({ length: n }, () => entry());

test('merchant go-live is refused unless the operator allowed it; allowed, it needs every readiness item and the word LIVE, and is audited with the user', async () => {
  // not allowed (the default): 403, nothing written, even with everything ready
  await withServer(async (url, _l, _c, w) => {
    w.connections.put(SHOP, { loginUrl: 'https://x.my.salesforce.com', clientId: 'C', clientSecret: 'S' });
    const r = await post(url, '/app/api/recipe', { action: 'go_live', confirm: 'LIVE' });
    assert.equal(r.status, 403);
    assert.ok(!(await r.text()).includes('Go live'));
    assert.deepEqual(w.audits, []);
  }, { data: { recent: dry(5) } });
  // allowed but not ready (too few dry-run decisions): 422, mode untouched
  await withServer(async (url, _l, _c, w) => {
    await w.connections.put(SHOP, { loginUrl: 'https://x.my.salesforce.com', clientId: 'C', clientSecret: 'S' });
    const page = await (await fetch(`${url}/app/api/setup`, { headers: bearer(token()) })).text();
    assert.ok(page.includes('Go live') && page.includes('not yet') && !page.includes('Type LIVE to confirm'), 'the form appears only when ready');
    const r = await post(url, '/app/api/recipe', { action: 'go_live', confirm: 'LIVE' });
    assert.equal(r.status, 422);
    assert.ok((await r.text()).includes('Not ready to go live yet'));
    assert.equal(w.settings.get(`${SHOP}|R`)?.dryRun ?? true, true);
    assert.deepEqual(w.audits, []);
  }, { goLive: { minDryRun: 3 }, data: { recent: dry(2) } });
  // allowed and ready: needs the word; then it goes live and is audited
  await withServer(async (url, _l, _c, w) => {
    await w.connections.put(SHOP, { loginUrl: 'https://x.my.salesforce.com', clientId: 'C', clientSecret: 'S' });
    const page = await (await fetch(`${url}/app/api/setup`, { headers: bearer(token()) })).text();
    assert.ok(page.includes('Type LIVE to confirm'));
    const noWord = await post(url, '/app/api/recipe', { action: 'go_live', confirm: 'live' });
    assert.equal(noWord.status, 400);
    assert.notEqual(w.settings.get(`${SHOP}|R`)?.dryRun, false);
    const ok = await post(url, '/app/api/recipe', { action: 'go_live', confirm: 'LIVE' });
    assert.equal(ok.status, 200);
    assert.equal(w.settings.get(`${SHOP}|R`)?.dryRun, false);
    assert.deepEqual(w.audits, [{ action: 'recipe_live', shop: SHOP, detail: 'user 42' }]);
  }, { goLive: { minDryRun: 3 }, data: { recent: dry(3) } });
});

test('a store that is already live sees the LIVE banner and a way back to dry-run, not the go-live form', async () => {
  await withServer(async (url) => {
    const page = await (await fetch(`${url}/app/api/setup`, { headers: bearer(token()) })).text();
    assert.ok(page.includes('writing Leads and Tasks to your Salesforce') && page.includes('back to dry-run') && !page.includes('Type LIVE to confirm'));
  }, { goLive: { minDryRun: 1 }, data: { summary: async () => ({ connection: { stored: true, lastVerifiedAt: 'x' }, recipe: { name: 'R1', configured: true, enabled: true, dryRun: false } }) } });
});

test('reading the decision log or the privacy records is audited with the user; other pages are not', async () => {
  await withServer(async (url, _l, _c, w) => {
    for (const p of ['home', 'setup', 'settings', 'jobs', 'guide']) assert.equal((await fetch(`${url}/app/api/${p}`, { headers: bearer(token()) })).status, 200);
    assert.deepEqual(w.audits, []);
    await fetch(`${url}/app/api/log`, { headers: bearer(token()) });
    await fetch(`${url}/app/api/privacy?id=7`, { headers: bearer(token()) });
    assert.deepEqual(w.audits, [{ action: 'viewed_log', shop: SHOP, detail: 'user 42' }, { action: 'viewed_privacy', shop: SHOP, detail: 'user 42' }]);
    assert.equal((await fetch(`${url}/app/api/log`)).status, 401);
    assert.equal(w.audits.length, 2, 'a refused request leaves no entry');
  });
});
