// "Check my Salesforce setup": read-only checks that the integration user can do what R1 needs and no more
// (docs/SETUP_SALESFORCE.md). It reads object descriptions, which tell what the user the token runs as may do; it writes nothing.
// `evaluateSetup` is pure; `runSetupCheck` only fetches the descriptions. Every message is fixed text (no Salesforce text is shown).

import { SalesforceError } from './client.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface SetupCheck {
  id: string;
  title: string;
  status: CheckStatus;
  fix?: string; // what to do, when it is not a pass
}

export interface FieldDescribe {
  name: string;
  createable?: boolean;
  updateable?: boolean;
}
export interface ObjectDescribe {
  queryable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  deletable?: boolean;
  fields?: FieldDescribe[];
}
// null: the object could not be described because it does not exist for this user (Salesforce answered 404).
export type Describes = Record<'Lead' | 'Task' | 'Account' | 'Contact', ObjectDescribe | null>;

const fieldOf = (d: ObjectDescribe, name: string) => (d.fields ?? []).find((f) => f.name === name);

function need(d: ObjectDescribe, id: string, title: string, fix: string, missing: string[]): SetupCheck {
  return missing.length === 0 ? { id, title, status: 'pass' } : { id, title, status: 'fail', fix: `${fix} Missing: ${missing.join(', ')}.` };
}

function tooBroad(d: ObjectDescribe, id: string, title: string, flags: ('createable' | 'updateable' | 'deletable')[]): SetupCheck {
  const verb = { createable: 'create', updateable: 'edit', deletable: 'delete' };
  const extra = flags.filter((f) => d[f] === true).map((f) => verb[f]);
  return extra.length === 0
    ? { id, title, status: 'pass' }
    : { id, title, status: 'warn', fix: `The integration user can ${extra.join(' and ')} here, which Bridge Recipes never needs. Remove it from the permission set, or check that the app's Run As user is the integration user and not an administrator.` };
}

export function evaluateSetup(d: Describes): SetupCheck[] {
  const checks: SetupCheck[] = [];

  if (d.Lead === null) {
    checks.push({ id: 'lead', title: 'Leads: read, create and update', status: 'fail', fix: 'The integration user cannot see the Lead object. Assign the permission set with Lead read, create and edit.' });
  } else {
    const missing = [
      ...(d.Lead.queryable === true ? [] : ['read Lead']),
      ...(d.Lead.createable === true ? [] : ['create Lead']),
      ...(d.Lead.updateable === true ? [] : ['edit Lead']),
      ...['Email', 'LeadSource', 'Description'].filter((n) => fieldOf(d.Lead!, n)?.updateable !== true).map((n) => `field ${n}`),
    ];
    checks.push(need(d.Lead, 'lead', 'Leads: read, create and update', 'Give the permission set Lead read, create and edit, with field access.', missing));
    checks.push(tooBroad(d.Lead, 'lead_delete', 'Leads: no delete', ['deletable']));
  }

  if (d.Task === null) {
    checks.push({ id: 'task', title: 'Tasks: create', status: 'fail', fix: 'Salesforce says the Task object does not exist for this user. This happens when the integration user is on the "Salesforce Integration" licence. Move the user to a full Salesforce licence.' });
  } else {
    const missing = [
      ...(d.Task.createable === true ? [] : ['create Task']),
      ...['Description', 'WhatId', 'WhoId'].filter((n) => fieldOf(d.Task!, n)?.createable !== true).map((n) => `field ${n}`),
    ];
    checks.push(need(d.Task, 'task', 'Tasks: create', 'Give the permission set "Edit Tasks" and field access on Description, Related To (WhatId) and Name (WhoId).', missing));
  }

  if (d.Account === null) {
    checks.push({ id: 'account', title: 'Accounts: read only', status: 'fail', fix: 'The integration user cannot see the Account object. Give the permission set Account read with field access to Website.' });
  } else {
    const missing = [...(d.Account.queryable === true ? [] : ['read Account']), ...(fieldOf(d.Account, 'Website') ? [] : ['field Website'])];
    checks.push(need(d.Account, 'account', 'Accounts: read', 'Give the permission set Account read with field access to Website.', missing));
    checks.push(tooBroad(d.Account, 'account_write', 'Accounts: no create, edit or delete', ['createable', 'updateable', 'deletable']));
  }

  if (d.Contact === null) {
    checks.push({ id: 'contact', title: 'Contacts: read only', status: 'fail', fix: 'The integration user cannot see the Contact object. Give the permission set Contact read with field access to Email and Account.' });
  } else {
    const missing = [...(d.Contact.queryable === true ? [] : ['read Contact']), ...['Email', 'AccountId'].filter((n) => !fieldOf(d.Contact!, n)).map((n) => `field ${n}`)];
    checks.push(need(d.Contact, 'contact', 'Contacts: read', 'Give the permission set Contact read with field access to Email and Account.', missing));
    checks.push(tooBroad(d.Contact, 'contact_write', 'Contacts: no create, edit or delete', ['createable', 'updateable', 'deletable']));
  }
  return checks;
}

export interface Describer {
  request(method: string, path: string): Promise<{ status: number; json: any }>;
}

export type SetupResult = { ok: true; checks: SetupCheck[] } | { ok: false; reason: 'auth' | 'unreachable' };

// Logging in is checked first: a wrong key, secret or Client Credentials setting stops here with one clear result.
export async function runSetupCheck(client: Describer): Promise<SetupResult> {
  const out: Partial<Describes> = {};
  for (const name of ['Lead', 'Task', 'Account', 'Contact'] as const) {
    try {
      const r = await client.request('GET', `/services/data/{v}/sobjects/${name}/describe`);
      out[name] = r.json && typeof r.json === 'object' ? (r.json as ObjectDescribe) : null;
    } catch (e) {
      if (e instanceof SalesforceError && e.kind === 'auth') return { ok: false, reason: 'auth' };
      if (e instanceof SalesforceError && (e.status === 404 || e.status === 403)) {
        out[name] = null; // the object is hidden from this user
        continue;
      }
      return { ok: false, reason: 'unreachable' };
    }
  }
  return { ok: true, checks: evaluateSetup(out as Describes) };
}
