// What a recipe's decide() asks the executor to write. Structural supertype of every recipe's own op type.

export type CoreOp =
  | { kind: 'createLead'; matchKey: string; fields: Record<string, unknown> }
  | { kind: 'updateLead'; matchKey: string; targetId: string; fields: { Description: string } }
  | { kind: 'createTask'; matchKey: string; ownerId: string; accountId: string | null; contactId: string | null; fields: { Subject: string; Description: string } };

export type OpOutcome =
  | { kind: 'created'; type: string; id: string }
  | { kind: 'updated'; type: string; id: string; changed: boolean }
  | { kind: 'duplicate_detected'; matchedIds: string[] }
  | { kind: 'already_done'; type: string; id: string };

// The slice of SalesforceClient the executor needs (so tests can fake it).
export interface SfWriter {
  create(type: string, fields: Record<string, unknown>, headers?: Record<string, string>): Promise<{ id: string }>;
  update(type: string, id: string, fields: Record<string, unknown>): Promise<void>;
  getRecord(type: string, id: string, fields: string[]): Promise<Record<string, any>>;
}
