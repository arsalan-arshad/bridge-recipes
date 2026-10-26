// Verifies the session (ID) token that Shopify App Bridge gives the embedded page. Pure: the clock is injected, nothing
// else is read. Facts (docs/EMBEDDED_UI.md section 2): HS256 signed with the app client secret; claims exp, nbf, iss, dest,
// aud (= our client id), sub. Everything is checked BEFORE any claim is trusted, and the signature first.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export type TokenRefusal =
  | 'malformed'
  | 'bad_algorithm'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_audience'
  | 'bad_shop'
  | 'issuer_mismatch';

export type TokenResult = { ok: true; shop: string; userId: string | null } | { ok: false; reason: TokenRefusal };

export interface TokenOptions {
  clientSecret: string;
  clientId: string;
  nowMs: number;
  leewaySeconds?: number; // clock skew allowed on exp / nbf
}

const b64urlJson = (s: string): unknown => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
};

function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new globalThis.URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function verifySessionToken(token: string, opts: TokenOptions): TokenResult {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some((p) => p === '' || !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const [h, p, sig] = parts;

  const header = b64urlJson(h) as { alg?: unknown } | undefined;
  if (typeof header !== 'object' || header === null) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'HS256') return { ok: false, reason: 'bad_algorithm' };

  const expected = createHmac('sha256', opts.clientSecret).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };

  const c = b64urlJson(p) as Record<string, unknown> | undefined;
  if (typeof c !== 'object' || c === null) return { ok: false, reason: 'malformed' };

  const nowS = opts.nowMs / 1000;
  const leeway = opts.leewaySeconds ?? 5;
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp) || c.exp + leeway <= nowS) return { ok: false, reason: 'expired' };
  if (typeof c.nbf !== 'number' || !Number.isFinite(c.nbf) || c.nbf - leeway > nowS) return { ok: false, reason: 'not_yet_valid' };

  if (typeof c.aud !== 'string' || c.aud !== opts.clientId) return { ok: false, reason: 'wrong_audience' };

  const dest = hostOf(c.dest);
  if (dest === null || !SHOP_PATTERN.test(dest)) return { ok: false, reason: 'bad_shop' };
  if (hostOf(c.iss) !== dest) return { ok: false, reason: 'issuer_mismatch' };

  return { ok: true, shop: dest, userId: typeof c.sub === 'string' && c.sub !== '' ? c.sub : null };
}
