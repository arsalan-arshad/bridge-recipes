// The embedded Shopify admin surface (docs/EMBEDDED_UI.md). Exists only when SHOPIFY_API_KEY (the app's client id) is set.
//
//   GET /app                 unauthenticated shell: shop domain only, no data (Shopify: never put protected data in the
//                            HTML sent before the token is verified)
//   GET /app/assets/app.js   the small browser script
//   GET /app/api/home        HTML fragment, needs `Authorization: Bearer <ID token>`
//
// No cookies: the ID token is the credential and App Bridge gives a fresh one per request. A bad token gets 401 plus
// X-Shopify-Retry-Invalid-Session-Request so App Bridge fetches a new one; a valid token for a shop we do not know gets 403.

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { esc } from '../admin/html.ts';
import { SHOP_PATTERN, verifySessionToken } from './token.ts';

// [verify] on the dev store: Shopify's CDN script locations and any extra CSP sources Polaris needs (docs/EMBEDDED_UI.md section 8).
const APP_BRIDGE = 'https://cdn.shopify.com/shopifycloud/app-bridge.js';
const POLARIS = 'https://cdn.shopify.com/shopifycloud/polaris.js';
const ADMIN_HOST = 'https://admin.shopify.com';

const SCRIPT = readFileSync(new globalThis.URL('./assets/app.js', import.meta.url));

export interface EmbeddedDeps {
  clientId: string; // the app's client id (public): the token's `aud` and the App Bridge meta tag
  clientSecret: string; // the app's client secret: signs the ID token
  knownShop: (shop: string) => Promise<boolean>;
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

function home(shop: string): string {
  return `<s-page heading="Bridge Recipes"><s-section heading="Connected"><s-paragraph>Signed in through Shopify for <s-text type="strong">${esc(shop)}</s-text>.</s-paragraph>
<s-paragraph>The setup, log and controls move into this page next; until then use the operator admin page.</s-paragraph></s-section></s-page>`;
}

export function createEmbeddedHandler(deps: EmbeddedDeps): (req: IncomingMessage, res: ServerResponse) => boolean {
  async function api(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = String(req.headers.authorization ?? '');
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(auth);
    const verdict = verifySessionToken(m ? m[1] : '', { clientSecret: deps.clientSecret, clientId: deps.clientId, nowMs: deps.now() });
    if (!verdict.ok) {
      deps.log?.('info', 'embedded_token_refused', { reason: verdict.reason });
      res.writeHead(401, { ...BASE_HEADERS, 'X-Shopify-Retry-Invalid-Session-Request': '1', 'Content-Type': 'text/plain; charset=utf-8' }).end('unauthorized');
      return;
    }
    let known = false;
    try {
      known = await deps.knownShop(verdict.shop);
    } catch {
      deps.log?.('error', 'embedded_shop_lookup_failed');
      res.writeHead(503, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('unavailable');
      return;
    }
    if (!known) {
      deps.log?.('info', 'embedded_unknown_shop', { shop: verdict.shop });
      res.writeHead(403, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" }).end(home(verdict.shop));
  }

  return (req, res) => {
    const url = new globalThis.URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path !== '/app' && !path.startsWith('/app/')) return false;

    if (req.method !== 'GET') {
      res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET' }).end();
      return true;
    }
    if (path === '/app') {
      const shop = (url.searchParams.get('shop') ?? '').toLowerCase();
      // the shop goes into a response header (frame-ancestors): accept only a plain myshopify.com host, nothing else
      if (!SHOP_PATTERN.test(shop)) {
        res.writeHead(400, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Open this app from the Shopify admin.');
        return true;
      }
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': shellCsp(shop) }).end(shell(deps.clientId));
      return true;
    }
    if (path === '/app/assets/app.js') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(SCRIPT);
      return true;
    }
    if (path === '/app/api/home') {
      api(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, BASE_HEADERS);
        res.end();
      });
      return true;
    }
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return true;
  };
}
