// R1's read-only Salesforce lookups -> Context. Owner ruling 2026-10-19 (contract rule 5): if both a non-converted Lead and
// a Contact match the email, the Lead wins. The Account is matched by the Website host (contract section 5).

import { buildAccountQuery, buildEmailQuery, pickAccountByDomain } from '../../core/salesforce/lookups.ts';
import type { SfReader } from '../../core/worker/recipe.ts';
import type { Context, OrderPaidEvent } from './types.ts';

export async function buildContext(event: OrderPaidEvent, sf: SfReader): Promise<Context> {
  const ctx: Context = { accountByDomain: null, existingByEmail: null };
  const email = event.customer.email === null ? '' : event.customer.email.trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return ctx; // decide() will skip no_email
  let accountQuery: string;
  let leadQuery: string;
  let contactQuery: string;
  try {
    accountQuery = buildAccountQuery(parts[1]);
    leadQuery = buildEmailQuery('Lead', email);
    contactQuery = buildEmailQuery('Contact', email);
  } catch {
    return ctx; // an address the query builders refuse (quotes, spaces...): treat as no match, decide() filters the rest
  }
  const acct = pickAccountByDomain((await sf.query(accountQuery)) as { Id: string; OwnerId: string; Website: string }[], parts[1]);
  if (acct) ctx.accountByDomain = { id: acct.Id, ownerId: acct.OwnerId };
  const lead = (await sf.query(leadQuery))[0];
  if (lead) {
    ctx.existingByEmail = { type: 'Lead', id: lead.Id };
  } else {
    const c = (await sf.query(contactQuery))[0];
    if (c) ctx.existingByEmail = { type: 'Contact', id: c.Id, accountId: c.AccountId ?? null, ownerId: c.OwnerId };
  }
  return ctx;
}
