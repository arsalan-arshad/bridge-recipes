import { assertSchemaName } from './migrate.ts';
import { decrypt, encrypt } from '../crypto/secretBox.ts';
import type { ConnectionStore, SalesforceConnection } from '../salesforce/connectionStore.ts';

type Pool = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

export class PostgresConnectionStore implements ConnectionStore {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly key: Buffer;
  constructor(pool: Pool, schema: string, key: Buffer) {
    this.pool = pool;
    this.schema = assertSchemaName(schema);
    this.key = key;
  }
  // The shop is part of what GCM authenticates: a secret copied onto another shop's row will not decrypt.
  private aad(shop: string) {
    return `salesforce_connection|client_secret|${shop}`;
  }
  async get(shop: string): Promise<SalesforceConnection | null> {
    const r = await this.pool.query(`SELECT login_url, client_id, client_secret_enc FROM ${this.schema}.salesforce_connection WHERE shop = $1`, [shop]);
    const row = r.rows[0];
    if (!row) return null;
    return { loginUrl: row.login_url, clientId: row.client_id, clientSecret: decrypt(row.client_secret_enc, this.key, this.aad(shop)) };
  }
  async put(shop: string, c: SalesforceConnection): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.salesforce_connection (shop, login_url, client_id, client_secret_enc)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop) DO UPDATE SET login_url = EXCLUDED.login_url, client_id = EXCLUDED.client_id,
         client_secret_enc = EXCLUDED.client_secret_enc, updated_at = now(), last_verified_at = NULL`,
      [shop, c.loginUrl, c.clientId, encrypt(c.clientSecret, this.key, this.aad(shop))],
    );
  }
  // Status for the admin UI: never decrypts, so it works (and reports) even when the encryption key is wrong.
  async info(shop: string): Promise<{ stored: boolean; loginUrl?: string; clientId?: string; lastVerifiedAt: string | null }> {
    const r = await this.pool.query(`SELECT login_url, client_id, last_verified_at FROM ${this.schema}.salesforce_connection WHERE shop = $1`, [shop]);
    const row = r.rows[0];
    if (!row) return { stored: false, lastVerifiedAt: null };
    return { stored: true, loginUrl: row.login_url, clientId: row.client_id, lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null };
  }
  async markVerified(shop: string, at: Date): Promise<void> {
    await this.pool.query(`UPDATE ${this.schema}.salesforce_connection SET last_verified_at = $2 WHERE shop = $1`, [shop, at.toISOString()]);
  }
}
