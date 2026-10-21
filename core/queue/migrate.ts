// Applies db/migrations/*.sql (idempotent: every statement is IF NOT EXISTS). pg-boss migrates its own tables.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertSchemaName(schema: string): string {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${schema}`);
  return schema;
}

export async function migrate(pool: { query(text: string): Promise<unknown> }, schema: string): Promise<void> {
  assertSchemaName(schema);
  const dir = join(import.meta.dirname, '..', '..', 'db', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(join(dir, file), 'utf8').replaceAll('__SCHEMA__', schema));
  }
}
