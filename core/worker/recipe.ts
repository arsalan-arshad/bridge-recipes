// The recipe contract (docs/SPEC.md section 2). decide() is pure; buildContext does the READ-ONLY Salesforce lookups;
// only the executor writes.

import type { CoreOp } from '../executor/ops.ts';

export interface SfReader {
  query(soql: string): Promise<any[]>;
}

export type RecipeDecision = { skip: string } | { ops: CoreOp[] };

export interface Recipe<E = any, C = any, G = any> {
  id: string;
  topics: string[];
  mapEvent(payload: unknown): { ok: true; event: E } | { ok: false; reason: string };
  minimize?(payload: unknown): unknown; // drops every field mapEvent does not read, before the notification is queued
  objectIdOf(event: E): string;
  // A context with no Salesforce matches. decide() runs on it first: a skip decided by rules that do not need Salesforce
  // (no email, free domain, below minimum, no consent) is final, so skipped orders cost no API calls.
  emptyContext(): C;
  buildContext(event: E, sf: SfReader): Promise<C>;
  decide(event: E, ctx: C, config: G): RecipeDecision;
}

// Per-shop recipe settings. A recipe that is not configured is treated as disabled (nothing runs by default).
export interface RecipeSettings<G = any> {
  enabled: boolean; // the kill switch: false = zero Salesforce calls, zero writes
  dryRun: boolean; // true = read-only lookups and decide(), but nothing is written (the default for a new recipe)
  config: G;
}

export interface ConfigStore {
  get(shop: string, recipeId: string): Promise<RecipeSettings | null>;
}

export class MemoryConfigStore implements ConfigStore {
  private readonly m = new Map<string, RecipeSettings>();
  set(shop: string, recipeId: string, s: RecipeSettings): void {
    this.m.set(`${shop}|${recipeId}`, s);
  }
  async get(shop: string, recipeId: string) {
    return this.m.get(`${shop}|${recipeId}`) ?? null;
  }
}
