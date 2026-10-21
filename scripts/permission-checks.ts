// Least-privilege checks for the dedicated integration user (PROJECT_CONTEXT sections 15, 18).
// RUN BY THE OWNER OR TERMINAL CLAUDE ONLY AFTER the External Client App's Run As is switched to the integration
// user (bridgerecipes@...). If Run As is still the admin, every result below proves nothing about least privilege.
// Developer org only. Writes a few clearly marked test records (prefix BRIDGE-TEST).
//
//   BRIDGE_CHECKS_CONFIRM=yes node --env-file=.env scripts/permission-checks.ts
//
// Env var NAMES (values only in your untracked .env, never printed): SF_LOGIN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET.
// The integration user has NO Delete on Lead by design, so the one test Lead this script creates CANNOT be removed by
// it: the script prints its Id and an admin deletes it. Tasks it creates are deleted (Edit Tasks allows that).
// Never prints tokens, secrets or headers.

const rawLoginUrl = (process.env.SF_LOGIN_URL ?? '').trim();
const LOGIN_URL = rawLoginUrl !== '' && !/^https?:\/\//i.test(rawLoginUrl) ? `https://${rawLoginUrl}` : rawLoginUrl;
const CLIENT_ID = process.env.SF_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET ?? '';

if (process.env.BRIDGE_CHECKS_CONFIRM !== 'yes') {
  console.log('Refusing to run: set BRIDGE_CHECKS_CONFIRM=yes (Developer org only; Run As must already be the integration user).');
  process.exit(1);
}
if (!LOGIN_URL || !CLIENT_ID || !CLIENT_SECRET) {
  console.log('Missing SF_LOGIN_URL, SF_CLIENT_ID or SF_CLIENT_SECRET in the environment.');
  process.exit(1);
}

type Json = Record<string, any>;
const STAMP = Date.now();
let base = '';
let token = '';
let apiVersion = 'v60.0';
const created: { type: string; id: string }[] = []; // EVERY record any call created, so nothing is left untracked

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = text.slice(0, 300); }
  const m = /\/sobjects\/(\w+)$/.exec(path);
  if (method === 'POST' && res.status === 201 && m && json && typeof json.id === 'string') created.push({ type: m[1], id: json.id });
  return { status: res.status, json };
}
const show = (label: string, v: unknown) => console.log(`\n## ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);
const err = (r: { status: number; json: any }) => (Array.isArray(r.json) ? { status: r.status, errors: r.json.map((e: Json) => ({ errorCode: e.errorCode, message: e.message, fields: e.fields })) } : { status: r.status, body: r.json });
const query = (soql: string) => call('GET', `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`);

async function describeFields(type: string, names: string[]) {
  const d = await call('GET', `/services/data/${apiVersion}/sobjects/${type}/describe`);
  if (d.status !== 200) return err(d);
  const fields = (d.json.fields ?? []) as Json[];
  const out: Json = { objectCreateable: d.json.createable, objectUpdateable: d.json.updateable, objectDeletable: d.json.deletable, fields: {} };
  for (const n of names) {
    const f = fields.find((x) => x.name === n);
    out.fields[n] = f ? { createable: f.createable, updateable: f.updateable } : 'NOT VISIBLE (no field access)';
  }
  return out;
}

async function main() {
  // 0. Token and basic API access
  const tr = await fetch(`${LOGIN_URL.replace(/\/$/, '')}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const tj = (await tr.json().catch(() => ({}))) as Json;
  show('0. Token request', { status: tr.status, has_access_token: typeof tj.access_token === 'string', scope: tj.scope, error: tj.error, error_description: tj.error_description });
  if (typeof tj.access_token !== 'string') return;
  token = tj.access_token;
  base = tj.instance_url;
  const versions = await call('GET', '/services/data/');
  if (Array.isArray(versions.json) && versions.json.length) apiVersion = `v${versions.json[versions.json.length - 1].version}`;
  show('1. API access (REST limits call)', err(await call('GET', `/services/data/${apiVersion}/limits`)).status);

  // 1b. PRE-FLIGHT: who is this token? Refuse to write anything if it is an administrator (Run As not switched).
  const userId = String(tj.id ?? '').split('/').pop() ?? '';
  const who = await query(`SELECT Id, Username, Profile.Name FROM User WHERE Id = '${userId}'`);
  const me = who.json?.records?.[0] as Json | undefined;
  show('1b. Token user (identity pre-flight)', me ? { Id: me.Id, Username: me.Username, Profile: me.Profile?.Name } : { Id: userId, note: 'user record not readable by this user (expected for a restricted integration user)' });
  if (me && String(me.Profile?.Name ?? '') === 'System Administrator') {
    console.log('\nSTOP: the token user is a System Administrator, so the External Client App Run As has NOT been switched to the integration user. Nothing was written. Check Setup > External Client App Manager > Bridge Recipes dev > Policies > OAuth Policies > Client Credentials Flow > Run As, save it, then run again.');
    return;
  }

  // 2. Field/object permissions, read from describe (no writes)
  show('2a. Lead permissions as seen by this user', await describeFields('Lead', ['Company', 'LastName', 'Email', 'LeadSource', 'Description', 'OwnerId', 'Status', 'Phone', 'IsConverted']));
  show('2b. Task permissions as seen by this user', await describeFields('Task', ['Subject', 'Description', 'WhatId', 'WhoId', 'OwnerId', 'Status', 'Priority']));
  show('2c. Account permissions', await describeFields('Account', ['Name', 'Website', 'OwnerId']));
  show('2d. Contact permissions', await describeFields('Contact', ['LastName', 'Email', 'AccountId', 'OwnerId']));

  // 3. Reads the product needs
  const acct = await query('SELECT Id, OwnerId, Website FROM Account LIMIT 1');
  const contact = await query('SELECT Id, AccountId, OwnerId, Email FROM Contact LIMIT 1');
  const lead = await query('SELECT Id, Email, IsConverted FROM Lead LIMIT 1');
  show('3. Reads (status, row counts)', { account: [acct.status, acct.json?.totalSize], contact: [contact.status, contact.json?.totalSize], lead: [lead.status, lead.json?.totalSize] });
  const account = acct.json?.records?.[0] as Json | undefined;
  const aContact = contact.json?.records?.[0] as Json | undefined;

  // 4. Writes the product does (should work) ...  (set PERMCHECK_SKIP_LEAD_WRITES=yes to skip them: the integration user
  // cannot delete Leads, so every run of this block leaves two test Leads for an admin to delete)
  const skipLeadWrites = process.env.PERMCHECK_SKIP_LEAD_WRITES === 'yes';
  const ownerForTests = account?.OwnerId as string | undefined; // someone other than the integration user
  const newLead = skipLeadWrites ? { status: 0, json: null } : await call('POST', `/services/data/${apiVersion}/sobjects/Lead`, {
    Company: `BRIDGE-TEST ${STAMP}`, LastName: `BRIDGE-TEST ${STAMP}`, Email: `bridge-perm-${STAMP}@example.invalid`, LeadSource: 'Shopify Order', Description: 'BRIDGE-TEST', ...(ownerForTests ? { OwnerId: ownerForTests } : {}),
  });
  show('4a. Lead create with the fields R1 sets (incl. an explicit OwnerId of another user)', skipLeadWrites ? 'skipped (PERMCHECK_SKIP_LEAD_WRITES=yes)' : err(newLead));
  const leadId = newLead.json?.id as string | undefined;
  if (leadId) {
    const row = await call('GET', `/services/data/${apiVersion}/sobjects/Lead/${leadId}?fields=OwnerId`);
    show('4b. That Lead owner = the account owner we asked for?', { requested: ownerForTests ?? '(none)', actual: row.json?.OwnerId });
    show('4c. Update Lead Description (appending the order note)', err(await call('PATCH', `/services/data/${apiVersion}/sobjects/Lead/${leadId}`, { Description: 'BRIDGE-TEST updated' })));
    show('4d. Update Lead Company (not granted as FLS: observe)', err(await call('PATCH', `/services/data/${apiVersion}/sobjects/Lead/${leadId}`, { Company: `BRIDGE-TEST ${STAMP} b` })));
    show('4e. Update a field with no access (Lead.Status)', err(await call('PATCH', `/services/data/${apiVersion}/sobjects/Lead/${leadId}`, { Status: 'Working - Contacted' })));
    show('4f. Delete the Lead (must be DENIED: no Delete by design)', err(await call('DELETE', `/services/data/${apiVersion}/sobjects/Lead/${leadId}`)));
  }
  if (!skipLeadWrites) show('4g. Lead create with a field the user has no access to (Status)', err(await call('POST', `/services/data/${apiVersion}/sobjects/Lead`, { Company: `BRIDGE-TEST ${STAMP}`, LastName: `BRIDGE-TEST ${STAMP}`, Status: 'Working - Contacted' })));

  // 5. Tasks (Edit Tasks): Account task assigned to another owner, Contact task
  if (account) {
    const t = await call('POST', `/services/data/${apiVersion}/sobjects/Task`, { Subject: `BRIDGE-TEST ${STAMP}`, Description: 'BRIDGE-TEST', WhatId: account.Id, OwnerId: account.OwnerId });
    show('5a. Task on an existing Account, OwnerId = the Account owner', err(t));
  }
  if (aContact) {
    const t = await call('POST', `/services/data/${apiVersion}/sobjects/Task`, { Subject: `BRIDGE-TEST ${STAMP}`, WhoId: aContact.Id, ...(aContact.AccountId ? { WhatId: aContact.AccountId } : {}), OwnerId: aContact.OwnerId });
    show('5b. Task on an existing Contact, OwnerId = the Contact owner', err(t));
  }
  const bare = await call('POST', `/services/data/${apiVersion}/sobjects/Task`, { Subject: `BRIDGE-TEST ${STAMP}` });
  show('5c. Task with no owner given (default owner = this user?)', err(bare));

  // 6. Things that must be DENIED
  show('6a. Account create (must be denied)', err(await call('POST', `/services/data/${apiVersion}/sobjects/Account`, { Name: `BRIDGE-TEST ${STAMP}` })));
  show('6b. Contact create (must be denied)', err(await call('POST', `/services/data/${apiVersion}/sobjects/Contact`, { LastName: `BRIDGE-TEST ${STAMP}` })));
  if (account) show('6c. Account update (must be denied)', err(await call('PATCH', `/services/data/${apiVersion}/sobjects/Account/${account.Id}`, { Website: account.Website ?? null })));
}

async function cleanup() {
  if (!token) return;
  show('Created records (Ids)', created.map((c) => `${c.type} ${c.id}`));
  const failed: string[] = [];
  let deleted = 0;
  for (const rec of [...created].reverse()) {
    const r = await call('DELETE', `/services/data/${apiVersion}/sobjects/${rec.type}/${rec.id}`);
    if (r.status === 204) deleted++;
    else failed.push(`${rec.type} ${rec.id} (HTTP ${r.status})`);
  }
  show('Cleanup', {
    created: created.length,
    deleted,
    LEFT_FOR_AN_ADMIN_TO_DELETE: failed,
    note: "The integration user cannot delete Leads by design (Tasks can be deleted via Edit Tasks). Anything listed above must be deleted by an admin: search 'BRIDGE-TEST' in Leads, Accounts and Contacts.",
  });
  const violations = created.filter((c) => c.type === 'Account' || c.type === 'Contact');
  if (violations.length > 0) console.log(`\nVIOLATION: the user could create ${violations.map((v) => v.type).join(' and ')} records, which it must not be able to.`);
}

try {
  await main();
} catch (e) {
  console.log('\nScript error:', e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
}
