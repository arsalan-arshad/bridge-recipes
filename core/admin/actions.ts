// The write actions on a shop, shared by the operator admin (/admin) and the embedded page (/app) so that rules such as the LIVE
// gate exist exactly once. Each action returns a plain outcome; the caller decides how to show it (redirect, page, fragment) and
// records the audit entry. Secrets are inputs only: nothing here ever returns one.

import { AdminError, connectShop } from '../app/admin.ts';
import { ConfigValidationError } from '../../recipes/retail-b2b-lead-spotter/validateConfig.ts';
import type { ConnectionStore } from '../salesforce/connectionStore.ts';
import type { RecipeSettings } from '../worker/recipe.ts';
import type { SetupResult } from '../salesforce/checkSetup.ts';

export interface ActionRecipe {
  id: string;
  defaultConfig: unknown;
  validate(config: unknown): any;
  fromForm(form: Map<string, string>): unknown;
}

export interface ActionDeps {
  recipe: ActionRecipe;
  connections: ConnectionStore & { info(shop: string): Promise<{ stored: boolean }> };
  configs: {
    get(shop: string, recipeId: string): Promise<RecipeSettings | null>;
    set(shop: string, recipeId: string, s: { enabled: boolean; dryRun?: boolean; config: unknown }): Promise<void>;
    disable(shop: string, recipeId: string): Promise<boolean>;
  };
  verify(shop: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  check(shop: string): Promise<SetupResult | { ok: false; reason: 'no_connection' }>; // read-only Salesforce permission check
}

export interface AuditNote {
  action: string;
  detail?: string;
}

// ok: it happened (msg is a message code); not ok: nothing changed (except an audit note for a failed connection test).
export type ActionOutcome =
  | { ok: true; msg: string; audit: AuditNote }
  | { ok: false; status: 400 | 422; kind: 'bad_request' }
  | { ok: false; status: 400 | 200; kind: 'connection'; message: string; audit?: AuditNote }
  | { ok: false; status: 400 | 422; kind: 'settings'; errors: string[]; echo?: Record<string, string | boolean> };

export async function saveConnection(deps: ActionDeps, shop: string, form: Map<string, string>): Promise<ActionOutcome> {
  try {
    await connectShop(deps.connections, shop, { loginUrl: form.get('loginUrl') ?? '', clientId: (form.get('clientId') ?? '').trim(), clientSecret: form.get('clientSecret') ?? '' });
  } catch (e) {
    if (e instanceof AdminError) return { ok: false, status: 400, kind: 'connection', message: e.message };
    throw e;
  }
  return { ok: true, msg: 'connection_saved', audit: { action: 'connection_saved' } };
}

export async function verifyConnection(deps: ActionDeps, shop: string): Promise<ActionOutcome> {
  const r = await deps.verify(shop);
  if (r.ok) return { ok: true, msg: 'verified_ok', audit: { action: 'connection_verified' } };
  return { ok: false, status: 200, kind: 'connection', message: `Connection check failed: ${r.reason}`, audit: { action: 'connection_failed', detail: r.reason } };
}

export async function recipeAction(deps: ActionDeps, shop: string, form: Map<string, string>): Promise<ActionOutcome> {
  const { recipe } = deps;
  const action = form.get('action');
  const current = await deps.configs.get(shop, recipe.id);
  const config = current?.config ?? recipe.defaultConfig;
  if (action === 'disable') {
    await deps.configs.disable(shop, recipe.id);
    return { ok: true, msg: 'disabled', audit: { action: 'recipe_disabled' } };
  }
  if (action === 'enable_dry') {
    await deps.configs.set(shop, recipe.id, { enabled: true, dryRun: true, config });
    return { ok: true, msg: 'enabled_dry', audit: { action: 'recipe_dry_run' } };
  }
  if (action === 'go_live') {
    // The gate: the exact word LIVE, and a stored connection to write to.
    if (form.get('confirm') !== 'LIVE') return { ok: false, status: 400, kind: 'settings', errors: ['to go live, type LIVE in the confirmation box'] };
    if (!(await deps.connections.info(shop)).stored) return { ok: false, status: 400, kind: 'settings', errors: ['connect Salesforce first: there is nothing to write to'] };
    await deps.configs.set(shop, recipe.id, { enabled: true, dryRun: false, config });
    return { ok: true, msg: 'live', audit: { action: 'recipe_live' } };
  }
  return { ok: false, status: 400, kind: 'bad_request' };
}

export async function saveConfig(deps: ActionDeps, shop: string, form: Map<string, string>): Promise<ActionOutcome> {
  const { recipe } = deps;
  const submitted = recipe.fromForm(form);
  try {
    const valid = recipe.validate(submitted);
    const current = await deps.configs.get(shop, recipe.id);
    await deps.configs.set(shop, recipe.id, { enabled: current?.enabled ?? false, dryRun: current?.dryRun ?? true, config: valid });
  } catch (e) {
    if (e instanceof ConfigValidationError) {
      const echo: Record<string, string | boolean> = {};
      for (const [k, v] of form) if (k !== 'csrf') echo[k] = v;
      echo.requireConsent = form.get('requireConsent') === 'on';
      return { ok: false, status: 422, kind: 'settings', errors: e.problems, echo };
    }
    throw e;
  }
  return { ok: true, msg: 'config_saved', audit: { action: 'config_saved' } };
}
