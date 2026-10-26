# Embedded Shopify admin UI: design

_Status: DESIGN ONLY, nothing is built. Decided by the owner on 2026-10-26: the app must be embedded in the Shopify admin (a redirect to `/admin` is only a stopgap). Every platform fact below was read from shopify.dev on 2026-10-26 and is cited; anything marked **[verify]** was not confirmed and must be checked against the docs before the step that depends on it._

## 1. Goal and non-goals
**Goal:** a merchant opens the app inside the Shopify admin and sees a real page there: setup status, the Salesforce connection, the R1 controls (dry-run, LIVE, kill switch), the decision log with failed jobs, and the privacy-request record.

**Non-goals:** no new Shopify scope; no Admin API calls (the app is webhook-driven); no change to `decide()`, the executor or the queue; no frontend framework or build step (CLAUDE.md, D3); no billing; no multi-tenant hosting yet (section 7).

## 2. What Shopify requires (verified)
| Fact | Source |
|---|---|
| App Home is the page Shopify opens from the app's name; it is whatever the released version's App URL points to. | https://shopify.dev/docs/apps/design/navigation |
| Embedded apps load `app-bridge.js` from Shopify's CDN with a `<meta name="shopify-api-key">` tag; there is no manual initialisation. App Bridge exposes a `shopify` global. | https://shopify.dev/docs/api/app-bridge/migration-guide |
| UI uses Polaris web components (`s-page`, `s-section`, ...) loaded from a script tag; works in any framework or plain HTML. | https://shopify.dev/docs/api/app-home/v2.0 and https://shopify.dev/docs/api/app-home/v1.0/web-components/versioning |
| The frontend gets an ID token with `await shopify.idToken()` and sends it as `Authorization: Bearer <token>`. It expires after one minute: fetch a fresh one per request. | https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens and https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange |
| The token is a JWT signed HS256 with the app **client secret**. Server checks: `exp` in the future, `nbf` in the past, `iss` and `dest` hostnames match, `aud` equals the app's client id; `dest` is the shop origin. | https://shopify.dev/docs/apps/build/authentication-authorization/legacy/app-bridge-2-setup (the legacy page, but it describes the same JWT; re-check the current page for any claim change) |
| Do not put protected data in HTML returned before the token is verified; expose only the shop domain there and serve data from an authenticated API route. | same legacy page |
| On a failed or expired token respond 401 with header `X-Shopify-Retry-Invalid-Session-Request` so App Bridge fetches a new token and retries. | https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange |
| An embedded app must set `Content-Security-Policy: frame-ancestors` to the authenticated shop's domain (plus the admin host) on every HTML route, or App Store review rejects it; a non-embedded app uses `'none'`. | https://shopify.dev/docs/apps/build/security/app-server/set-up-iframe-protection (exact value format: **[verify]**) |
| Review wants: App Bridge + session tokens if embedded, a working UI on install, a helpful home page showing whether the app is set up and working, connection settings inside Shopify. | https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review and https://shopify.dev/docs/apps/launch/built-for-shopify/requirements |

## 3. Architecture
One new surface, `/app/*`, next to the unchanged password admin at `/admin/*`.

- **Shell (unauthenticated, no data):** `GET /app?shop=<shop>&host=...` returns a tiny HTML page: the `shopify-api-key` meta tag (our client id, which is public), the App Bridge and Polaris script tags, our own script, and an empty container. It reveals only the shop domain. Cookies are not used: third-party cookies in an iframe are unreliable, and the ID token is the credential.
- **Data/API (authenticated):** `GET/POST /app/api/...` require `Authorization: Bearer <id token>`. The server verifies the JWT (section 4), maps `dest` to a shop we already know, and then reuses the existing admin logic (pages, forms, settings store, replay, audit). Responses are server-rendered HTML fragments built with the same escaping helpers as today; the shell script inserts them. This keeps the existing renderers, tests and "no secrets shown back" rules.
- **No CSRF cookie needed:** requests carry the bearer token, which cross-site pages cannot attach; state-changing routes still check the token's `dest` against the shop in the path.
- **Headers:** `/app` shell and fragments get `frame-ancestors https://<validated shop> https://admin.shopify.com` **[verify exact value]**; `/admin/*` keeps `frame-ancestors 'none'`. The CSP for `/app` must allow `script-src` from Shopify's CDN and our own script file (no inline script); the current admin CSP (`default-src 'none'`) stays as it is. Needed `connect-src`/`style-src` for Polaris: **[verify]**.
- **Browser script:** one small plain `.js` file (browsers do not strip TypeScript, and there is no build step). Its logic is kept tiny (get token, fetch fragment, insert, retry on 401); anything with decisions lives in server TypeScript.

## 4. Authentication details
1. New module `core/embedded/token.ts`: pure `verifySessionToken(token, { clientSecret, clientId, now })` returning `{ shop, userId }` or a refusal reason. Allows only `alg: HS256`; constant-time signature compare; checks `exp`, `nbf` (small clock leeway), `aud`, and that `iss` and `dest` share a host ending in `.myshopify.com`; rejects `alg: none` and malformed input.
2. **Secret:** the same client secret already used for the webhook HMAC (`SHOPIFY_WEBHOOK_SECRET`, with `SHOPIFY_API_SECRET` accepted as an alias in `core/app/env.ts`). **[verify]** that this value is the app's client secret (it is for an app created in the Dev Dashboard, where webhooks are signed with the client secret); if so, no new secret is needed.
3. **New public config:** `SHOPIFY_API_KEY` (the app client id; not a secret) for the `aud` check and the meta tag.
4. **Which shops may use it:** only shops that already have a row in our shops table (added by the operator). A valid token for an unknown shop gets 403, so installing the public app elsewhere does not create a tenant. See decision E1.
5. **Roles:** any staff member whose Shopify user can open the app can use it; `sub` (user id) is written to the audit trail. The LIVE gate (type the word `LIVE`, stored connection required) is unchanged.

## 5. Pages to move (each its own pull request)
1. Home: setup checklist (connection verified? recipe enabled? mode), counts by outcome, and a banner when R1 is live or the kill switch is on.
2. Log and failed jobs, with replay.
3. Salesforce connection (secret never shown back) and Test connection.
4. R1 settings and mode controls.
5. Privacy requests (Compliance record).

## 6. Milestones
- **E0 (this document).** Merged before any code.
- **E1 Skeleton:** `core/embedded/token.ts` (+ tests), the `/app` shell and headers, `SHOPIFY_API_KEY`, `embedded = true` and App URL `/app` in `shopify.app.toml.example`. Done when: opening the app on the dev store shows a page inside Shopify admin; a request without or with a bad token gets 401; an unknown shop gets 403.
- **E2** pages 1 and 2. **E3** pages 3 and 4. **E4** page 5, onboarding copy, empty states, mobile check.
- **E5 Review prep (only if listing):** screenshots, screencast, test instructions, protected-data answers, own self-review checklist.

Tests per step: token verification table (valid; wrong secret; expired; not yet valid; wrong `aud`; `iss`/`dest` mismatch; `alg` none or other; garbage; missing header), route tests for 401/403/200, header tests (`frame-ancestors` per route), escaping tests, then mutation checks on a scratch copy as for earlier work. Real behaviour is checked on the dev store before a step is called done, and the BUILD_PLAN is ticked only for what was seen working.

## 7. Open decisions (owner)
- **E1. Which shops may use the embedded UI?** Recommended: only shops the operator already added. Alternative: auto-create a shop on first valid token (would suit a future hosted product, but lets any installing store become a tenant).
- **E2. Keep the password admin?** Recommended: yes, as the self-host fallback and for operator tasks; it is the same logic behind a different door.
- **E3. Third-party scripts.** Shopify requires App Bridge from its CDN, and Polaris is loaded the same way. That is a supply-chain dependency we cannot vendor for App Bridge. Recommended: accept it, pin Polaris to the stable channel, restrict the CSP to those hosts.
- **E4. Hosted multi-shop product?** Not part of this design. If wanted, it is a separate project (tenancy, credential custody, support, privacy policy) and decides section 4.4.

## 8. Known unknowns
How the very first load of the iframe passes the shop and `host` parameters (the shell relies on the `shop` query parameter, which we validate against a strict pattern and the known-shops list); exact CSP values; whether Polaris needs extra CSP sources; behaviour in the Shopify mobile app. These are checked at E1 and recorded in `docs/research/`.
