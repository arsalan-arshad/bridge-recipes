// EntityMap (docs/SPEC.md section 5): matchKey -> the Salesforce record already written for it. It makes a retried job
// idempotent: a job that wrote to Salesforce but crashed before completing is not written twice. Not atomic with
// Salesforce (nothing can be), so there is still a small at-least-once window; Lead duplicate rules cover Leads.

export interface EntityRecord {
  type: string;
  id: string;
}

export interface EntityStore {
  get(matchKey: string): Promise<EntityRecord | null>;
  // `shop` is required: shop/redact must be able to delete exactly one shop's mappings.
  put(matchKey: string, rec: EntityRecord, shop: string): Promise<void>;
}

export class MemoryEntityStore implements EntityStore {
  readonly map = new Map<string, EntityRecord>();
  async get(matchKey: string) {
    return this.map.get(matchKey) ?? null;
  }
  readonly shops = new Map<string, string>();
  async put(matchKey: string, rec: EntityRecord, shop: string) {
    if (!this.map.has(matchKey)) {
      this.map.set(matchKey, rec);
      this.shops.set(matchKey, shop);
    }
  }
}
