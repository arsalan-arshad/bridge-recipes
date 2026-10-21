// Per-shop recipe settings in Postgres. Each recipe supplies its own config validator; an invalid stored config is treated as
// "recipe disabled" (fail closed), never as defaults.

import { assertSchemaName } from './migrate.ts';
import type { ConfigStore, RecipeSettings } from '../worker/recipe.ts';

type Pool = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };
export type Validator = (config: unknown) => unknown;

export class PostgresConfigStore implements ConfigStore {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly validators: Record<string, Validator>;
  private readonly onInvalid: (shop: string, recipeId: string) => void;
  constructor(pool: Pool, schema: string, validators: Record<string, Validator>, onInvalid: (shop: string, recipeId: string) => void = () => {}) {
    this.pool = pool;
    this.schema = assertSchemaName(schema);
    this.validators = validators;
    this.onInvalid = onInvalid;
  }

  async get(shop: string, recipeId: string): Promise<RecipeSettings | null> {
    const validate = this.validators[recipeId];
    if (!validate) return null;
    const r = await this.pool.query(`SELECT enabled, dry_run, config FROM ${this.schema}.recipe_config WHERE shop = $1 AND recipe_id = $2`, [shop, recipeId]);
    const row = r.rows[0];
    if (!row) return null;
    try {
      return { enabled: row.enabled === true, dryRun: row.dry_run !== false, config: validate(row.config) };
    } catch {
      this.onInvalid(shop, recipeId);
      return null;
    }
  }

  // Validates BEFORE storing; a new recipe is dry-run unless dryRun is explicitly false.
  async set(shop: string, recipeId: string, s: { enabled: boolean; dryRun?: boolean; config: unknown }): Promise<void> {
    const validate = this.validators[recipeId];
    if (!validate) throw new Error(`unknown recipe ${recipeId}`);
    const config = validate(s.config);
    await this.pool.query(
      `INSERT INTO ${this.schema}.recipe_config (shop, recipe_id, enabled, dry_run, config) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (shop, recipe_id) DO UPDATE SET enabled = EXCLUDED.enabled, dry_run = EXCLUDED.dry_run, config = EXCLUDED.config, updated_at = now()`,
      [shop, recipeId, s.enabled, s.dryRun !== false, JSON.stringify(config)],
    );
  }

  async disable(shop: string, recipeId: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE ${this.schema}.recipe_config SET enabled = false, updated_at = now() WHERE shop = $1 AND recipe_id = $2`, [shop, recipeId]);
    return (r.rowCount ?? 0) > 0;
  }
}
