-- M4 compliance support. __SCHEMA__ is replaced by core/queue/migrate.ts (validated identifier).
--
-- 1. entity_map gets a shop column, so shop/redact can delete ONE shop's mappings precisely (match keys hold order ids only).
ALTER TABLE __SCHEMA__.entity_map ADD COLUMN IF NOT EXISTS shop text;
CREATE INDEX IF NOT EXISTS entity_map_shop_idx ON __SCHEMA__.entity_map (shop);
-- Backfill rows written before this migration, using the sync log's order id -> shop link (rows with no match stay NULL).
UPDATE __SCHEMA__.entity_map e SET shop = s.shop
  FROM (SELECT DISTINCT object_id, shop FROM __SCHEMA__.sync_log) s
  WHERE e.shop IS NULL AND s.object_id = substring(e.match_key FROM position(':' IN e.match_key) + 1);

-- 2. Record of compliance requests handled. Holds NO personal data: kinds, shop, counts, opaque Salesforce record ids and a
--    masked report. It is the merchant's evidence, and tells them which Salesforce records to review after a redaction
--    (this app has no permission to delete in Salesforce, by design).
CREATE TABLE IF NOT EXISTS __SCHEMA__.compliance_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  kind        text NOT NULL,
  shop        text NOT NULL,
  request_ref text NOT NULL,
  detail      jsonb NOT NULL,
  UNIQUE (kind, request_ref) -- a retried job must not record the same request twice
);
CREATE INDEX IF NOT EXISTS compliance_log_at_idx ON __SCHEMA__.compliance_log (at);
CREATE INDEX IF NOT EXISTS compliance_log_shop_idx ON __SCHEMA__.compliance_log (shop);
