# Deploying to Railway (draft, untested end to end)

Status: **written from Railway's documentation, not yet followed on a live deploy.** Items marked UNVERIFIED are not
confirmed in the docs and must be tested. Sources and the date they were read are in
[`docs/research/RAILWAY_FACTS.md`](research/RAILWAY_FACTS.md). Re-check them before relying on this guide.

You run your own copy of the service: Railway hosts it and a PostgreSQL database; Shopify sends webhooks to it; it writes
to your Salesforce org.

## What you need first
- A Railway account on a plan that allows an always-on service (the free allowance is small; an always-on app plus
  Postgres may cost more than it covers). Verify the GitHub account you connect (an unverified trial account has restricted
  outbound network access, which can block calls to Salesforce and Shopify).
- Your copy (fork or the repository) on GitHub, connected to Railway.
- A Shopify app and a Salesforce External Client App (guides to follow). The Salesforce integration user needs a
  full Salesforce licence for the Task path (see the README).

## 1. Create the project
1. New project, **Deploy from GitHub repo**, pick the repository and the `main` branch.
2. Add a **PostgreSQL** database to the same project.
3. Node 24 is selected by the `.node-version` file; `npm start` is detected from `package.json`. There is no build
   script, which should be fine (UNVERIFIED: confirm the build step succeeds with no script).

## 2. Settings of the service (not of the database)
| Setting | Value |
|---|---|
| Start command | `npm start` (default) |
| Healthcheck path | `/healthz` (returns 200 while the process is up; `/readyz` also checks the database) |
| Replicas | **1.** The login limiter and logout list are in memory, and Railway does not use sticky sessions. pg-boss with several replicas is UNVERIFIED. |
| Serverless / sleep | **Off.** A sleeping service can miss webhooks. |
| Wait for CI | **On** (Settings, Deploy). Then Railway deploys `main` only after the GitHub checks pass. |
| Public domain | Networking, **Generate Domain** (Railway does not create one automatically). |

## 3. Variables (service variables; never commit values)
| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`, the private URL. Whether node-postgres needs SSL options is UNVERIFIED; test it. |
| `SHOPIFY_WEBHOOK_SECRET` | the Shopify app's client secret (paste it yourself) |
| `ENCRYPTION_KEY` | 64 hex characters you generate: `openssl rand -hex 32`. Losing it means re-entering the Salesforce credentials. |
| `ADMIN_PASSWORD` | at least 12 characters (leave unset to switch the admin page off) |
| `TRUSTED_PROXY` | `true` (Railway's proxy sends `X-Real-IP`; the login limiter and the Secure cookie use it) |
| `PORT` | set by Railway; the service listens on it |
Optional: `BRIDGE_SCHEMA`, `RETENTION_*`, `PURGE_EVERY_MINUTES`, `WORKER_POLL_SECONDS` (names and defaults in `.env.example`).
The `SF_*` variables are only read by the local `scripts/admin.ts connect` command; on Railway, connect Salesforce from the
admin page instead.

## 4. First start
1. Open `https://<your-domain>/healthz` (expect 200) and `/readyz`.
2. Open `https://<your-domain>/admin`, sign in, connect Salesforce, press **Test connection**.
3. Enable the recipe in **dry-run** and look at the log before going live.
4. Spoof test: send `X-Forwarded-For` and `X-Real-IP` headers with a few wrong passwords and confirm the login limiter
   counts the real client, because Railway's `X-Forwarded-For` behaviour is disputed in the community.

## 5. Point Shopify at it
Copy [`shopify.app.toml.example`](../shopify.app.toml.example) to `shopify.app.toml` (the real file is git-ignored because it carries
your app's client id and host), fill in your client id and name, and set the webhook `uri` to
`https://<your-domain>/webhooks/shopify`. Then run `shopify app deploy` and approve the release. Check that the old store-level webhooks (if any) are removed, or each
order is delivered twice. A real `app/uninstalled` delivery is a safe end-to-end test.

## 6. Versions and deploys
- Merging a pull request to `main` publishes a GitHub Release for the version in `package.json` (see `CONTRIBUTING.md`).
- Railway deploys `main` through its own GitHub integration; `.github/workflows/deploy-check.yml` then polls
  `<PRODUCTION_URL>/healthz` when you set the repository variable `PRODUCTION_URL`.

## Known limits
Single replica; one shared admin password; no automatic rollback beyond Railway's own redeploy of a previous deployment.
