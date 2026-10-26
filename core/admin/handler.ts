// The operator admin UI as a plain request handler, mounted under /admin by the app. Order of checks on every request:
//   method -> (login route) -> valid session -> [POST: content type, body size, Origin, form parse, CSRF token] -> action.
// Anything that fails an earlier check never reaches a later one. Responses always carry the security headers.

import { assertShop } from '../app/admin.ts';
import { recipeAction, saveConfig, saveConnection, verifyConnection } from './actions.ts';
import type { ActionOutcome } from './actions.ts';
import { FormError, MAX_FORM_BYTES, parseForm } from './forms.ts';
import { SECURITY_HEADERS, esc, layout } from './html.ts';
import { complianceDetailPage, compliancePage, dashboardPage, loginPage, logPage, replayPage, shopPage } from './pages.ts';
import type { ConnectionInfo, RecipeView } from './pages.ts';
import { LoginLimiter, checkCsrf, clearedCookie, constantTimeEqual, createSession, csrfToken, readSession, sessionCookie } from './security.ts';
import type { Session } from './security.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectionStore } from '../salesforce/connectionStore.ts';
import type { RecipeSettings } from '../worker/recipe.ts';
import type { LogEntry } from '../worker/syncLog.ts';
import type { AuditEntry, ComplianceEntry, DeadJob } from '../queue/postgresAdminData.ts';
import type { Logger } from '../app/logger.ts';

export interface AdminRecipe {
  id: string;
  name: string;
  defaultConfig: unknown;
  validate(config: unknown): any;
  toForm(config: any): Record<string, string | boolean>;
  fromForm(form: Map<string, string>): unknown;
}

export interface AdminDeps {
  password: string;
  sessionKey: Buffer;
  now: () => number;
  sessionTtlMs?: number;
  recipe: AdminRecipe;
  connections: ConnectionStore & { info(shop: string): Promise<ConnectionInfo> };
  configs: { get(shop: string, recipeId: string): Promise<RecipeSettings | null>; set(shop: string, recipeId: string, s: { enabled: boolean; dryRun?: boolean; config: unknown }): Promise<void>; disable(shop: string, recipeId: string): Promise<boolean> };
  syncLog: { recent(f: { shop?: string; outcome?: string; limit?: number; offset?: number }): Promise<LogEntry[]> };
  shops(): Promise<string[]>;
  verify(shop: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  dead: { list(): Promise<DeadJob[]>; replay(ids: string[] | 'all'): Promise<number> };
  audit: { record(e: { action: string; shop?: string; detail?: string }): Promise<void>; recent(n: number): Promise<AuditEntry[]> };
  compliance: { recent(n: number): Promise<ComplianceEntry[]>; get(id: number): Promise<ComplianceEntry | null> };
  log?: Logger;
  limiter?: LoginLimiter;
  // Set only when a reverse proxy you control sits in front (e.g. Railway): then the client address for the login limiter is X-Real-IP, else the LAST
  // X-Forwarded-For entry (the one the proxy appended) and X-Forwarded-Proto may mark the connection as https. Otherwise both are ignored.
  trustProxy?: boolean;
}

const OUTCOMES = new Set(['created', 'updated', 'duplicate_detected', 'already_done', 'skipped', 'dry_run', 'recipe_disabled', 'unknown_topic', 'invalid_payload', 'retry', 'failed']);
const SHOP_PATH = /^\/admin\/shops\/([a-z0-9][a-z0-9-]*\.myshopify\.com)(?:\/(log|connection|verify|recipe|config))?$/;
const UUID = /^[0-9a-fA-F-]{36}$/;
const PAGE_SIZE = 50;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createAdminHandler(deps: AdminDeps): (req: IncomingMessage, res: ServerResponse) => boolean {
  const ttl = deps.sessionTtlMs ?? 8 * 3600 * 1000;
  const limiter = deps.limiter ?? new LoginLimiter({ maxPerIp: 5, maxGlobal: 30, windowMs: 15 * 60 * 1000, now: deps.now });
  const recipe = deps.recipe;
  // Signed cookies are stateless, so logging out must also revoke the session on the server (until it would have expired anyway).
  // In memory: a restart forgets revocations, but every session also expires on its own.
  const revoked = new Map<string, number>();

  const send = (res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', ...extra }).end(html);
  };
  const redirect = (res: ServerResponse, location: string, extra: Record<string, string> = {}) => {
    res.writeHead(303, { ...SECURITY_HEADERS, Location: location, ...extra }).end();
  };
  const errorPage = (res: ServerResponse, status: number, text: string) =>
    send(res, status, layout({ title: 'Error', body: `<div class="card"><h1>${esc(text)}</h1><p><a href="/admin">Back</a></p></div>`, nav: false }));

  async function readForm(req: IncomingMessage): Promise<Map<string, string>> {
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Unsupported content type');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_FORM_BYTES) throw new HttpError(413, 'Request too large');
      chunks.push(c as Buffer);
    }
    try {
      return parseForm(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      throw new HttpError(e instanceof FormError ? e.status : 400, 'Bad request');
    }
  }

  // Cross-site requests are refused even before the CSRF token is looked at.
  function sameOrigin(req: IncomingMessage): boolean {
    const host = req.headers.host;
    for (const h of [req.headers.origin, req.headers.referer]) {
      if (typeof h !== 'string' || h === '') continue;
      try {
        if (new URL(h).host !== host) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async function summary(shop: string): Promise<{ recipe: RecipeView; conn: ConnectionInfo; settings: RecipeSettings | null }> {
    const [settings, conn] = await Promise.all([deps.configs.get(shop, recipe.id), deps.connections.info(shop)]);
    return { settings, conn, recipe: { name: recipe.name, enabled: settings?.enabled === true, dryRun: settings?.dryRun !== false, configured: settings !== null } };
  }

  async function renderShop(res: ServerResponse, status: number, shop: string, csrf: string, extra: { msg?: string | null; form?: Record<string, string | boolean>; errors?: string[]; connError?: string } = {}) {
    const s = await summary(shop);
    const entries = await deps.syncLog.recent({ shop, limit: 10 });
    const form = extra.form ?? recipe.toForm(s.settings?.config ?? recipe.defaultConfig);
    send(res, status, shopPage({ csrf, shop, recipe: s.recipe, conn: s.conn, entries, form, msg: extra.msg, errors: extra.errors, connError: extra.connError }));
  }

  async function audit(action: string, shop?: string, detail?: string) {
    try {
      await deps.audit.record({ action, shop, detail });
    } catch {
      deps.log?.('error', 'admin_audit_failed', { action });
    }
  }

  // The shop write actions live in ./actions.ts (shared with the embedded page); null = not an action route.
  async function runAction(section: string | undefined, shop: string, form: Map<string, string>): Promise<ActionOutcome | null> {
    if (section === 'connection') return saveConnection(deps, shop, form);
    if (section === 'verify') return verifyConnection(deps, shop);
    if (section === 'recipe') return recipeAction(deps, shop, form);
    if (section === 'config') return saveConfig(deps, shop, form);
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, POST' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const secure = (deps.trustProxy === true && req.headers['x-forwarded-proto'] === 'https') || (req.socket as any).encrypted === true;
    // Behind the trusted proxy: X-Real-IP (Railway documents it as the client address), else the LAST X-Forwarded-For entry.
    const hdr = (n: string) => String(req.headers[n] ?? '').split(',').pop()?.trim().slice(0, 64) ?? '';
    const proxied = deps.trustProxy === true ? hdr('x-real-ip') || hdr('x-forwarded-for') : '';
    const ip = (proxied !== '' ? proxied : req.socket.remoteAddress) ?? 'unknown';
    const nowMs = deps.now();

    // ---- login (no session needed) ----
    if (path === '/admin/login') {
      if (req.method === 'GET') return send(res, 200, loginPage());
      if (limiter.blocked(ip)) return send(res, 429, loginPage('Too many failed attempts. Try again later.'));
      if (!sameOrigin(req)) return errorPage(res, 403, 'Forbidden');
      const form = await readForm(req);
      if (!constantTimeEqual(form.get('password') ?? '', deps.password, deps.sessionKey)) {
        limiter.failure(ip);
        await audit('login_failed');
        return send(res, 401, loginPage('Wrong password.'));
      }
      limiter.success(ip);
      await audit('login_ok');
      return redirect(res, '/admin', { 'Set-Cookie': sessionCookie(createSession(deps.sessionKey, nowMs, ttl), { secure, maxAgeSeconds: Math.floor(ttl / 1000) }) });
    }

    // ---- everything else needs a valid session ----
    for (const [nonce, exp] of revoked) if (exp <= nowMs) revoked.delete(nonce);
    const found = readSession(deps.sessionKey, req.headers.cookie, nowMs);
    const session: Session | null = found && !revoked.has(found.nonce) ? found : null;
    if (!session) return redirect(res, '/admin/login');
    const csrf = csrfToken(deps.sessionKey, session);

    let form = new Map<string, string>();
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return errorPage(res, 403, 'Forbidden');
      form = await readForm(req);
      if (!checkCsrf(deps.sessionKey, session, form.get('csrf'))) return errorPage(res, 403, 'Forbidden');
    }

    if (path === '/admin/logout' && req.method === 'POST') {
      revoked.set(session.nonce, session.exp);
      await audit('logout');
      return redirect(res, '/admin/login', { 'Set-Cookie': clearedCookie(secure) });
    }

    if (path === '/admin' && req.method === 'GET') {
      const shops = await deps.shops();
      const rows = [];
      for (const shop of shops) {
        const s = await summary(shop);
        const mode = !s.settings || !s.settings.enabled ? 'disabled' : s.settings.dryRun ? 'dry-run' : 'LIVE';
        rows.push({ shop, connected: s.conn.stored, mode, tone: (mode === 'LIVE' ? 'bad' : mode === 'dry-run' ? 'ok' : 'warn') as 'bad' | 'ok' | 'warn' });
      }
      return send(res, 200, dashboardPage({ csrf, msg: url.searchParams.get('msg'), shops: rows, dead: (await deps.dead.list()).length, audit: await deps.audit.recent(15) }));
    }

    if (path === '/admin/shops' && req.method === 'POST') {
      let shop: string;
      try {
        shop = assertShop((form.get('shop') ?? '').trim().toLowerCase());
      } catch {
        return errorPage(res, 400, 'Shop must look like my-store.myshopify.com');
      }
      if ((await deps.configs.get(shop, recipe.id)) === null) await deps.configs.set(shop, recipe.id, { enabled: false, dryRun: true, config: recipe.defaultConfig });
      await audit('shop_added', shop);
      return redirect(res, `/admin/shops/${shop}?msg=shop_added`);
    }

    if (path === '/admin/compliance' && req.method === 'GET') return send(res, 200, compliancePage({ csrf, entries: await deps.compliance.recent(100) }));
    const cm = /^\/admin\/compliance\/([0-9]{1,12})$/.exec(path);
    if (cm && req.method === 'GET') {
      const entry = await deps.compliance.get(Number(cm[1]));
      return entry ? send(res, 200, complianceDetailPage({ csrf, entry })) : errorPage(res, 404, 'Not found');
    }

    if (path === '/admin/replay') {
      if (req.method === 'GET') return send(res, 200, replayPage({ csrf, msg: url.searchParams.get('msg'), jobs: await deps.dead.list() }));
      const id = form.get('id') ?? '';
      if (id !== 'all' && !UUID.test(id)) return errorPage(res, 400, 'Bad request');
      const moved = await deps.dead.replay(id === 'all' ? 'all' : [id]);
      await audit('replay', undefined, `jobs=${moved}`);
      return redirect(res, `/admin/replay?msg=${moved > 0 ? 'replayed' : 'nothing_to_replay'}`);
    }

    const m = SHOP_PATH.exec(path);
    if (!m) return errorPage(res, 404, 'Not found');
    const shop = m[1];
    const section = m[2];

    if (!section && req.method === 'GET') return renderShop(res, 200, shop, csrf, { msg: url.searchParams.get('msg') });

    if (section === 'log' && req.method === 'GET') {
      const outcomeRaw = url.searchParams.get('outcome') ?? '';
      const outcome = OUTCOMES.has(outcomeRaw) ? outcomeRaw : '';
      const page = Math.min(Math.max(Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1, 1), 2000);
      const rows = await deps.syncLog.recent({ shop, outcome: outcome || undefined, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
      return send(res, 200, logPage({ csrf, shop, entries: rows.slice(0, PAGE_SIZE), outcome, page, hasNext: rows.length > PAGE_SIZE }));
    }

    if (req.method !== 'POST') return errorPage(res, 404, 'Not found');

    const outcome = await runAction(section, shop, form);
    if (outcome === null) return errorPage(res, 404, 'Not found');
    if (outcome.ok) {
      await audit(outcome.audit.action, shop, outcome.audit.detail);
      return redirect(res, `/admin/shops/${shop}?msg=${outcome.msg}`);
    }
    if (outcome.kind === 'bad_request') return errorPage(res, 400, 'Bad request');
    if (outcome.kind === 'connection') {
      if (outcome.audit) await audit(outcome.audit.action, shop, outcome.audit.detail);
      return renderShop(res, outcome.status, shop, csrf, { connError: outcome.message });
    }
    return renderShop(res, outcome.status, shop, csrf, { errors: outcome.errors, ...(outcome.echo ? { form: outcome.echo } : {}) });
  }

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;
    handle(req, res).catch((e) => {
      if (res.headersSent) return;
      if (e instanceof HttpError) return errorPage(res, e.status, e.message);
      deps.log?.('error', 'admin_error'); // no detail: it could echo data
      errorPage(res, 500, 'Something went wrong');
    });
    return true;
  };
}
