-- EntityMap: matchKey -> the Salesforce record already written for it (makes retried jobs idempotent).
-- Holds ids only: no personal data. __SCHEMA__ is replaced by core/queue/migrate.ts (validated identifier).
CREATE TABLE IF NOT EXISTS __SCHEMA__.entity_map (
  match_key  text PRIMARY KEY,
  sf_type    text NOT NULL,
  sf_id      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
