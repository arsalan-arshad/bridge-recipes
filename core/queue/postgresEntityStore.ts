import { assertSchemaName } from './migrate.ts';
import type { EntityRecord, EntityStore } from '../executor/entityStore.ts';

export class PostgresEntityStore implements EntityStore {
  private readonly pool: { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };
  private readonly schema: string;
  constructor(pool: PostgresEntityStore['pool'], schema: string) {
    this.pool = pool;
    this.schema = assertSchemaName(schema);
  }
  async get(matchKey: string): Promise<EntityRecord | null> {
    const r = await this.pool.query(`SELECT sf_type, sf_id FROM ${this.schema}.entity_map WHERE match_key = $1`, [matchKey]);
    return r.rows[0] ? { type: r.rows[0].sf_type, id: r.rows[0].sf_id } : null;
  }
  async put(matchKey: string, rec: EntityRecord, shop: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.entity_map (match_key, sf_type, sf_id, shop) VALUES ($1, $2, $3, $4) ON CONFLICT (match_key) DO NOTHING`,
      [matchKey, rec.type, rec.id, shop],
    );
  }
}
