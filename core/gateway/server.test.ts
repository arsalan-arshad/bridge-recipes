import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createGatewayServer } from './server.ts';
import { MemoryIntake } from './memoryIntake.ts';
import type { GatewayDeps } from './types.ts';

const SECRET = 'test-signing-secret';
const BODY = JSON.stringify({ admin_graphql_api_id: 'gid://shopify/Order/1', name: '#1' });
const sig = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('base64');

async function withServer(fn: (url: string, intake: MemoryIntake) => Promise<void>, maxBodyBytes?: number) {
  const intake = new MemoryIntake();
  const deps: GatewayDeps = { secret: SECRET, intake, topics: new Set(['orders/paid']), now: () => new Date(0), log: () => {} };
  const server = createGatewayServer(deps, { maxBodyBytes });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, intake);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const h = (raw: string, over: Record<string, string> = {}) => ({
  'X-Shopify-Hmac-SHA256': sig(raw),
  'X-Shopify-Topic': 'orders/paid',
  'X-Shopify-Shop-Domain': 'example-store.myshopify.com',
  'X-Shopify-Webhook-Id': 'wh-1',
  'Content-Type': 'application/json',
  ...over,
});

test('over HTTP: signed delivery 200 and queued; replay 200 and not queued twice', async () => {
  await withServer(async (url, intake) => {
    const a = await fetch(`${url}/webhooks/shopify`, { method: 'POST', headers: h(BODY), body: BODY });
    const b = await fetch(`${url}/webhooks/shopify`, { method: 'POST', headers: h(BODY), body: BODY });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await a.text(), ''); // no body echoed
    assert.equal(intake.jobs.length, 1);
  });
});

test('over HTTP: forged signature 401, wrong method or path 404, nothing queued', async () => {
  await withServer(async (url, intake) => {
    const forged = await fetch(`${url}/webhooks/shopify`, { method: 'POST', headers: h(BODY, { 'X-Shopify-Hmac-SHA256': sig(BODY, 'attacker') }), body: BODY });
    assert.equal(forged.status, 401);
    assert.equal((await fetch(`${url}/webhooks/shopify`)).status, 404);
    assert.equal((await fetch(`${url}/elsewhere`, { method: 'POST', headers: h(BODY), body: BODY })).status, 404);
    assert.equal(intake.jobs.length, 0);
  });
});

test('over HTTP: body over the cap -> 413 at once (declared length), nothing queued', async () => {
  await withServer(async (url, intake) => {
    const big = JSON.stringify({ pad: 'x'.repeat(5000) });
    const r = await fetch(`${url}/webhooks/shopify`, { method: 'POST', headers: h(big), body: big });
    assert.equal(r.status, 413);
    assert.equal(intake.jobs.length, 0);
  }, 1000);
});

test('over HTTP: an oversized STREAMED body (no declared length) is refused as soon as it overflows and the connection is dropped', async () => {
  const { request } = await import('node:http');
  await withServer(async (url, intake) => {
    const u = new URL(url);
    const result = await new Promise<{ status?: number; closed: boolean }>((resolve) => {
      const req = request({ host: u.hostname, port: u.port, path: '/webhooks/shopify', method: 'POST', headers: { 'Transfer-Encoding': 'chunked', 'X-Shopify-Hmac-SHA256': 'AAAA' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, closed: true }));
      });
      req.on('error', () => resolve({ closed: true }));
      let sent = 0;
      const pump = () => {
        if (req.destroyed || sent > 200) return req.end();
        sent++;
        req.write(Buffer.alloc(100));
        setTimeout(pump, 5);
      };
      pump();
      setTimeout(() => resolve({ closed: false }), 4000);
    });
    assert.equal(result.closed, true, 'the server ended the exchange instead of draining forever');
    assert.ok(result.status === 413 || result.status === undefined);
    assert.equal(intake.jobs.length, 0);
  }, 1000);
});

test('over HTTP: raw bytes are what gets signed (unicode body)', async () => {
  await withServer(async (url, intake) => {
    const body = JSON.stringify({ admin_graphql_api_id: 'gid://shopify/Order/7', note: 'café ✓ 日本語' });
    const r = await fetch(`${url}/webhooks/shopify`, { method: 'POST', headers: h(body, { 'X-Shopify-Webhook-Id': 'wh-u' }), body });
    assert.equal(r.status, 200);
    assert.equal(intake.jobs[0].payload, body);
  });
});
