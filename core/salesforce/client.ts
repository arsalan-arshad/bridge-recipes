// Salesforce REST client (client-credentials flow through an External Client App).
// Facts it is built on (docs/SPEC.md section 7, observed 2026-10-19/20): the token response has NO expires_in and no
// refresh token, so we re-authenticate on a 401 (once), not on a timer; limits are read from Sforce-Limit-Info only
// (GET /limits is 403 for the integration user); Lead duplicate rules answer HTTP 400 DUPLICATES_DETECTED.
// Never logs or puts a token, secret or header into an error. Emails inside Salesforce messages are redacted.

import { isAllowedSalesforceUrl } from './hosts.ts';
import { apiUsageRatio } from './limitInfo.ts';
import { redactEmail } from '../log/redactEmail.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ErrorKind = 'duplicate' | 'restricted_picklist' | 'auth' | 'rate_limit' | 'transient' | 'permanent';

export class SalesforceError extends Error {
  readonly kind: ErrorKind;
  readonly status: number;
  readonly errorCode: string;
  readonly matchedIds: string[];
  constructor(kind: ErrorKind, status: number, errorCode: string, message: string, matchedIds: string[] = []) {
    super(`${errorCode}: ${message}`.slice(0, 300));
    this.name = 'SalesforceError';
    this.kind = kind;
    this.status = status;
    this.errorCode = errorCode;
    this.matchedIds = matchedIds;
  }
  // Worth retrying later (infrastructure, limits, credentials the owner may fix). Duplicates, validation and
  // permission errors will not change by waiting.
  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'rate_limit' || this.kind === 'auth';
  }
}

export interface SalesforceClientOptions {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  apiVersion?: string; // default: discovered once from /services/data/
  timeoutMs?: number;
  maxUsageRatio?: number; // stop calling (as a retryable rate_limit) at or above this share of the daily allowance
}

const TYPE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const ID_RE = /^[A-Za-z0-9]{15,18}$/;
function assertSafe(kind: 'type' | 'id' | 'field', value: string): string {
  const ok = kind === 'id' ? ID_RE.test(value) : TYPE_RE.test(value);
  if (!ok) throw new SalesforceError('permanent', 0, 'INVALID_ARGUMENT', `unsafe ${kind} for a request path`);
  return value;
}

const scrub = (text: string) => text.replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, (m) => redactEmail(m));

function classify(status: number, json: any): SalesforceError {
  const first = Array.isArray(json) ? json[0] : null;
  const code: string = typeof first?.errorCode === 'string' ? first.errorCode : `HTTP_${status}`;
  const msg = scrub(typeof first?.message === 'string' ? first.message : '');
  if (code === 'DUPLICATES_DETECTED') {
    const ids: string[] = (first?.duplicateResult?.matchResults ?? [])
      .flatMap((m: any) => (m?.matchRecords ?? []).map((r: any) => r?.record?.Id))
      .filter((x: unknown): x is string => typeof x === 'string');
    return new SalesforceError('duplicate', status, code, msg, ids);
  }
  if (code === 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST') return new SalesforceError('restricted_picklist', status, code, msg);
  if (code === 'REQUEST_LIMIT_EXCEEDED' || status === 429) return new SalesforceError('rate_limit', status, code, msg);
  if (status === 401 || code === 'INVALID_SESSION_ID') return new SalesforceError('auth', status, code, msg);
  if (status >= 500 || code === 'UNABLE_TO_LOCK_ROW' || code === 'SERVER_UNAVAILABLE' || code === 'SERVICE_UNAVAILABLE') {
    return new SalesforceError('transient', status, code, msg);
  }
  return new SalesforceError('permanent', status, code, msg);
}

export class SalesforceClient {
  private readonly opts: SalesforceClientOptions;
  private readonly doFetch: FetchLike;
  private token: string | null = null;
  private base = '';
  private version: string | null;
  private authInFlight: Promise<void> | null = null;
  private lastRatio: number | null = null;

  constructor(opts: SalesforceClientOptions) {
    this.opts = opts;
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.version = opts.apiVersion ?? null;
  }

  get usageRatio(): number | null {
    return this.lastRatio;
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.opts.timeoutMs ?? 15_000);
  }

  private async raw(url: string, init: RequestInit): Promise<Response> {
    try {
      // redirect: 'error' -- never follow a redirect (it would re-send credentials to wherever it points)
      return await this.doFetch(url, { ...init, redirect: 'error', signal: this.signal() });
    } catch {
      // Network failure or timeout. The cause is dropped on purpose: it could echo URLs or headers.
      throw new SalesforceError('transient', 0, 'NETWORK_ERROR', 'request failed or timed out');
    }
  }

  private authenticate(): Promise<void> {
    if (this.authInFlight) return this.authInFlight; // concurrent callers share one token request
    const run = async () => {
      const base = this.opts.loginUrl.replace(/\/$/, '');
      const res = await this.raw(`${base}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.opts.clientId, client_secret: this.opts.clientSecret }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || typeof j.access_token !== 'string' || typeof j.instance_url !== 'string') {
        const code = typeof j.error === 'string' ? j.error : `HTTP_${res.status}`;
        // 5xx from the login host is transient; anything else (invalid_client, ...) needs the owner to fix credentials.
        throw new SalesforceError(res.status >= 500 ? 'transient' : 'auth', res.status, code, 'authentication failed');
      }
      if (!isAllowedSalesforceUrl(j.instance_url)) throw new SalesforceError('auth', res.status, 'BAD_INSTANCE_URL', 'authentication failed');
      this.token = j.access_token;
      this.base = j.instance_url.replace(/\/$/, '');
    };
    this.authInFlight = run().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async apiVersion(): Promise<string> {
    if (this.version) return this.version;
    try {
      const res = await this.raw(`${this.base}/services/data/`, { method: 'GET' });
      const j: any = await res.json();
      if (Array.isArray(j) && j.length > 0 && typeof j[j.length - 1]?.version === 'string') {
        this.version = `v${j[j.length - 1].version}`;
        return this.version;
      }
    } catch {
      // fall through to the pinned fallback
    }
    this.version = 'v60.0';
    return this.version;
  }

  // Returns the parsed body for any 2xx; throws a classified SalesforceError otherwise.
  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    if (this.opts.maxUsageRatio !== undefined && this.lastRatio !== null && this.lastRatio >= this.opts.maxUsageRatio) {
      throw new SalesforceError('rate_limit', 0, 'LOCAL_LIMIT_GUARD', `API usage ${(this.lastRatio * 100).toFixed(0)}% of the daily allowance`);
    }
    if (this.token === null) await this.authenticate();
    const attempt = async (): Promise<Response> => {
      const v = await this.apiVersion();
      return this.raw(`${this.base}${path.replace('{v}', v)}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    let res = await attempt();
    if (res.status === 401) {
      this.token = null; // no expires_in: a 401 is how we learn the token is gone. Re-authenticate ONCE.
      await this.authenticate();
      res = await attempt();
    }
    const limit = res.headers.get('sforce-limit-info');
    const ratio = apiUsageRatio(limit);
    if (ratio !== null) this.lastRatio = ratio;
    const text = await res.text();
    let json: any = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, json };
    throw classify(res.status, json);
  }

  async query(soql: string): Promise<any[]> {
    const r = await this.request('GET', `/services/data/{v}/query?q=${encodeURIComponent(soql)}`);
    return Array.isArray(r.json?.records) ? r.json.records : [];
  }

  async create(type: string, fields: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ id: string }> {
    const r = await this.request('POST', `/services/data/{v}/sobjects/${assertSafe('type', type)}`, fields, headers);
    if (typeof r.json?.id !== 'string') throw new SalesforceError('permanent', r.status, 'NO_ID', 'create returned no id');
    return { id: r.json.id };
  }

  async update(type: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/services/data/{v}/sobjects/${assertSafe('type', type)}/${assertSafe('id', id)}`, fields);
  }

  async getRecord(type: string, id: string, fields: string[]): Promise<Record<string, any>> {
    const r = await this.request('GET', `/services/data/{v}/sobjects/${assertSafe('type', type)}/${assertSafe('id', id)}?fields=${fields.map((f) => assertSafe('field', f)).join(',')}`);
    return r.json ?? {};
  }
}
