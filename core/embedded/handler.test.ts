import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEmbeddedHandler, failedJobsFor } from './handler.ts';
import type { EmbeddedData } from './handler.ts';
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

async function withServer(fn: (url: string, logs: string[], calls: string[]) => Promise<void>, opts: { known?: (s: string) => Promise<boolean>; data?: Partial<EmbeddedData> } = {}) {
  const logs: string[] = [];
  const { data, calls } = fakeData(opts.data);
  const handle = createEmbeddedHandler({
    clientId: ID, clientSecret: SECRET, now: () => NOW, data,
    knownShop: opts.known ?? (async (s) => s === SHOP),
    log: (_l, event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
  });
  const server = createServer((req, res) => {
    if (!handle(req, res)) res.writeHead(418).end('not ours');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs, calls);
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
