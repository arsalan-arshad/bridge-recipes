// Local Shopify webhook capture, for ONE-TIME research on a dev store (docs/research/R1_PLATFORM_FACTS.md
// section 5, checks 1-2). Not part of the product. Verifies the HMAC over the raw body with the real
// core/shopify/verifyHmac.ts, then saves the delivery to a git-ignored folder.
//
//   node --env-file=.env scripts/capture-webhook.ts            # PORT defaults to 8787
//   FAIL_FIRST=yes node --env-file=.env scripts/capture-webhook.ts   # answer 500 the first time each event id is seen
//
// Env var NAMES (values only in your untracked .env, never printed): SHOPIFY_WEBHOOK_SECRET
//   = the signing key shown on the store admin's Settings > Notifications > Webhooks page.
// Saved files contain test-store customer data: they go to ./captures/ (git-ignored). Delete them when done.

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyShopifyHmac } from '../core/shopify/verifyHmac.ts';

const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 8787);
const DIR = process.env.CAPTURE_DIR ?? join(import.meta.dirname, '..', 'captures');
const FAIL_FIRST = process.env.FAIL_FIRST === 'yes';

if (SECRET === '') {
  console.log('Missing SHOPIFY_WEBHOOK_SECRET in the environment.');
  process.exit(1);
}
mkdirSync(DIR, { recursive: true });

const seenEvents = new Set<string>();
let n = 0;

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks); // raw bytes, before any parsing
    const h = req.headers;
    const sig = typeof h['x-shopify-hmac-sha256'] === 'string' ? h['x-shopify-hmac-sha256'] : undefined;
    if (req.method !== 'POST' || !verifyShopifyHmac(raw, sig, SECRET)) {
      console.log(`[reject 401] ${req.method} signature ${sig === undefined ? 'missing' : 'invalid'}`);
      res.writeHead(401).end();
      return;
    }
    const eventId = String(h['x-shopify-event-id'] ?? '');
    const webhookId = String(h['x-shopify-webhook-id'] ?? '');
    const topic = String(h['x-shopify-topic'] ?? '');
    const firstTimeForEvent = !seenEvents.has(eventId);
    seenEvents.add(eventId);
    const status = FAIL_FIRST && firstTimeForEvent ? 500 : 200;

    n++;
    const record = {
      receivedAt: new Date().toISOString(),
      respondedWith: status,
      hmacVerified: true,
      headers: {
        topic,
        webhookId,
        eventId,
        apiVersion: String(h['x-shopify-api-version'] ?? ''),
        triggeredAt: String(h['x-shopify-triggered-at'] ?? ''),
        shopDomain: String(h['x-shopify-shop-domain'] ?? ''),
      },
      body: JSON.parse(raw.toString('utf8')),
    };
    writeFileSync(join(DIR, `${String(n).padStart(3, '0')}-${topic.replace('/', '_')}.json`), JSON.stringify(record, null, 2));
    console.log(`[#${n}] ${topic} webhook-id=${webhookId} event-id=${eventId} -> ${status}`);
    res.writeHead(status).end();
  });
}).listen(PORT, '127.0.0.1', () => console.log(`listening on 127.0.0.1:${PORT}${FAIL_FIRST ? ' (FAIL_FIRST on)' : ''}`));
