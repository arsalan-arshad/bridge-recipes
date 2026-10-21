-- Gateway intake: one row per accepted delivery. Unique on BOTH the delivery id and the business key, so
-- an insert that hits either constraint means "duplicate". The raw payload is NOT stored here; it lives only in
-- the queue job (deleted after completion). __SCHEMA__ is replaced by core/queue/migrate.ts (validated identifier).
CREATE SCHEMA IF NOT EXISTS __SCHEMA__;

CREATE TABLE IF NOT EXISTS __SCHEMA__.webhook_intake (
  webhook_id   text PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  topic        text NOT NULL,
  shop         text NOT NULL,
  received_at  timestamptz NOT NULL
);
