import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSchemaName, migrate } from './migrate.ts';

test('valid schema names are accepted', () => {
  for (const ok of ['bridge', 'bridge_t_ab12cd34', '_x', 'a1']) assert.equal(assertSchemaName(ok), ok);
});

test('anything that could carry SQL is rejected', () => {
  for (const bad of ['', 'Bridge', '1abc', 'a-b', 'a b', 'a;drop table x', 'a"b', "a'b", 'a.b', 'x'.repeat(64), 'bridge; --']) {
    assert.throws(() => assertSchemaName(bad), /invalid schema name/, JSON.stringify(bad));
  }
});

test('migrate refuses an invalid schema before running any SQL', async () => {
  const sql: string[] = [];
  await assert.rejects(() => migrate({ query: async (t) => void sql.push(t) }, 'bad; drop'), /invalid schema name/);
  assert.equal(sql.length, 0);
});

test('migrate substitutes the schema in every migration and leaves no placeholder', async () => {
  const sql: string[] = [];
  await migrate({ query: async (t) => void sql.push(t) }, 'bridge_x');
  assert.ok(sql.length >= 2, 'both migrations ran');
  for (const s of sql) {
    assert.ok(!s.includes('__SCHEMA__'));
    assert.ok(s.includes('bridge_x.'));
  }
  const all = sql.join('\n');
  assert.ok(all.includes('bridge_x.webhook_intake'));
  assert.ok(all.includes('bridge_x.entity_map'));
});

test('migrations run in file order', async () => {
  const sql: string[] = [];
  await migrate({ query: async (t) => void sql.push(t) }, 'bridge_x');
  assert.ok(sql[0].includes('webhook_intake') && sql[1].includes('entity_map'));
});
