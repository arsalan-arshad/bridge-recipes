-- One Salesforce connection per shop. The client secret is stored ONLY as AES-256-GCM ciphertext (core/crypto/secretBox.ts);
-- the key lives only in the environment. __SCHEMA__ is replaced by core/queue/migrate.ts (validated identifier).
CREATE TABLE IF NOT EXISTS __SCHEMA__.salesforce_connection (
  shop               text PRIMARY KEY,
  login_url          text NOT NULL,
  client_id          text NOT NULL,
  client_secret_enc  text NOT NULL,
  auth_mode          text NOT NULL DEFAULT 'client_credentials',
  last_verified_at   timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
