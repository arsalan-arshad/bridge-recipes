-- Per-shop recipe settings. A recipe with no row is DISABLED. A newly enabled recipe is dry-run unless dry_run is set to false
-- explicitly (docs/SPEC.md section 8). __SCHEMA__ is replaced by core/queue/migrate.ts (validated identifier).
CREATE TABLE IF NOT EXISTS __SCHEMA__.recipe_config (
  shop        text NOT NULL,
  recipe_id   text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  dry_run     boolean NOT NULL DEFAULT true,
  config      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop, recipe_id)
);
