// The running service: wires gateway + durable queue + worker + stores, adds health routes and a retention schedule, and
// shuts down gracefully. main.ts only reads the environment and calls this.
//
//   POST /webhooks/shopify   signed Shopify webhooks (raw-body HMAC first)
//   GET  /healthz            liveness: the process is up (no dependencies checked)
//   GET  /readyz             readiness: database reachable and not shutting down (503 otherwise)
// Health responses carry no data about shops, customers or configuration.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGatewayHandler } from '../gateway/server.ts';
import { startQueue } from '../queue/postgresIntake.ts';
import { PostgresEntityStore } from '../queue/postgresEntityStore.ts';
import { PostgresSyncLog } from '../queue/postgresSyncLog.ts';
import { PostgresConnectionStore } from '../queue/postgresConnectionStore.ts';
import { PostgresConfigStore } from '../queue/postgresConfigStore.ts';
import { purgeExpired } from '../queue/retention.ts';
import { createSalesforceProvider } from './sfProvider.ts';
import { startWorker } from '../worker/startWorker.ts';
import { createAdminHandler } from '../admin/handler.ts';
import { handleLifecycleJob } from '../compliance/handlers.ts';
import { LIFECYCLE_TOPICS } from '../compliance/topics.ts';
import { deriveSessionKey } from '../admin/security.ts';
import { PostgresAudit, PostgresComplianceLog, createDeadLetters, listShops } from '../queue/postgresAdminData.ts';
import { verifyShop } from './admin.ts';
import { configToForm, formToConfig } from '../../recipes/retail-b2b-lead-spotter/adminForm.ts';
import { R1_DEFAULT_CONFIG } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';
import { makeLogger } from './logger.ts';
import { r1Recipe } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';
import { validateR1Config } from '../../recipes/retail-b2b-lead-spotter/validateConfig.ts';
import { R1_ID } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';
import type { AppConfig } from './env.ts';
import type { Logger } from './logger.ts';
import type { FetchLike } from '../salesforce/client.ts';
import type { Recipe } from '../worker/recipe.ts';

export interface AppOptions {
  log?: Logger;
  now?: () => Date;
  fetch?: FetchLike; // Salesforce HTTP (tests point it at a local fake)
  purgeEveryMs?: number; // overrides config.purgeEveryMinutes (tests)
  recipes?: Recipe[];
}

export async function createApp(config: AppConfig, opts: AppOptions = {}) {
  const log = opts.log ?? makeLogger();
  const now = opts.now ?? (() => new Date());
  const recipes = opts.recipes ?? [r1Recipe];

  const rt = await startQueue({ connectionString: config.databaseUrl, schema: config.schema, onError: (source) => log('error', 'infrastructure_error', { source }) });
  let worker: string | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const entities = new PostgresEntityStore(rt.pool, config.schema);
    const syncLog = new PostgresSyncLog(rt.pool, config.schema);
    const connections = new PostgresConnectionStore(rt.pool, config.schema, config.encryptionKey);
    const configs = new PostgresConfigStore(rt.pool, config.schema, { [R1_ID]: validateR1Config }, (shop, recipeId) =>
      log('error', 'recipe_config_invalid', { shop, recipeId }));
    const sf = createSalesforceProvider({ connections, fetch: opts.fetch });

    worker = await startWorker(rt.boss, { recipes, configs, sf, entities, log: syncLog, now, lifecycle: (job) => handleLifecycleJob(job, { pool: rt.pool, schema: config.schema, boss: rt.boss, now }) }, { pollingIntervalSeconds: config.pollingSeconds });

    let stopping = false;
    const gateway = createGatewayHandler({
      secret: config.webhookSecret,
      intake: rt.intake,
      // the recipes' topics plus the mandatory privacy webhooks and the uninstall event
      topics: new Set([...recipes.flatMap((r) => r.topics), ...LIFECYCLE_TOPICS]),
      now,
      log: (e) => log(e.outcome === 'intake_error' ? 'error' : 'info', 'webhook', { outcome: e.outcome, topic: e.topic, shop: e.shop, webhookId: e.webhookId, ...(e.reason ? { reason: e.reason } : {}) }),
    });

    // The operator admin UI exists only when ADMIN_PASSWORD is set; otherwise /admin falls through to the 404 below.
    const admin = config.adminPassword === null ? null : createAdminHandler({
      password: config.adminPassword,
      trustProxy: config.trustProxy,
      sessionKey: deriveSessionKey(config.encryptionKey, config.adminPassword),
      now: () => now().getTime(),
      recipe: { id: R1_ID, name: 'Retail-to-B2B Lead Spotter', defaultConfig: R1_DEFAULT_CONFIG, validate: validateR1Config, toForm: configToForm, fromForm: formToConfig },
      connections, configs, syncLog,
      shops: () => listShops(rt.pool, config.schema),
      verify: (shop) => verifyShop(connections, shop, { fetch: opts.fetch, now }),
      dead: createDeadLetters(rt.boss),
      audit: new PostgresAudit(rt.pool, config.schema, now),
      compliance: new PostgresComplianceLog(rt.pool, config.schema),
      log,
    });

    server = createServer((req, res) => {
      if (admin && admin(req, res)) return;
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
        return;
      }
      if (req.method === 'GET' && req.url === '/readyz') {
        if (stopping) {
          res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"status":"stopping"}');
          return;
        }
        Promise.race([rt.pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 2000))])
          .then(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ready"}'))
          .catch(() => res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"status":"database unavailable"}'));
        return;
      }
      gateway(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(config.port, config.host, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;

    const purge = () =>
      purgeExpired(rt.pool, config.schema, now(), config.retention)
        .then((c) => log('info', 'purge', { syncLog: c.syncLog, intake: c.intake, entityMap: c.entityMap }))
        .catch(() => log('error', 'purge_failed'));
    void purge();
    timer = setInterval(purge, opts.purgeEveryMs ?? config.purgeEveryMinutes * 60_000);
    timer.unref();

    log('info', 'started', { port, schema: config.schema });

    let stopped: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopped ??= (async () => {
        stopping = true; // /readyz now answers 503 so a load balancer drains us
        if (timer) clearInterval(timer);
        log('info', 'stopping');
        // 1. stop taking new webhooks, let in-flight requests finish
        const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
        server!.closeIdleConnections();
        await Promise.race([closed, new Promise((r) => setTimeout(r, config.shutdownTimeoutMs))]);
        server!.closeAllConnections();
        // 2. let the worker finish the job it is running, then close the queue and the pool
        await rt.boss.stop({ graceful: true, close: true, timeout: config.shutdownTimeoutMs } as any).catch(() => {});
        await rt.pool.end().catch(() => {});
        log('info', 'stopped');
      })();
      return stopped;
    };

    return { port, stop, drain: () => { stopping = true; }, stores: { entities, syncLog, connections, configs }, runtime: rt, worker };
  } catch (err) {
    if (timer) clearInterval(timer);
    server?.close();
    await rt.stop().catch(() => {});
    throw err;
  }
}

export type App = Awaited<ReturnType<typeof createApp>>;
