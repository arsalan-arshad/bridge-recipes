// Developer-org behaviour checks for R1 (docs/research/R1_PLATFORM_FACTS.md section 5, check 3-4).
// RUN BY THE OWNER, against a Developer org only. Writes clearly marked test records (prefix BRIDGE-TEST)
// and deletes them at the end.
//
//   BRIDGE_CHECKS_CONFIRM=yes node --env-file=.env scripts/org-checks.ts
//
// Env var NAMES (values live only in your local .env, never printed, never committed):
//   SF_LOGIN_URL       My Domain URL, e.g. https://<your-domain>.develop.my.salesforce.com
//   SF_CLIENT_ID       External Client App consumer key
//   SF_CLIENT_SECRET   External Client App consumer secret
// This script never prints the secret, the access token or any header. Output is safe to paste back.

import { buildAccountQuery, buildEmailQuery, pickAccountByDomain } from '../core/salesforce/lookups.ts';

const rawLoginUrl = (process.env.SF_LOGIN_URL ?? '').trim();
const LOGIN_URL = rawLoginUrl !== '' && !/^https?:\/\//i.test(rawLoginUrl) ? `https://${rawLoginUrl}` : rawLoginUrl;
const CLIENT_ID = process.env.SF_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET ?? '';

if (process.env.BRIDGE_CHECKS_CONFIRM !== 'yes') {
  console.log('Refusing to run: set BRIDGE_CHECKS_CONFIRM=yes to confirm this is a Developer org and test records may be created and deleted.');
  process.exit(1);
}
if (!LOGIN_URL || !CLIENT_ID || !CLIENT_SECRET) {
  console.log('Missing SF_LOGIN_URL, SF_CLIENT_ID or SF_CLIENT_SECRET in the environment.');
  process.exit(1);
}

const STAMP = Date.now();
const created: { type: string; id: string }[] = [];
let base = '';
let token = '';
let lastLimitInfo: string | null = null;

type Json = Record<string, unknown>;

async function call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  lastLimitInfo = res.headers.get('sforce-limit-info') ?? lastLimitInfo;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = text.slice(0, 300);
  }
  return { status: res.status, json };
}

function show(label: string, value: unknown) {
  console.log(`\n## ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
}

function brief(r: { status: number; json: unknown }) {
  const j = r.json;
  // Keep every key of each error object (e.g. the duplicate-rule detail), not just code/message/fields.
  if (Array.isArray(j)) return { status: r.status, errors: j };
  return { status: r.status, body: j };
}

async function create(type: string, body: Json, headers: Record<string, string> = {}) {
  const r = await call('POST', `/services/data/${apiVersion}/sobjects/${type}`, body, headers);
  const j = r.json as Json | null;
  if (r.status === 201 && j && typeof j.id === 'string') created.push({ type, id: j.id });
  return r;
}

let apiVersion = 'v60.0';

async function main() {
  // 0. Token (client credentials). Only non-secret facts are printed.
  const tokenRes = await fetch(`${LOGIN_URL.replace(/\/$/, '')}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const tj = (await tokenRes.json().catch(() => ({}))) as Json;
  show('0. Token request (client credentials)', {
    status: tokenRes.status,
    token_type: tj.token_type,
    has_access_token: typeof tj.access_token === 'string',
    has_refresh_token: 'refresh_token' in tj,
    expires_in: tj.expires_in ?? '(not returned)',
    scope: tj.scope,
    error: tj.error,
    error_description: tj.error_description,
  });
  if (typeof tj.access_token !== 'string' || typeof tj.instance_url !== 'string') {
    console.log('\nNo token; stopping. Check SF_LOGIN_URL (must be the My Domain URL), the key/secret, and the Run As user.');
    return;
  }
  token = tj.access_token;
  base = tj.instance_url;

  // 1. API version and limit header
  const versions = await call('GET', '/services/data/');
  if (Array.isArray(versions.json) && versions.json.length > 0) {
    apiVersion = `v${(versions.json[versions.json.length - 1] as Json).version}`;
  }
  const limits = await call('GET', `/services/data/${apiVersion}/limits`);
  const daily = (limits.json as Json | null)?.DailyApiRequests;
  show('1. API version and limit reporting', {
    latest_api_version: apiVersion,
    sforce_limit_info_header: lastLimitInfo,
    limits_resource_DailyApiRequests: daily,
  });

  // 2. Required fields, authoritative (describe): createable, not nillable, no default
  for (const type of ['Lead', 'Task']) {
    const d = await call('GET', `/services/data/${apiVersion}/sobjects/${type}/describe`);
    const fields = ((d.json as Json | null)?.fields ?? []) as Json[];
    show(`2. ${type}: required on create (describe)`, fields
      .filter((f) => f.createable === true && f.nillable === false && f.defaultedOnCreate === false)
      .map((f) => f.name));
  }

  // 3. Lead required-field errors and LeadSource picklist
  show('3a. Lead with no LastName', brief(await create('Lead', { Company: `BRIDGE-TEST ${STAMP}` })));
  show('3b. Lead with no Company', brief(await create('Lead', { LastName: `BRIDGE-TEST ${STAMP}` })));
  show('3c. Lead with LeadSource outside the picklist', brief(await create('Lead', {
    LastName: `BRIDGE-TEST ${STAMP}`, Company: `BRIDGE-TEST ${STAMP}`, LeadSource: 'BRIDGE_TEST_NOT_A_VALUE',
  })));

  // 4. Duplicate rules on API creates
  const email = `bridge-test-${STAMP}@example.invalid`;
  const lead = { LastName: `BRIDGE-TEST ${STAMP}`, Company: `BRIDGE-TEST ${STAMP}`, Email: email };
  show('4a. First Lead with a fresh email', brief(await create('Lead', lead)));
  const second = await create('Lead', lead);
  show('4b. Second Lead, same email, no header', brief(second));
  const third = await create('Lead', lead, { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' });
  show('4c. Same again with Sforce-Duplicate-Rule-Header: allowSave=true', brief(third));

  // 5. Task: attach to an Account, owner, required fields
  const acct = await create('Account', { Name: `BRIDGE-TEST Co ${STAMP}`, Website: 'https://www.bridge-test-co.invalid/about' });
  const acctId = (acct.json as Json | null)?.id as string | undefined;
  show('5a. Test Account created', brief(acct));
  if (acctId) {
    const acctRow = await call('GET', `/services/data/${apiVersion}/sobjects/Account/${acctId}?fields=OwnerId`);
    const ownerId = (acctRow.json as Json | null)?.OwnerId as string | undefined;
    show('5b. Task with WhatId only (no Subject, no OwnerId)', brief(await create('Task', { WhatId: acctId })));
    const t = await create('Task', { WhatId: acctId, Subject: `BRIDGE-TEST ${STAMP}` });
    show('5c. Task with Subject + WhatId (no OwnerId, no Status)', brief(t));
    const tid = (t.json as Json | null)?.id as string | undefined;
    if (tid) {
      const row = await call('GET', `/services/data/${apiVersion}/sobjects/Task/${tid}?fields=OwnerId,Status,AccountId,WhatId`);
      show('5d. That Task, read back (is OwnerId defaulted? Status? AccountId derived?)', brief(row));
    }
    if (ownerId) show('5e. Task with explicit OwnerId', brief(await create('Task', { WhatId: acctId, Subject: `BRIDGE-TEST ${STAMP}`, OwnerId: ownerId })));
  }
  const leadForTask = created.find((c) => c.type === 'Lead');
  if (leadForTask) {
    show('5f. Task with a Lead id in WhatId (expected to be rejected)', brief(await create('Task', { WhatId: leadForTask.id, Subject: `BRIDGE-TEST ${STAMP}` })));
    show('5g. Task with a Lead id in WhoId', brief(await create('Task', { WhoId: leadForTask.id, Subject: `BRIDGE-TEST ${STAMP}` })));
  }

  // 5h. Contact WITHOUT an account (contract F13b): Task with WhoId only; is OwnerId settable and what is the default?
  const contact = await create('Contact', { LastName: `BRIDGE-TEST ${STAMP}`, Email: `bridge-test-contact-${STAMP}@example.invalid` });
  show('5h. Contact with no AccountId', brief(contact));
  const contactId = (contact.json as Json | null)?.id as string | undefined;
  if (contactId) {
    const crow = await call('GET', `/services/data/${apiVersion}/sobjects/Contact/${contactId}?fields=OwnerId,AccountId`);
    const cOwner = (crow.json as Json | null)?.OwnerId as string | undefined;
    show('5i. That Contact, read back (OwnerId, AccountId null?)', brief(crow));
    const t1 = await create('Task', { WhoId: contactId, Subject: `BRIDGE-TEST ${STAMP}` });
    show('5j. Task with WhoId = Contact (no WhatId, no OwnerId)', brief(t1));
    const t1id = (t1.json as Json | null)?.id as string | undefined;
    if (t1id) show('5k. That Task, read back (derived AccountId? default OwnerId?)', brief(await call('GET', `/services/data/${apiVersion}/sobjects/Task/${t1id}?fields=OwnerId,AccountId,WhoId,WhatId,Status`)));
    if (cOwner) show('5l. Task with WhoId = Contact and OwnerId = the Contact owner', brief(await create('Task', { WhoId: contactId, Subject: `BRIDGE-TEST ${STAMP}`, OwnerId: cOwner })));
  }

  // 6. SOQL lookups (the builders from core/salesforce/lookups.ts, plus a case check)
  const q = (soql: string) => call('GET', `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`);
  const accounts = await q(buildAccountQuery('bridge-test-co.invalid'));
  const rows = (((accounts.json as Json | null)?.records ?? []) as { Id: string; OwnerId: string; Website: string }[]);
  show('6a. Account by Website domain', { status: accounts.status, rows: rows.length, picked: pickAccountByDomain(rows, 'bridge-test-co.invalid')?.Id ?? null });
  const leads = await q(buildEmailQuery('Lead', email));
  show('6b. Lead by email (builder)', { status: leads.status, totalSize: (leads.json as Json | null)?.totalSize });
  const upper = await q(`SELECT Id FROM Lead WHERE Email = '${email.toUpperCase()}' LIMIT 5`);
  show('6c. Lead by UPPER-CASE email (is comparison case-insensitive?)', { status: upper.status, totalSize: (upper.json as Json | null)?.totalSize });
  const contacts = await q(buildEmailQuery('Contact', email));
  show('6d. Contact by email (builder, expected 0)', { status: contacts.status, totalSize: (contacts.json as Json | null)?.totalSize });
  show('Limit header after all calls', lastLimitInfo);
}

async function cleanup() {
  if (!token) return;
  // Print every created record BEFORE deleting, so the Ids are on screen even if cleanup fails.
  show('Created BRIDGE-TEST records (Ids)', created.map((c) => `${c.type} ${c.id}`));
  let deleted = 0;
  const failed: string[] = [];
  // Reverse order: Tasks and Leads before the Account they point at.
  for (const rec of [...created].reverse()) {
    const r = await call('DELETE', `/services/data/${apiVersion}/sobjects/${rec.type}/${rec.id}`);
    if (r.status === 204) deleted++;
    else failed.push(`${rec.type} ${rec.id} (${r.status})`);
  }
  show('Cleanup', {
    created: created.length,
    deleted,
    failed_to_delete: failed,
    if_any_left: "In Salesforce search 'BRIDGE-TEST' in Leads, Contacts, Accounts and Tasks (Subject) and delete them by hand.",
  });
}

try {
  await main();
} catch (err) {
  console.log('\nScript error:', err instanceof Error ? err.message : String(err));
} finally {
  await cleanup();
}
