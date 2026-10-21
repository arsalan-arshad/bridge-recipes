// Live smoke test of the real SalesforceClient + processJob + R1 recipe against the Developer org, in DRY-RUN:
// read-only lookups run, NOTHING is written. Prints the sync-log entries (emails and last names are masked).
//
//   node --env-file=.env scripts/worker-smoke.ts [payload.json]
// Env var NAMES: SF_LOGIN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET. Never prints tokens or secrets.

import { readFileSync } from 'node:fs';
import { SalesforceClient } from '../core/salesforce/client.ts';
import { processJob } from '../core/worker/processJob.ts';
import { MemoryConfigStore } from '../core/worker/recipe.ts';
import { MemorySyncLog } from '../core/worker/syncLog.ts';
import { MemoryEntityStore } from '../core/executor/entityStore.ts';
import { r1Recipe, R1_DEFAULT_CONFIG, R1_ID } from '../recipes/retail-b2b-lead-spotter/recipe.ts';

const raw = (process.env.SF_LOGIN_URL ?? '').trim();
const loginUrl = raw !== '' && !/^https?:\/\//i.test(raw) ? `https://${raw}` : raw;
if (!loginUrl || !process.env.SF_CLIENT_ID || !process.env.SF_CLIENT_SECRET) {
  console.log('Missing SF_LOGIN_URL, SF_CLIENT_ID or SF_CLIENT_SECRET in the environment.');
  process.exit(1);
}
const file = process.argv[2] ?? 'recipes/retail-b2b-lead-spotter/payloads/SHOPIFY_real_orders_paid_2026-10_subscribed.json';
const sf = new SalesforceClient({ loginUrl, clientId: process.env.SF_CLIENT_ID, clientSecret: process.env.SF_CLIENT_SECRET, maxUsageRatio: 0.9 });
const configs = new MemoryConfigStore();
configs.set('smoke.myshopify.com', R1_ID, { enabled: true, dryRun: true, config: R1_DEFAULT_CONFIG }); // dry-run: no writes
const log = new MemorySyncLog();
const job = { webhookId: 'smoke-1', eventId: 'smoke', topic: 'orders/paid', shop: 'smoke.myshopify.com', apiVersion: '2026-10', businessKey: 'smoke', receivedAt: new Date().toISOString(), payload: readFileSync(file, 'utf8') };

try {
  const outcome = await processJob(job, { recipes: [r1Recipe], configs, sf, entities: new MemoryEntityStore(), log, now: () => new Date() });
  console.log('outcome:', outcome);
  console.log(JSON.stringify(log.entries, null, 2));
  console.log(`API usage ratio seen: ${sf.usageRatio}`);
} catch (e) {
  console.log('failed:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  console.log(JSON.stringify(log.entries, null, 2));
}
