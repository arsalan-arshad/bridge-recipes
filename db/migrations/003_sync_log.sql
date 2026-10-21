-- Sync log (docs/SPEC.md section 5): one row per processed job. Minimum personal data: ids, outcome codes, masked planned
-- ops. NO payload, NO customer id (customers/redact deletes by order id from objects, see docs/SPEC.md section 6).
-- __SCHEMA__ is replaced by core/queue/migrate.ts (validated identifier).
CREATE TABLE IF NOT EXISTS __SCHEMA__.sync_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  shop        text NOT NULL,
  recipe_id   text NOT NULL,
  topic       text NOT NULL,
  object_id   text NOT NULL,
  webhook_id  text NOT NULL,
  outcome     text NOT NULL,
  dry_run     boolean NOT NULL,
  reason      text,
  error_class text,
  error_code  text,
  ops         jsonb
);
CREATE INDEX IF NOT EXISTS sync_log_at_idx ON __SCHEMA__.sync_log (at);
CREATE INDEX IF NOT EXISTS sync_log_shop_at_idx ON __SCHEMA__.sync_log (shop, at DESC);
CREATE INDEX IF NOT EXISTS sync_log_object_idx ON __SCHEMA__.sync_log (object_id);
