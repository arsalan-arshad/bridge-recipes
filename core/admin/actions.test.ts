import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipeAction, saveConfig, saveConnection, verifyConnection } from './actions.ts';
import type { ActionDeps } from './actions.ts';
import { ConfigValidationError } from '../../recipes/retail-b2b-lead-spotter/validateConfig.ts';
import { MemoryConnectionStore } from '../salesforce/connectionStore.ts';
import type { RecipeSettings } from '../worker/recipe.ts';

const SHOP = 'demo-shop.myshopify.com';
const form = (o: Record<string, string>) => new Map(Object.entries(o));

function setup(opts: { verify?: ActionDeps['verify']; settings?: RecipeSettings | null; stored?: boolean } = {}) {
  const store = new Map<string, RecipeSettings>();
  if (opts.settings) store.set(`${SHOP}|R`, opts.settings);
  const connections = new MemoryConnectionStore();
  const writes: string[] = [];
  const conn = {
    get: (s: string) => connections.get(s),
    put: async (s: string, c: any) => { writes.push('put'); await connections.put(s, c); },
    markVerified: (s: string, at: Date) => connections.markVerified(s, at),
    info: async (s: string) => ({ stored: opts.stored !== undefined ? opts.stored : (await connections.get(s)) !== null }),
  };
  const deps: ActionDeps = {
    recipe: {
      id: 'R', defaultConfig: { minOrderTotal: 0 },
      validate: (c: any) => { if (c.bad) throw new ConfigValidationError(['minOrderTotal is bad']); return c; },
      fromForm: (f) => ({ bad: f.get('minOrderTotal') === 'x', minOrderTotal: f.get('minOrderTotal') }),
    },
    connections: conn as any,
    configs: {
      get: async (s, r) => store.get(`${s}|${r}`) ?? null,
      set: async (s, r, v) => { writes.push('config'); store.set(`${s}|${r}`, { enabled: v.enabled, dryRun: v.dryRun ?? true, config: v.config }); },
      disable: async (s, r) => { const cur = store.get(`${s}|${r}`); if (!cur) return false; store.set(`${s}|${r}`, { ...cur, enabled: false }); return true; },
    },
    verify: opts.verify ?? (async () => ({ ok: true })),
  };
  return { deps, store, writes };
}

test('go live needs the exact word LIVE AND a stored connection; otherwise nothing is written', async () => {
  for (const confirm of ['', 'live', 'Live', ' LIVE', 'LIVE ', 'YES', 'LIVE!']) {
    const { deps, writes } = setup({ stored: true });
    assert.deepEqual(await recipeAction(deps, SHOP, form({ action: 'go_live', confirm })), { ok: false, status: 400, kind: 'settings', errors: ['to go live, type LIVE in the confirmation box'] }, JSON.stringify(confirm));
    assert.deepEqual(writes, []);
  }
  const none = setup({ stored: false });
  assert.deepEqual(await recipeAction(none.deps, SHOP, form({ action: 'go_live', confirm: 'LIVE' })), { ok: false, status: 400, kind: 'settings', errors: ['connect Salesforce first: there is nothing to write to'] });
  assert.deepEqual(none.writes, []);
  const ok = setup({ stored: true });
  assert.deepEqual(await recipeAction(ok.deps, SHOP, form({ action: 'go_live', confirm: 'LIVE' })), { ok: true, msg: 'live', audit: { action: 'recipe_live' } });
  assert.deepEqual(ok.store.get(`${SHOP}|R`), { enabled: true, dryRun: false, config: { minOrderTotal: 0 } });
});

test('enable-in-dry-run and the kill switch keep the stored settings, and only change the mode', async () => {
  const s = setup({ settings: { enabled: false, dryRun: false, config: { minOrderTotal: '50' } } });
  assert.deepEqual(await recipeAction(s.deps, SHOP, form({ action: 'enable_dry' })), { ok: true, msg: 'enabled_dry', audit: { action: 'recipe_dry_run' } });
  assert.deepEqual(s.store.get(`${SHOP}|R`), { enabled: true, dryRun: true, config: { minOrderTotal: '50' } });
  assert.deepEqual(await recipeAction(s.deps, SHOP, form({ action: 'disable' })), { ok: true, msg: 'disabled', audit: { action: 'recipe_disabled' } });
  assert.equal(s.store.get(`${SHOP}|R`)?.enabled, false);
  assert.deepEqual(s.store.get(`${SHOP}|R`)?.config, { minOrderTotal: '50' });
});

test('with no settings yet, enabling uses the recipe defaults; unknown or missing actions are refused and write nothing', async () => {
  const s = setup();
  await recipeAction(s.deps, SHOP, form({ action: 'enable_dry' }));
  assert.deepEqual(s.store.get(`${SHOP}|R`), { enabled: true, dryRun: true, config: { minOrderTotal: 0 } });
  const t = setup();
  for (const action of ['', 'go-live', 'GO_LIVE', 'delete', undefined]) {
    assert.deepEqual(await recipeAction(t.deps, SHOP, form(action === undefined ? {} : { action })), { ok: false, status: 400, kind: 'bad_request' }, String(action));
  }
  assert.deepEqual(t.writes, []);
});

test('saving settings changes ONLY the settings: the mode (live or dry-run, on or off) is untouched', async () => {
  for (const mode of [{ enabled: true, dryRun: false }, { enabled: true, dryRun: true }, { enabled: false, dryRun: true }]) {
    const s = setup({ settings: { ...mode, config: { minOrderTotal: '1' } } });
    assert.deepEqual(await saveConfig(s.deps, SHOP, form({ minOrderTotal: '75' })), { ok: true, msg: 'config_saved', audit: { action: 'config_saved' } });
    assert.deepEqual(s.store.get(`${SHOP}|R`), { ...mode, config: { bad: false, minOrderTotal: '75' } }, JSON.stringify(mode));
  }
  const fresh = setup();
  await saveConfig(fresh.deps, SHOP, form({ minOrderTotal: '5' }));
  assert.deepEqual([fresh.store.get(`${SHOP}|R`)?.enabled, fresh.store.get(`${SHOP}|R`)?.dryRun], [false, true], 'a first save never turns the recipe on');
});

test('invalid settings are refused with the problems and an echo of the form (no csrf field), and nothing is stored', async () => {
  const s = setup({ settings: { enabled: true, dryRun: false, config: { minOrderTotal: '1' } } });
  const out = await saveConfig(s.deps, SHOP, form({ minOrderTotal: 'x', csrf: 'token', requireConsent: 'on' }));
  assert.deepEqual(out, { ok: false, status: 422, kind: 'settings', errors: ['minOrderTotal is bad'], echo: { minOrderTotal: 'x', requireConsent: true } });
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.store.get(`${SHOP}|R`)?.config, { minOrderTotal: '1' });
  const off = await saveConfig(setup().deps, SHOP, form({ minOrderTotal: 'x' }));
  assert.equal((off as any).echo.requireConsent, false);
});

test('an unexpected error while saving settings is not swallowed', async () => {
  const s = setup();
  s.deps.recipe.validate = () => { throw new Error('boom'); };
  await assert.rejects(() => saveConfig(s.deps, SHOP, form({ minOrderTotal: '1' })), /boom/);
});

test('connection: saved only when valid, otherwise the problem is returned and nothing is stored; the secret is never in the outcome', async () => {
  const s = setup();
  const good = await saveConnection(s.deps, SHOP, form({ loginUrl: 'https://acme.my.salesforce.com', clientId: ' id-1 ', clientSecret: 'TOP-SECRET-VALUE' }));
  assert.deepEqual(good, { ok: true, msg: 'connection_saved', audit: { action: 'connection_saved' } });
  assert.equal((await s.deps.connections.get(SHOP))?.clientId, 'id-1', 'the id is trimmed');
  assert.ok(!JSON.stringify(good).includes('TOP-SECRET-VALUE'));
  for (const bad of [
    { loginUrl: 'https://evil.example.com', clientId: 'a', clientSecret: 'b' },
    { loginUrl: 'ftp://acme.my.salesforce.com', clientId: 'a', clientSecret: 'b' },
    { loginUrl: 'https://acme.my.salesforce.com', clientId: '', clientSecret: 'b' },
    { loginUrl: 'https://acme.my.salesforce.com', clientId: 'a', clientSecret: '' },
    {},
  ]) {
    const t = setup();
    const out = await saveConnection(t.deps, SHOP, form(bad));
    assert.equal(out.ok, false);
    assert.equal((out as any).kind, 'connection');
    assert.equal((out as any).status, 400);
    assert.deepEqual(t.writes, [], JSON.stringify(bad));
    assert.ok(!JSON.stringify(out).includes('"b"'));
  }
});

test('test connection: ok is audited as verified; a failure keeps its reason in the message and is audited as failed', async () => {
  assert.deepEqual(await verifyConnection(setup().deps, SHOP), { ok: true, msg: 'verified_ok', audit: { action: 'connection_verified' } });
  const bad = setup({ verify: async () => ({ ok: false, reason: 'invalid_client' }) });
  assert.deepEqual(await verifyConnection(bad.deps, SHOP), { ok: false, status: 200, kind: 'connection', message: 'Connection check failed: invalid_client', audit: { action: 'connection_failed', detail: 'invalid_client' } });
});
