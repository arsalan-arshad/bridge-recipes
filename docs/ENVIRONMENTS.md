# Environments: production and staging

**Status: files written, not run.** There is no Docker on the maintainer's machine, so `docker-compose.staging.yml` has not been started
and the steps below have not been tried end to end.

## Production
One Railway service and one Railway PostgreSQL database, used today with a development store. Public database access is off.

## Staging (local, zero hosting cost)
`docker-compose.staging.yml` starts its own PostgreSQL 16 and its own copy of the app on this machine (ports bound to 127.0.0.1).
- **It never touches the production database.** `DATABASE_URL` is written into the compose file and points at the staging container; the
  app container reads only `.env.staging`, which has no database setting, and the production variables are not copied there.
- **Separate secrets.** `.env.staging` uses the client secret of a *separate* Shopify app and a *different* `ENCRYPTION_KEY`.
  (`.env.staging` is git-ignored; `.env.staging.example` lists the names.)
- **Separate Shopify app.** Create a second app in the Dev Dashboard (for example "Bridge Recipes Staging"), install it on a development
  store, and set its App URL and webhook address to a public address that reaches this machine (a tunnel such as `cloudflared tunnel
  --url http://localhost:8787`, or a staging service later). Shopify cannot reach `localhost` by itself.
- **Tests** keep using a local database through `DATABASE_URL` in your untracked `.env`; the repo's tests refuse nothing about the host, so
  keep that value local. CI uses its own throwaway Postgres.

## Not done
- Staging is not a hosted service; it runs while you run it.
- The compose file, the tunnel steps and the second Shopify app have not been tried.
- Today's reviewer and dev-store traffic still goes to production until the dev store's app is pointed at staging.
