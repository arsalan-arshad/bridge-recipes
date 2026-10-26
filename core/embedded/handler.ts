// The embedded Shopify admin surface (docs/EMBEDDED_UI.md). Exists only when SHOPIFY_API_KEY (the app's client id) is set.
//
//   GET /app                 unauthenticated shell: shop domain only, no data (Shopify: never put protected data in the
//                            HTML sent before the token is verified)
//   GET /app/assets/app.js   the small browser script
//   GET /app/api/home        HTML fragment (setup status + latest decisions), needs `Authorization: Bearer <ID token>`
//   GET /app/api/log         HTML fragment (decision log, ?outcome= & ?page=), same auth
//   GET /app/api/setup       HTML fragment (Salesforce connection and recipe controls)
//   GET /app/api/settings    HTML fragment (the recipe's settings form); POST /app/api/settings saves it
//   GET /app/api/jobs        HTML fragment (this shop's failed jobs); POST /app/api/replay replays them (own jobs only)
//   POST /app/api/connection | /verify | /recipe   the write actions (core/admin/actions.ts), form-encoded body, same auth.
//                            Going LIVE is deliberately NOT available here (owner decision 2026-10-27): a `go_live` request is refused with
//                            403 and nothing is written; it needs the operator password on /admin.
// The shop is ALWAYS the one in the verified token; a `shop` in the query string or body of an API call is never read. A write is
// recorded in the audit trail with the Shopify user id from the token. Writes need `Content-Type: application/x-www-form-urlencoded`.
//
// No cookies: the ID token is the credential and App Bridge gives a fresh one per request. A bad token gets 401 plus
// X-Shopify-Retry-Invalid-Session-Request so App Bridge fetches a new one; a valid token for a shop we do not know gets 403.

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { esc } from '../admin/html.ts';
import { FormError, MAX_FORM_BYTES, parseForm } from '../admin/forms.ts';
import { recipeAction, saveConfig, saveConnection, verifyConnection } from '../admin/actions.ts';
import type { ActionDeps, ActionOutcome } from '../admin/actions.ts';
import { HOME_SAMPLE, LOG_OUTCOMES, PAGE_SIZE, homeFragment, jobsFragment, logFragment, settingsFragment, setupFragment } from './pages.ts';
import type { HomeData, JobView, SetupData } from './pages.ts';
import { selectReplayIds } from './replay.ts';
import { SHOP_PATTERN, verifySessionToken } from './token.ts';
import type { LogEntry } from '../worker/syncLog.ts';

// [verify] on the dev store: Shopify's CDN script locations and any extra CSP sources Polaris needs (docs/EMBEDDED_UI.md section 8).
const APP_BRIDGE = 'https://cdn.shopify.com/shopifycloud/app-bridge.js';
const POLARIS = 'https://cdn.shopify.com/shopifycloud/polaris.js';
const ADMIN_HOST = 'https://admin.shopify.com';

const SCRIPT = readFileSync(new globalThis.URL('./assets/app.js', import.meta.url));

// What the pages need, per shop (reads only; writes go through `actions`).
export interface EmbeddedData {
  summary(shop: string): Promise<Pick<HomeData, 'connection' | 'recipe'>>;
  recent(f: { shop: string; outcome?: string; limit: number; offset: number }): Promise<LogEntry[]>;
  failedJobs(shop: string): Promise<number>;
  jobs(shop: string): Promise<JobView[]>; // this shop's failed jobs only
  settingsForm(shop: string): Promise<Record<string, string | boolean>>; // the stored settings as form values
}

// Failed jobs are listed for every shop; each shop's page counts only its own.
export function failedJobsFor(jobs: { shop: string }[], shop: string): number {
  return jobs.filter((j) => j.shop === shop).length;
}

// The failed-jobs page shows this shop's jobs only, and only the fields it needs (never a payload).
export function jobsFor(jobs: { id: string; shop: string; topic: string; businessKey: string; webhookId: string; deadAt: string }[], shop: string): JobView[] {
  return jobs.filter((j) => j.shop === shop).map(({ id, topic, businessKey, webhookId, deadAt }) => ({ id, topic, businessKey, webhookId, deadAt }));
}

export interface EmbeddedDeps {
  clientId: string; // the app's client id (public): the token's `aud` and the App Bridge meta tag
  clientSecret: string; // the app's client secret: signs the ID token
  knownShop: (shop: string) => Promise<boolean>;
  data: EmbeddedData;
  actions: ActionDeps; // the shared write actions
  audit: { record(e: { action: string; shop?: string; detail?: string }): Promise<void> };
  dead: { list(): Promise<{ id: string; shop: string }[]>; replay(ids: string[]): Promise<number> }; // all shops' failed jobs; the handler narrows to the token's shop
  now: () => number;
  log?: (level: 'info' | 'error', event: string, fields?: Record<string, unknown>) => void;
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function shellCsp(shop: string): string {
  return [
    "default-src 'none'",
    "script-src 'self' https://cdn.shopify.com",
    "style-src 'self' 'unsafe-inline' https://cdn.shopify.com",
    "img-src data: https://cdn.shopify.com",
    "connect-src 'self' https://cdn.shopify.com",
    `frame-ancestors https://${shop} ${ADMIN_HOST}`,
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

function shell(clientId: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="shopify-api-key" content="${esc(clientId)}"><title>Bridge Recipes</title>
<script src="${APP_BRIDGE}"></script><script src="${POLARIS}"></script></head>
<body><div id="app"><s-spinner accessibilityLabel="Loading"></s-spinner></div><noscript>This app needs JavaScript.</noscript>
<script src="/app/assets/app.js"></script></body></html>`;
}

type Route = 'home' | 'log' | 'setup' | 'settings' | 'jobs' | 'connection' | 'verify' | 'recipe' | 'settings_save' | 'replay';
const READS = new Set<string>(['home', 'log', 'setup', 'settings', 'jobs']);
// path -> the route for each allowed method; any other method is 405 with Allow listing these
const ROUTES: Record<string, { GET?: Route; POST?: Route }> = {
  '/app/api/home': { GET: 'home' }, '/app/api/log': { GET: 'log' }, '/app/api/setup': { GET: 'setup' }, '/app/api/jobs': { GET: 'jobs' },
  '/app/api/settings': { GET: 'settings', POST: 'settings_save' },
  '/app/api/connection': { POST: 'connection' }, '/app/api/verify': { POST: 'verify' }, '/app/api/recipe': { POST: 'recipe' }, '/app/api/replay': { POST: 'replay' },
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(String(status));
    this.status = status;
  }
}

async function readForm(req: IncomingMessage): Promise<Map<string, string>> {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new HttpError(415);
  if (Number(req.headers['content-length'] ?? 0) > MAX_FORM_BYTES) throw new HttpError(413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new HttpError(413);
    chunks.push(c as Buffer);
  }
  try {
    return parseForm(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new HttpError(e instanceof FormError ? e.status : 400);
  }
}

export function createEmbeddedHandler(deps: EmbeddedDeps): (req: IncomingMessage, res: ServerResponse) => boolean {
  const text = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) =>
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra }).end(body);
  const fragment = (res: ServerResponse, status: number, html: string) =>
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" }).end(html);

  async function setupData(shop: string, extra: Pick<SetupData, 'msg' | 'errors' | 'connError'> = {}): Promise<SetupData> {
    return { shop, ...(await deps.data.summary(shop)), ...extra };
  }

  async function render(route: Route, shop: string, query: URLSearchParams): Promise<string> {
    if (route === 'home') {
      const [summary, recent, failedJobs] = await Promise.all([
        deps.data.summary(shop), deps.data.recent({ shop, limit: HOME_SAMPLE, offset: 0 }), deps.data.failedJobs(shop),
      ]);
      return homeFragment({ shop, ...summary, recent, failedJobs });
    }
    if (route === 'setup') return setupFragment(await setupData(shop));
    if (route === 'settings') return settingsFragment({ shop, form: await deps.data.settingsForm(shop) });
    if (route === 'jobs') return jobsFragment({ shop, jobs: await deps.data.jobs(shop) });
    const asked = query.get('outcome') ?? '';
    const outcome = LOG_OUTCOMES.includes(asked) ? asked : ''; // anything else means "all"
    const n = Number(query.get('page') ?? '1');
    const page = Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
    const rows = await deps.data.recent({ shop, ...(outcome ? { outcome } : {}), limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
    return logFragment({ shop, outcome, page, entries: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE });
  }

  // Runs a write action for the token's shop, records it (with the Shopify user), and shows the setup page with the result.
  async function record(shop: string, userId: string | null, audit: { action: string; detail?: string }): Promise<void> {
    const detail = [audit.detail, userId ? `user ${userId}` : null].filter(Boolean).join(' · ') || undefined;
    try {
      await deps.audit.record({ action: audit.action, shop, detail });
    } catch {
      deps.log?.('error', 'embedded_audit_failed', { action: audit.action });
    }
  }

  // Replay: only the token's shop's own failed jobs, whatever id the request names.
  async function replay(shop: string, userId: string | null, form: Map<string, string>): Promise<{ status: number; html: string }> {
    const sel = selectReplayIds(await deps.dead.list(), shop, form.get('id'));
    if (!sel.ok) return { status: 400, html: jobsFragment({ shop, jobs: await deps.data.jobs(shop), errors: ['That request was not understood.'] }) };
    if (sel.ids.length === 0) return { status: 200, html: jobsFragment({ shop, jobs: await deps.data.jobs(shop), msg: 'nothing_to_replay' }) };
    const moved = await deps.dead.replay(sel.ids);
    if (moved > 0) await record(shop, userId, { action: 'replay', detail: `jobs=${moved}` }); // a replay that moved nothing changed nothing
    return { status: 200, html: jobsFragment({ shop, jobs: await deps.data.jobs(shop), msg: moved > 0 ? 'replayed' : 'nothing_to_replay' }) };
  }

  async function saveSettings(shop: string, userId: string | null, form: Map<string, string>): Promise<{ status: number; html: string }> {
    const outcome = await saveConfig(deps.actions, shop, form);
    if (outcome.ok) {
      await record(shop, userId, outcome.audit);
      return { status: 200, html: settingsFragment({ shop, form: await deps.data.settingsForm(shop), msg: outcome.msg }) };
    }
    if (outcome.kind === 'settings') return { status: outcome.status, html: settingsFragment({ shop, form: outcome.echo ?? (await deps.data.settingsForm(shop)), errors: outcome.errors }) };
    return { status: 400, html: settingsFragment({ shop, form: await deps.data.settingsForm(shop), errors: ['That request was not understood.'] }) };
  }

  async function act(route: 'connection' | 'verify' | 'recipe', shop: string, userId: string | null, form: Map<string, string>): Promise<{ status: number; html: string }> {
    if (route === 'recipe' && form.get('action') === 'go_live') {
      deps.log?.('info', 'embedded_go_live_refused', { shop });
      return { status: 403, html: setupFragment(await setupData(shop, { errors: ['Going live is done from the operator admin page, with the operator password.'] })) };
    }
    const outcome: ActionOutcome = route === 'connection' ? await saveConnection(deps.actions, shop, form)
      : route === 'verify' ? await verifyConnection(deps.actions, shop) : await recipeAction(deps.actions, shop, form);
    const audit = ('audit' in outcome ? outcome.audit : undefined);
    if (audit) await record(shop, userId, audit);
    if (outcome.ok) return { status: 200, html: setupFragment(await setupData(shop, { msg: outcome.msg })) };
    if (outcome.kind === 'bad_request') return { status: 400, html: setupFragment(await setupData(shop, { errors: ['That action is not recognised.'] })) };
    if (outcome.kind === 'connection') return { status: outcome.status, html: setupFragment(await setupData(shop, { connError: outcome.message })) };
    return { status: outcome.status, html: setupFragment(await setupData(shop, { errors: outcome.errors })) };
  }

  async function api(req: IncomingMessage, res: ServerResponse, route: Route, query: URLSearchParams): Promise<void> {
    const auth = String(req.headers.authorization ?? '');
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(auth);
    const verdict = verifySessionToken(m ? m[1] : '', { clientSecret: deps.clientSecret, clientId: deps.clientId, nowMs: deps.now() });
    if (!verdict.ok) {
      deps.log?.('info', 'embedded_token_refused', { reason: verdict.reason });
      return text(res, 401, 'unauthorized', { 'X-Shopify-Retry-Invalid-Session-Request': '1' });
    }
    let known = false;
    try {
      known = await deps.knownShop(verdict.shop);
    } catch {
      deps.log?.('error', 'embedded_shop_lookup_failed');
      return text(res, 503, 'unavailable');
    }
    if (!known) {
      deps.log?.('info', 'embedded_unknown_shop', { shop: verdict.shop });
      return text(res, 403, 'forbidden');
    }
    try {
      if (READS.has(route)) return fragment(res, 200, await render(route, verdict.shop, query));
      const form = await readForm(req);
      const out = route === 'settings_save' ? await saveSettings(verdict.shop, verdict.userId, form)
        : route === 'replay' ? await replay(verdict.shop, verdict.userId, form)
          : await act(route as 'connection' | 'verify' | 'recipe', verdict.shop, verdict.userId, form);
      return fragment(res, out.status, out.html);
    } catch (e) {
      if (e instanceof HttpError) return text(res, e.status, 'rejected');
      deps.log?.('error', 'embedded_data_failed', { route });
      return text(res, 500, 'error');
    }
  }

  return (req, res) => {
    const url = new globalThis.URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path !== '/app' && !path.startsWith('/app/')) return false;

    const entry = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    const allowed = entry === undefined ? ['GET'] : Object.keys(entry);
    const method = req.method ?? '';
    if (!allowed.includes(method)) {
      res.writeHead(405, { ...BASE_HEADERS, Allow: allowed.join(', ') }).end();
      return true;
    }
    const route = entry === undefined ? undefined : entry[method as 'GET' | 'POST'];
    if (path === '/app') {
      const shop = (url.searchParams.get('shop') ?? '').toLowerCase();
      // the shop goes into a response header (frame-ancestors): accept only a plain myshopify.com host, nothing else
      if (!SHOP_PATTERN.test(shop)) {
        text(res, 400, 'Open this app from the Shopify admin.');
        return true;
      }
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': shellCsp(shop) }).end(shell(deps.clientId));
      return true;
    }
    if (path === '/app/assets/app.js') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(SCRIPT);
      return true;
    }
    if (route) {
      api(req, res, route, url.searchParams).catch(() => {
        if (!res.headersSent) res.writeHead(500, BASE_HEADERS);
        res.end();
      });
      return true;
    }
    text(res, 404, 'Not found');
    return true;
  };
}
