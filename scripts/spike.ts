// M0 SPIKE (docs/BUILD_PLAN.md): one verified Shopify webhook -> one real Lead in the Developer org.
// THROWAWAY code. The real gateway, queue, client and executor are M1; do not grow this file.
//
// DRY-RUN BY DEFAULT: reads from Salesforce (lookups) are allowed, writes are only logged.
// Writes happen only with SPIKE_WRITE=yes and only against a Developer org.
//
//   node --env-file=.env scripts/spike.ts --file <payload.json>      # map + lookups + decide, no HTTP, no HMAC
//   node --env-file=.env scripts/spike.ts                            # webhook receiver on 127.0.0.1:8787 (HMAC-verified)
//   SPIKE_WRITE=yes node --env-file=.env scripts/spike.ts ...        # actually write
//
// Env var NAMES (values only in your untracked .env, never printed): SF_LOGIN_URL, SF_CLIENT_ID,
// SF_CLIENT_SECRET, SHOPIFY_WEBHOOK_SECRET (receiver mode only), PORT (optional).
// Logs redact emails (a***@domain) and never print tokens, secrets or raw payloads.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { verifyShopifyHmac } from '../core/shopify/verifyHmac.ts';
import { redactEmail } from '../core/log/redactEmail.ts';
import { buildAccountQuery, buildEmailQuery, pickAccountByDomain } from '../core/salesforce/lookups.ts';
import { apiUsageRatio } from '../core/salesforce/limitInfo.ts';
import { decide } from '../recipes/retail-b2b-lead-spotter/decide.ts';
import { mapOrderPaid } from '../recipes/retail-b2b-lead-spotter/mapOrderPaid.ts';
import type { Config, Context, SalesforceOp } from '../recipes/retail-b2b-lead-spotter/types.ts';

const WRITE = process.env.SPIKE_WRITE === 'yes';
const rawLoginUrl = (process.env.SF_LOGIN_URL ?? '').trim();
const LOGIN_URL = rawLoginUrl !== '' && !/^https?:\/\//i.test(rawLoginUrl) ? `https://${rawLoginUrl}` : rawLoginUrl;
const CLIENT_ID = process.env.SF_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET ?? '';
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 8787);

// Spike config: defaults from the contract. The free-email list is a short stand-in for the shipped one.
const CONFIG: Config = {
  allowDomains: [],
  denyDomains: [],
  freeEmailBlocklist: ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com'],
  minOrderTotal: 0,
  requireConsent: true,
  existingLeadAction: 'update',
  leadSource: 'Shopify Order',
  companyOverride: null,
  leadOwnerId: null,
};

if (!LOGIN_URL || !CLIENT_ID || !CLIENT_SECRET) {
  console.log('Missing SF_LOGIN_URL, SF_CLIENT_ID or SF_CLIENT_SECRET in the environment.');
  process.exit(1);
}

let base = '';
let token = '';
let apiVersion = 'v60.0';

async function authenticate(): Promise<void> {
  const res = await fetch(`${LOGIN_URL.replace(/\/$/, '')}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof j.access_token !== 'string' || typeof j.instance_url !== 'string') {
    throw new Error(`Salesforce auth failed (HTTP ${res.status}${typeof j.error === 'string' ? `, ${j.error}` : ''})`);
  }
  token = j.access_token;
  base = j.instance_url;
  const v = await fetch(`${base}/services/data/`).then((r) => r.json()).catch(() => []);
  if (Array.isArray(v) && v.length > 0) apiVersion = `v${(v[v.length - 1] as { version: string }).version}`;
}

// One call; re-authenticates once on 401 (no expires_in is returned, so there is no timer to trust).
async function sf(method: string, path: string, body?: unknown, retried = false): Promise<{ status: number; json: any; limit: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !retried) {
    await authenticate();
    return sf(method, path, body, true);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, limit: res.headers.get('sforce-limit-info') };
}

const query = (soql: string) => sf('GET', `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`);

async function buildContext(email: string | null): Promise<Context> {
  const ctx: Context = { accountByDomain: null, existingByEmail: null };
  if (email === null) return ctx;
  const norm = email.trim().toLowerCase();
  const parts = norm.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return ctx;
  try {
    const rows = (await query(buildAccountQuery(parts[1]))).json?.records ?? [];
    const acct = pickAccountByDomain(rows as { Id: string; OwnerId: string; Website: string }[], parts[1]);
    if (acct) ctx.accountByDomain = { id: acct.Id, ownerId: acct.OwnerId };
    // Owner ruling 2026-10-19 (contract rule 5): if BOTH a Lead and a Contact match, the Lead wins.
    const lead = (await query(buildEmailQuery('Lead', norm))).json?.records?.[0];
    if (lead) ctx.existingByEmail = { type: 'Lead', id: lead.Id };
    else {
      const c = (await query(buildEmailQuery('Contact', norm))).json?.records?.[0];
      if (c) ctx.existingByEmail = { type: 'Contact', id: c.Id, accountId: c.AccountId ?? null, ownerId: c.OwnerId };
    }
  } catch (e) {
    throw new Error(`lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return ctx;
}

function logOp(op: SalesforceOp) {
  const copy: any = JSON.parse(JSON.stringify(op));
  if (copy.fields?.Email) copy.fields.Email = redactEmail(copy.fields.Email);
  console.log(`  ${WRITE ? 'WRITE' : 'DRY-RUN (not written)'}: ${JSON.stringify(copy)}`);
}

const MAX_WRITES = Number(process.env.SPIKE_MAX_WRITES ?? 1); // the owner approved ONE write for M0
let writes = 0;

async function execute(op: SalesforceOp): Promise<void> {
  logOp(op);
  if (!WRITE) return;
  if (writes >= MAX_WRITES) {
    console.log(`  write cap reached (${MAX_WRITES}); not written`);
    return;
  }
  writes++;
  if (op.kind === 'createLead') {
    let r = await sf('POST', `/services/data/${apiVersion}/sobjects/Lead`, op.fields);
    const code = r.json?.[0]?.errorCode;
    if (r.status === 400 && code === 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST') {
      // SPEC §4 rule 6: the executor retries once without LeadSource and notes the value.
      const { LeadSource, ...rest } = op.fields;
      r = await sf('POST', `/services/data/${apiVersion}/sobjects/Lead`, { ...rest, Description: `${rest.Description} (LeadSource wanted: ${LeadSource})` });
    }
    report(r, 'Lead');
  } else if (op.kind === 'updateLead') {
    const cur = await sf('GET', `/services/data/${apiVersion}/sobjects/Lead/${op.targetId}?fields=Description`);
    const old = typeof cur.json?.Description === 'string' ? cur.json.Description : '';
    const r = await sf('PATCH', `/services/data/${apiVersion}/sobjects/Lead/${op.targetId}`, { Description: old === '' ? op.fields.Description : `${old}\n${op.fields.Description}` });
    console.log(`  -> update Lead ${op.targetId}: HTTP ${r.status}`);
  } else {
    const body: Record<string, unknown> = { Subject: op.fields.Subject, Description: op.fields.Description, OwnerId: op.ownerId };
    if (op.accountId) body.WhatId = op.accountId;
    if (op.contactId) body.WhoId = op.contactId;
    report(await sf('POST', `/services/data/${apiVersion}/sobjects/Task`, body), 'Task');
  }
}

function report(r: { status: number; json: any; limit: string | null }, what: string) {
  if (r.status === 201) {
    console.log(`  -> created ${what} ${r.json.id}`);
    return;
  }
  const e = Array.isArray(r.json) ? r.json[0] : null;
  if (e?.errorCode === 'DUPLICATES_DETECTED') {
    // Policy: terminal outcome, never allowSave. The match id is in duplicateResult.matchResults[].matchRecords[].record.Id
    const ids = (e.duplicateResult?.matchResults ?? []).flatMap((m: any) => (m.matchRecords ?? []).map((x: any) => x.record?.Id)).filter(Boolean);
    console.log(`  -> outcome duplicate_detected (not retried, not forced); matched: ${ids.join(', ') || 'n/a'}`);
    return;
  }
  console.log(`  -> FAILED ${what}: HTTP ${r.status} ${e ? `${e.errorCode}: ${e.message}` : ''}`);
}

const seenDeliveries = new Set<string>();
const seenKeys = new Set<string>();

async function processPayload(payload: unknown, label: string): Promise<void> {
  const mapped = mapOrderPaid(payload);
  if (!mapped.ok) {
    console.log(`[${label}] payload rejected by mapper: ${mapped.reason}`);
    return;
  }
  const ev = mapped.event;
  console.log(`[${label}] order ${ev.orderName}, customer ${redactEmail(ev.customer.email)}, consent=${ev.customer.marketingConsent}`);
  const ctx = await buildContext(ev.customer.email);
  console.log(`  context: account=${ctx.accountByDomain ? 'match' : 'none'}, existing=${ctx.existingByEmail ? ctx.existingByEmail.type : 'none'}`);
  const decision = decide(ev, ctx, CONFIG);
  if ('skip' in decision) {
    console.log(`  decision: skip(${decision.skip})`);
    return;
  }
  for (const op of decision.ops) {
    if (seenKeys.has(op.matchKey) && WRITE) {
      console.log(`  skipped: matchKey ${op.matchKey} already processed in this run`);
      continue;
    }
    await execute(op);
    seenKeys.add(op.matchKey);
  }
}

await authenticate();
console.log(`spike ready: ${WRITE ? 'WRITE MODE' : 'dry-run'}, API ${apiVersion}`);

const fileIdx = process.argv.indexOf('--file');
if (fileIdx !== -1) {
  await processPayload(JSON.parse(readFileSync(process.argv[fileIdx + 1], 'utf8')), 'file');
  console.log(`limit usage ratio: ${apiUsageRatio((await sf('GET', `/services/data/${apiVersion}/limits`)).limit)}`);
} else {
  if (WEBHOOK_SECRET === '') {
    console.log('Receiver mode needs SHOPIFY_WEBHOOK_SECRET in the environment.');
    process.exit(1);
  }
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const sig = typeof req.headers['x-shopify-hmac-sha256'] === 'string' ? req.headers['x-shopify-hmac-sha256'] : undefined;
      if (req.method !== 'POST' || !verifyShopifyHmac(raw, sig, WEBHOOK_SECRET)) {
        console.log('[reject 401] bad or missing signature');
        res.writeHead(401).end();
        return;
      }
      const webhookId = String(req.headers['x-shopify-webhook-id'] ?? '');
      if (webhookId !== '' && seenDeliveries.has(webhookId)) {
        console.log(`[dedupe] webhook-id ${webhookId.slice(0, 8)} already processed -> 200`);
        res.writeHead(200).end();
        return;
      }
      try {
        await processPayload(JSON.parse(raw.toString('utf8')), `webhook ${webhookId.slice(0, 8)}`);
        if (webhookId !== '') seenDeliveries.add(webhookId);
        res.writeHead(200).end();
      } catch (e) {
        console.log(`[error] ${e instanceof Error ? e.message : String(e)} -> 500 (Shopify will retry)`);
        res.writeHead(500).end();
      }
    });
  }).listen(PORT, '127.0.0.1', () => console.log(`listening on 127.0.0.1:${PORT}`));
}
