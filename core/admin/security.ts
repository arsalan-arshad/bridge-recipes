// Security primitives for the operator admin UI: signed stateless sessions, CSRF tokens, constant-time comparison and a login
// rate limiter. Nothing here touches the database. The session key is derived from ENCRYPTION_KEY (HKDF), so no extra secret.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'bridge_admin';

// The admin password is mixed in, so changing ADMIN_PASSWORD invalidates every existing session (including after a restart).
export function deriveSessionKey(encryptionKey: Buffer, adminPassword = ''): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.concat([encryptionKey, Buffer.from(adminPassword, 'utf8')]), Buffer.from('bridge-recipes'), Buffer.from('admin-session'), 32));
}

const b64 = (b: Buffer) => b.toString('base64url');

// Compares two strings without leaking where they differ or how long they are: both are HMAC'd with the key first.
export function constantTimeEqual(a: string, b: string, key: Buffer): boolean {
  const ha = createHmac('sha256', key).update(a).digest();
  const hb = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface Session {
  exp: number; // epoch ms
  nonce: string;
}

const sign = (key: Buffer, payload: string) => b64(createHmac('sha256', key).update(`session|${payload}`).digest());

export function createSession(key: Buffer, nowMs: number, ttlMs: number): string {
  const payload = b64(Buffer.from(JSON.stringify({ exp: nowMs + ttlMs, nonce: b64(randomBytes(16)) })));
  return `${payload}.${sign(key, payload)}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    const name = i > 0 ? part.slice(0, i).trim() : '';
    if (name !== '') out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function readSession(key: Buffer, cookieHeader: string | undefined, nowMs: number): Session | null {
  const value = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'utf8');
  const expected = Buffer.from(sign(key, payload), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof s?.exp !== 'number' || typeof s?.nonce !== 'string' || s.exp <= nowMs) return null;
    return { exp: s.exp, nonce: s.nonce };
  } catch {
    return null;
  }
}

export function csrfToken(key: Buffer, session: Session): string {
  return b64(createHmac('sha256', key).update(`csrf|${session.nonce}`).digest());
}

export function checkCsrf(key: Buffer, session: Session, token: string | undefined): boolean {
  if (typeof token !== 'string' || token === '') return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(csrfToken(key, session), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookie(value: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${opts.maxAgeSeconds}${opts.secure ? '; Secure' : ''}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0${secure ? '; Secure' : ''}`;
}

// Failed-login limiter: per client address AND a global ceiling (so a distributed guess is also slowed down).
export class LoginLimiter {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];
  private readonly maxPerIp: number;
  private readonly maxGlobal: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(opts: { maxPerIp: number; maxGlobal: number; windowMs: number; now: () => number }) {
    this.maxPerIp = opts.maxPerIp;
    this.maxGlobal = opts.maxGlobal;
    this.windowMs = opts.windowMs;
    this.now = opts.now;
  }
  private prune(list: number[]): number[] {
    const cutoff = this.now() - this.windowMs;
    return list.filter((t) => t > cutoff);
  }
  blocked(ip: string): boolean {
    this.global = this.prune(this.global);
    const mine = this.prune(this.perIp.get(ip) ?? []);
    this.perIp.set(ip, mine);
    if (this.perIp.size > 10_000) this.perIp.clear(); // bound memory
    return mine.length >= this.maxPerIp || this.global.length >= this.maxGlobal;
  }
  failure(ip: string): void {
    const t = this.now();
    this.perIp.set(ip, [...this.prune(this.perIp.get(ip) ?? []), t]);
    this.global = [...this.prune(this.global), t];
  }
  success(ip: string): void {
    this.perIp.delete(ip);
  }
}
