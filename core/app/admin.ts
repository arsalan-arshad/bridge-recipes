// Operator actions (until the M3 admin UI exists). Everything here is validated and secret-free in its output.

import { isAllowedSalesforceUrl } from '../salesforce/hosts.ts';
import { SalesforceClient, SalesforceError } from '../salesforce/client.ts';
import { parseKey } from '../crypto/secretBox.ts';
import { assertSchemaName } from '../queue/migrate.ts';
import type { ConnectionStore } from '../salesforce/connectionStore.ts';
import type { PostgresConfigStore } from '../queue/postgresConfigStore.ts';
import type { PostgresSyncLog } from '../queue/postgresSyncLog.ts';
import type { FetchLike } from '../salesforce/client.ts';

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export function assertShop(shop: string): string {
  if (!SHOP_RE.test(shop)) throw new AdminError('shop must look like my-store.myshopify.com');
  return shop;
}

export function validateLoginUrl(raw: string): string {
  // Any scheme other than http(s) is refused outright; prepending https:// to it would silently point at a different host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) throw new AdminError('SF_LOGIN_URL must use https');
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AdminError('SF_LOGIN_URL is not a valid URL');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new AdminError('SF_LOGIN_URL must use https');
  if (u.username || u.password) throw new AdminError('SF_LOGIN_URL must not contain credentials');
  if (!isAllowedSalesforceUrl(`${u.protocol}//${u.host}`)) throw new AdminError('SF_LOGIN_URL must be a Salesforce domain (for example https://yourdomain.my.salesforce.com)');
  return `${u.protocol}//${u.host}`;
}

// Minimal environment for the operator commands (no webhook secret needed).
export function loadStoreEnv(env: Record<string, string | undefined> = process.env) {
  const problems: string[] = [];
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL must be a postgres:// connection string');
  let key = Buffer.alloc(0);
  try { key = parseKey(env.ENCRYPTION_KEY); } catch { problems.push('ENCRYPTION_KEY must be 64 hex characters (generate: openssl rand -hex 32)'); }
  const schema = env.BRIDGE_SCHEMA || 'bridge';
  try { assertSchemaName(schema); } catch { problems.push('BRIDGE_SCHEMA must be lower-case letters, digits and underscores'); }
  if (problems.length) throw new AdminError(`invalid configuration: ${problems.join('; ')}`);
  return { databaseUrl, encryptionKey: key, schema };
}

export async function connectShop(connections: ConnectionStore, shop: string, c: { loginUrl: string; clientId: string; clientSecret: string }): Promise<void> {
  assertShop(shop);
  if (!c.clientId || c.clientId.length > 512) throw new AdminError('SF_CLIENT_ID is missing or too long');
  if (!c.clientSecret || c.clientSecret.length > 512) throw new AdminError('SF_CLIENT_SECRET is missing or too long');
  await connections.put(shop, { loginUrl: validateLoginUrl(c.loginUrl), clientId: c.clientId, clientSecret: c.clientSecret });
}

// Proves the stored connection works with the cheapest read there is, and records the time. Returns a class, never a message.
export async function verifyShop(connections: ConnectionStore, shop: string, opts: { fetch?: FetchLike; now?: () => Date } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  assertShop(shop);
  const conn = await connections.get(shop);
  if (!conn) return { ok: false, reason: 'no_connection' };
  try {
    await new SalesforceClient({ ...conn, fetch: opts.fetch }).query('SELECT Id FROM Lead LIMIT 1');
    await connections.markVerified(shop, (opts.now ?? (() => new Date()))());
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof SalesforceError ? `${e.kind}:${e.errorCode}` : 'internal' };
  }
}

export async function setRecipe(configs: PostgresConfigStore, shop: string, recipeId: string, o: { enable: boolean; live?: boolean; config: unknown }): Promise<void> {
  assertShop(shop);
  if (!o.enable) {
    await configs.disable(shop, recipeId);
    return;
  }
  // A recipe is dry-run unless live is EXPLICITLY true.
  await configs.set(shop, recipeId, { enabled: true, dryRun: o.live !== true, config: o.config });
}

export async function shopStatus(deps: { connections: ConnectionStore; configs: PostgresConfigStore; syncLog: PostgresSyncLog; pool: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }> }; schema: string }, shop: string, recipeId: string) {
  assertShop(shop);
  const conn = await deps.connections.get(shop).then((c) => c !== null, () => 'unreadable (wrong ENCRYPTION_KEY?)');
  const v = await deps.pool.query(`SELECT last_verified_at FROM ${assertSchemaName(deps.schema)}.salesforce_connection WHERE shop = $1`, [shop]);
  const s = await deps.configs.get(shop, recipeId);
  const counts = await deps.pool.query(`SELECT outcome, count(*)::int AS n FROM ${deps.schema}.sync_log WHERE shop = $1 GROUP BY outcome ORDER BY outcome`, [shop]);
  return {
    shop,
    connection: conn,
    lastVerifiedAt: v.rows[0]?.last_verified_at ? new Date(v.rows[0].last_verified_at).toISOString() : null,
    recipe: s ? { id: recipeId, enabled: s.enabled, mode: s.dryRun ? 'dry-run' : 'LIVE' } : { id: recipeId, enabled: false, mode: 'not configured (disabled)' },
    outcomes: Object.fromEntries(counts.rows.map((r) => [r.outcome, r.n])),
  };
}
