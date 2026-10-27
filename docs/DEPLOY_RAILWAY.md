# Deploying Bridge Recipes to Railway

You run your own copy of the service. Railway hosts it and a PostgreSQL database; Shopify sends order webhooks to it; it decides
what to do with each order and, only when you switch it live, writes Leads and Tasks to your own Salesforce org. Nothing here is a
hosted service for other people: the maintainer's deployment is a development example.

**Status.** This guide was followed on a live deployment on 2026-10-26 and 2026-10-27. What was actually seen working, and what
was not, is listed in [What is verified](#what-is-verified-and-what-is-not) at the end. Railway's dashboard labels change; where a
step depends on a Railway feature, the source is cited and was read on the date shown in
[`docs/research/RAILWAY_FACTS.md`](research/RAILWAY_FACTS.md). Re-check prices and plan limits yourself.

## Before you start
- A **Railway account** on a plan that keeps an always-on service running, with the GitHub account you connect verified (Railway
  restricts outbound network access for unverified trial accounts, which can block calls to Salesforce and Shopify).
- **Your copy of this repository on GitHub** (a fork, or the repository itself), connected to Railway.
- A **Shopify app** in the Dev Dashboard (you need its client id and client secret) and the Shopify CLI on your computer.
- A **Salesforce org** with an External Client App for the client-credentials flow (never a Connected App), a dedicated integration
  user and a narrow permission set: follow [`SETUP_SALESFORCE.md`](SETUP_SALESFORCE.md). The integration user needs a full Salesforce
  licence for the Task path.
- Your own **admin password** (12 characters or more) and an **encryption key** you generate: `openssl rand -hex 32`.
  Keep the key somewhere safe outside Railway; without it the stored Salesforce credentials cannot be read again.

## 1. Create the project
1. In Railway: **New project, Deploy from GitHub repo**, choose your repository and the `main` branch.
2. In the same project add a **PostgreSQL** database.
3. Nothing needs configuring for the build: there is no build step (`npm start` runs `node core/app/main.ts`, TypeScript is run
   directly by Node), and `.node-version` asks for Node 24. If a build ever picks an older Node, set the service variable
   `RAILPACK_NODE_VERSION=24` (Railway's Railpack reads it). The service needs a Node that can run TypeScript files directly.
4. The service creates its own tables on every start (it runs its migrations in a schema called `bridge`, plus pg-boss's tables).
   You do not run any migration yourself.

## 2. Service settings (on the app service, not the database)
| Setting | Value | Why |
|---|---|---|
| Start command | `npm start` (the default) | |
| Healthcheck path | `/healthz` | Returns 200 while the process is up. `/readyz` also checks the database and answers 503 while shutting down. |
| Replicas | **1** | The admin login limiter and logout list live in memory, and Railway has no sticky sessions (Railway docs). Several replicas of pg-boss were not tested. |
| Serverless / sleep | **Off** | A sleeping service can miss webhooks (Railway docs). |
| Public domain | Networking, **Generate Domain** | Railway does not create one for you. Your webhook address will be `https://<your-domain>/webhooks/shopify`. |

## 3. Variables (on the app service; never commit values)
| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a reference to the database service). Railway's docs recommend the private URL; the public one is billed as egress. The service sets no SSL options of its own: whichever URL you use, `/readyz` must answer 200 (that proves the database connection). |
| `SHOPIFY_WEBHOOK_SECRET` | the Shopify app's **client secret**. Paste it yourself. It also verifies the sign-in token of the embedded app. (`SHOPIFY_API_SECRET` is accepted as an alternative name.) |
| `SHOPIFY_API_KEY` | the Shopify app's **client id** (public, not a secret). Set it to switch ON the embedded page inside the Shopify admin. Without it, `/app` does not exist. |
| `ENCRYPTION_KEY` | your 64 hex characters. |
| `ADMIN_PASSWORD` | 12 characters or more. Leave it unset and the operator admin page is switched off, **and you cannot go live** (going live is only possible there). |
| `TRUSTED_PROXY` | `true` on Railway. Railway's proxy sets `X-Real-IP`, which the login limiter then uses; the session cookie is marked Secure. |
| `PORT` | set by Railway; the service listens on it. |

Optional, with defaults: `BRIDGE_SCHEMA` (`bridge`), `RETENTION_SYNC_LOG_DAYS` (30), `RETENTION_INTAKE_DAYS` (14),
`RETENTION_ENTITY_MAP_DAYS` (30), `RETENTION_COMPLIANCE_DAYS` (365), `PURGE_EVERY_MINUTES` (360), `WORKER_POLL_SECONDS` (2). The `SF_*` variables in
`.env.example` are only read by the local `scripts/admin.ts` commands; on Railway you connect Salesforce from the app, not from a
variable.

## 4. First start: check it from outside
Replace `<your-domain>`. None of these need a password.
```
curl -i https://<your-domain>/healthz                    # expect 200
curl -i https://<your-domain>/readyz                     # expect 200 (the database answers)
curl -i -X POST https://<your-domain>/webhooks/shopify   # expect 401 (an unsigned request is refused)
```
If `/readyz` is 503, the database is unreachable: check `DATABASE_URL`. If the deployment fails to start, the Railway log shows
`config_invalid` followed by the NAMES of the problem variables (values are never printed).

## 5. Point Shopify at it
1. Copy [`shopify.app.toml.example`](../shopify.app.toml.example) to `shopify.app.toml`. The real file is git-ignored because it
   carries your client id and host; never commit it.
2. Fill in `client_id`, `name`, and replace `<your-host>` with your Railway domain (two places: the App URL, which ends in `/app`, and
   the webhook address, which ends in `/webhooks/shopify`).
3. The example already asks for **one scope only, `read_orders`**, subscribes to `orders/paid` and `app/uninstalled`, and declares
   the three privacy webhooks. Do not add scopes without a reason. The customer's name and email that come with an order also
   need Shopify's protected customer data access, a separate Shopify step (see the comment in the example). On the maintainer's
   development store the orders arrived with what R1 needs; check Shopify's current rules before using a real store.
4. Run `shopify app deploy` and approve the release (it is interactive). Shopify shows the new version as Active in the Dev
   Dashboard.
5. If the store has older **store-level** webhooks for the same topics, remove them, or every order arrives twice.

## 6. Tell the service which store is yours
The embedded page and the controls only open for a store the operator has set up (otherwise any store that installs a public app
could open it).
1. Open `https://<your-domain>/admin` and sign in with `ADMIN_PASSWORD`.
2. **Add a shop**: enter `<your-store>.myshopify.com`.
3. Install your app on that store (the Dev Dashboard shows how to install a development app on a store), then open it from the Shopify
   admin's Apps list. It opens inside the admin on the **home page**.

## 7. Connect Salesforce, then watch it in dry-run
Everything in this step can be done inside the Shopify app (the **Set up** page) or on `/admin`.
1. **Connect Salesforce**: your My Domain URL (`https://<yourdomain>.my.salesforce.com`), the External Client App's consumer key
   and consumer secret. The secret is stored encrypted and is never shown again.
2. Press **Test connection**. It must say the connection works.
3. **Enable the recipe in dry-run.** Dry-run reads from Salesforce and records what it WOULD do, but writes nothing.
4. Place a paid test order in the store. The decision appears under **Latest decisions**. The home page's "Get started" checklist
   turns into "Setup complete" when you have connected, tested, enabled and seen a decision.
5. Read the reasons you get: `no_email`, `free_or_denied_domain`, `below_minimum`, `no_consent` (the customer did not accept
   marketing; consent is required by default), `existing_lead_skipped`. A `createLead: planned` row means a Lead WOULD be created.

**Going live is deliberate and only on `/admin`**: type the word `LIVE` on the shop's page (it needs the stored connection). From
the Shopify app you can only connect, test, run in dry-run, change settings, replay failed jobs, and switch the recipe off (the
kill switch). Switch live only after you have read several dry-run decisions.

## 8. Operating it
- **Kill switch:** "Kill switch: disable" on the Set up page or `/admin`. The next job makes no Salesforce calls.
- **Failed jobs:** a job that fails all its retries waits under **Failed jobs**. Fix the cause (usually the Salesforce
  connection), then **Replay**. Payloads are kept 14 days and are never shown.
- **Updating:** merge to `main`. Railway's GitHub integration builds and deploys `main`; it took about three to four minutes after a
  merge on the maintainer's deployment. A stopped container shuts down gracefully (it finishes the job it is running).
- **Checking a deploy:** `.github/workflows/deploy-check.yml` polls `<PRODUCTION_URL>/healthz` after CI passes on `main`. Set the
  repository variable `PRODUCTION_URL` to `https://<your-domain>` (Settings, Secrets and variables, Actions, Variables). It
  only reports; it does not deploy or roll back.
- **Wait for CI:** on the maintainer's service Railway's "Wait for CI" option was not offered, so a deploy can start before GitHub's
  checks finish. What keeps broken code out of `main` is GitHub's branch protection (required checks, pull requests only). Turn
  on "Wait for CI" if your Railway service offers it.
- **Rolling back:** redeploy an earlier deployment from Railway's deployments list (not tried here). The database schema only
  moves forward, so prefer rolling forward with a fix.
- **Logs:** the Railway log is one JSON line per event (a webhook accepted or refused, the worker, purges). Values under keys that look
  like secrets or payloads are replaced with `[redacted]`, and email addresses in text are masked.
- **Retention:** the decision log is kept 30 days, the delivery record 14, the order-to-Salesforce map 30 and the privacy-request
  record 365 (change with the `RETENTION_*` variables).

## 9. Security checklist
- Every secret is a Railway variable; none is in the repository, in a screenshot, or in a chat. If one leaks, rotate it: the Shopify
  client secret (Dev Dashboard), the admin password, and the Salesforce consumer secret (replace the connection).
  There is no key rotation for `ENCRYPTION_KEY`: changing it means entering the Salesforce credentials again.
- `ADMIN_PASSWORD` is long and unique; the page is behind HTTPS only (Railway terminates TLS).
- `TRUSTED_PROXY=true` only because Railway's proxy sits in front. After deploying, send a few wrong passwords with made-up
  `X-Forwarded-For` / `X-Real-IP` headers and confirm the limiter counts the real client (this test has not been done yet; see
  below). Railway's documentation does not describe `X-Forwarded-For`, which is why the service prefers `X-Real-IP`.
- The Shopify app asks for **`read_orders` only**; the Salesforce integration user should have only what the recipe needs.
- The service cannot delete in Salesforce, by design. The **Privacy requests** page lists the Salesforce records you should review
  after a customer or shop erasure request.

## 10. Troubleshooting
| Symptom | Likely cause and fix |
|---|---|
| Build or start fails | Node too old: set `RAILPACK_NODE_VERSION=24`. A required variable is missing or malformed: the log names it (`config_invalid`). |
| `/readyz` is 503 | The database URL is wrong, or the database service is down. |
| Shopify shows webhook failures | The App URL or webhook address is wrong, the service was asleep, or `SHOPIFY_WEBHOOK_SECRET` is not the app's client secret (the service then answers 401). |
| Orders arrive but nothing is logged | The recipe is not enabled for the shop, or the shop was never added (section 6). A `recipe_disabled` entry means exactly that. |
| The app opens a blank page or "not set up" in Shopify | `SHOPIFY_API_KEY` is not set, the App URL is not `https://<your-domain>/app`, or the shop has not been added on `/admin`. |
| Nothing to click in the embedded page | Ad blockers can block Shopify's sign-in script; try another browser window. |
| Test connection fails | Use the My Domain URL (not the generic login host), the External Client App's key and secret, and the client-credentials flow with a Run As user. |
| Every order is processed twice | Old store-level webhooks still exist (section 5, step 5). |

## What is verified, and what is not
Seen working on the maintainer's live deployment (2026-10-26 and 2026-10-27, by screenshots, the Dev Dashboard and `curl`):
the service builds with no build script and starts; `/healthz` and `/readyz` answer 200; an unsigned webhook is refused with 401;
the operator sign-in; the Shopify app version released with the Railway address (webhooks, the three privacy topics, scope
`read_orders`); a real signed `app/uninstalled` and a real signed `orders/paid` were accepted; R1 in dry-run produced
`createLead: planned` and `skipped / no_consent`; the embedded app (home, log, setup, settings, failed jobs, privacy requests)
opened inside the Shopify admin; a settings save and a connection test worked from there; merges to `main` redeployed
automatically.

**Not verified:** a live Salesforce write from Railway; a real `customers/redact`, `customers/data_request` or `shop/redact`
delivery (the last is expected about 48 hours after an uninstall); replay of a real failed job; the `X-Forwarded-For` spoof test
above; which exact Node version Railway selected; behaviour with more than one replica; rolling back; backups of the database
(use Railway's own backup feature if your plan has one, or `pg_dump`; the database holds settings, the encrypted Salesforce
credentials, the decision log and the audit trail).
