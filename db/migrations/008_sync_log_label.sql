-- A display name for the object a decision was about (an order number such as #1020), so the log is readable.
-- Never personal data. Additive and nullable: old rows keep showing the id. __SCHEMA__ is replaced by core/queue/migrate.ts.
ALTER TABLE __SCHEMA__.sync_log ADD COLUMN IF NOT EXISTS object_label text;
