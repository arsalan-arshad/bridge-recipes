-- Audit trail of operator actions in the admin UI. Never holds secrets, payloads or customer data; `detail` is a short
-- fixed-vocabulary note (for example "mode=live"). __SCHEMA__ is replaced by core/queue/migrate.ts (validated identifier).
CREATE TABLE IF NOT EXISTS __SCHEMA__.admin_audit (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL,
  action  text NOT NULL,
  shop    text,
  detail  text
);
CREATE INDEX IF NOT EXISTS admin_audit_at_idx ON __SCHEMA__.admin_audit (at);
