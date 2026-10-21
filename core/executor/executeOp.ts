// THE ONLY CODE THAT WRITES to Salesforce (CLAUDE.md hard rule). Policies (owner-confirmed, docs/SPEC.md sections 4 and 7):
//  - never sends allowSave: a duplicate-rule hit is a terminal outcome `duplicate_detected`, not forced, not retried
//  - a restricted LeadSource picklist is retried ONCE without LeadSource, the wanted value noted in the Description
//  - updateLead appends the order note to the existing Description (and does nothing if it is already there)
//  - a retried job never writes twice (EntityStore keyed by the op's matchKey)

import { SalesforceError } from '../salesforce/client.ts';
import type { CoreOp, OpOutcome, SfWriter } from './ops.ts';
import type { EntityStore } from './entityStore.ts';

export async function executeOp(op: CoreOp, sf: SfWriter): Promise<OpOutcome> {
  if (op.kind === 'createLead') {
    try {
      const { id } = await sf.create('Lead', op.fields);
      return { kind: 'created', type: 'Lead', id };
    } catch (e) {
      if (!(e instanceof SalesforceError)) throw e;
      if (e.kind === 'duplicate') return { kind: 'duplicate_detected', matchedIds: e.matchedIds };
      if (e.kind === 'restricted_picklist') {
        const { LeadSource, ...rest } = op.fields;
        const wanted = typeof LeadSource === 'string' ? LeadSource : '';
        const description = typeof rest.Description === 'string' ? rest.Description : '';
        try {
          const { id } = await sf.create('Lead', { ...rest, Description: wanted ? `${description} (LeadSource wanted: ${wanted})` : description });
          return { kind: 'created', type: 'Lead', id };
        } catch (e2) {
          if (e2 instanceof SalesforceError && e2.kind === 'duplicate') return { kind: 'duplicate_detected', matchedIds: e2.matchedIds };
          throw e2;
        }
      }
      throw e;
    }
  }

  if (op.kind === 'updateLead') {
    const current = await sf.getRecord('Lead', op.targetId, ['Description']);
    const old = typeof current.Description === 'string' ? current.Description : '';
    if (old.includes(op.fields.Description)) return { kind: 'updated', type: 'Lead', id: op.targetId, changed: false };
    await sf.update('Lead', op.targetId, { Description: old === '' ? op.fields.Description : `${old}\n${op.fields.Description}` });
    return { kind: 'updated', type: 'Lead', id: op.targetId, changed: true };
  }

  const body: Record<string, unknown> = { Subject: op.fields.Subject, Description: op.fields.Description, OwnerId: op.ownerId };
  if (op.accountId) body.WhatId = op.accountId;
  if (op.contactId) body.WhoId = op.contactId;
  const { id } = await sf.create('Task', body);
  return { kind: 'created', type: 'Task', id };
}

// Idempotent wrapper: skip an op whose matchKey was already written; remember a successful write.
export async function runOp(op: CoreOp, deps: { sf: SfWriter; entities: EntityStore; shop: string }): Promise<OpOutcome> {
  const done = await deps.entities.get(op.matchKey);
  if (done) return { kind: 'already_done', type: done.type, id: done.id };
  const outcome = await executeOp(op, deps.sf);
  if (outcome.kind === 'created' || outcome.kind === 'updated') await deps.entities.put(op.matchKey, { type: outcome.type, id: outcome.id }, deps.shop);
  // duplicate_detected is deliberately NOT remembered: a later replay may succeed once the duplicate is gone.
  return outcome;
}
