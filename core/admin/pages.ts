// Page renderers: pure functions from data to an HTML string. Every dynamic value is escaped by esc(); secrets are never inputs.

import { badge, csrfField, esc, layout, notice } from './html.ts';
import type { LogEntry } from '../worker/syncLog.ts';
import type { AuditEntry, ComplianceEntry, DeadJob } from '../queue/postgresAdminData.ts';

export interface ConnectionInfo {
  stored: boolean;
  loginUrl?: string;
  clientId?: string;
  lastVerifiedAt: string | null;
}

export interface RecipeView {
  name: string;
  enabled: boolean;
  dryRun: boolean;
  configured: boolean;
}

const MESSAGES: Record<string, [string, 'ok' | 'warn' | 'bad']> = {
  shop_added: ['Shop added. Next: connect Salesforce, then enable the recipe in dry-run.', 'ok'],
  connection_saved: ['Salesforce connection saved (the secret is stored encrypted and is never shown again). Use "Test connection".', 'ok'],
  verified_ok: ['The Salesforce connection works.', 'ok'],
  enabled_dry: ['Recipe enabled in DRY-RUN: it reads from Salesforce and logs what it would do, but writes nothing.', 'ok'],
  live: ['Recipe is now LIVE: it writes to Salesforce.', 'warn'],
  disabled: ['Recipe disabled (kill switch): no Salesforce calls from the next job on.', 'warn'],
  config_saved: ['Settings saved.', 'ok'],
  replayed: ['Jobs moved back to the queue; the worker will retry them.', 'ok'],
  nothing_to_replay: ['Nothing to replay.', 'warn'],
};

export function message(code: string | null | undefined): string {
  const m = code ? MESSAGES[code] : undefined;
  return m ? notice(m[0], m[1]) : '';
}

export function loginPage(error?: string): string {
  return layout({
    title: 'Sign in',
    nav: false,
    body: `<div class="card" style="max-width:380px;margin:60px auto"><h1>Sign in</h1>${error ? notice(error, 'bad') : ''}
<form method="post" action="/admin/login"><label for="password">Operator password</label>
<input id="password" type="password" name="password" autocomplete="current-password" required>
<p><button class="primary" type="submit">Sign in</button></p></form></div>`,
  });
}

export function dashboardPage(d: { csrf: string; msg?: string | null; shops: { shop: string; connected: boolean; mode: string; tone: 'ok' | 'warn' | 'bad' | 'mut' }[]; dead: number; audit: AuditEntry[] }): string {
  const rows = d.shops.map((s) => `<tr><td><a href="/admin/shops/${esc(s.shop)}">${esc(s.shop)}</a></td><td>${s.connected ? badge('connected', 'ok') : badge('no connection', 'warn')}</td><td>${badge(s.mode, s.tone)}</td></tr>`).join('');
  const audit = d.audit.map((a) => `<tr><td class="mut">${esc(a.at)}</td><td>${esc(a.action)}</td><td>${esc(a.shop ?? '')}</td><td>${esc(a.detail ?? '')}</td></tr>`).join('');
  return layout({
    title: 'Shops',
    csrf: d.csrf,
    body: `${message(d.msg)}<h1>Shops</h1>
<div class="card"><table><tr><th>Shop</th><th>Salesforce</th><th>Recipe R1</th></tr>${rows || '<tr><td colspan="3" class="mut">No shops yet.</td></tr>'}</table></div>
<div class="card"><h2>Add a shop</h2><form method="post" action="/admin/shops">${csrfField(d.csrf)}<label for="shop">Shop domain</label>
<input id="shop" type="text" name="shop" placeholder="my-store.myshopify.com" required><p><button class="primary" type="submit">Add</button></p></form></div>
<div class="card"><h2>Failed jobs</h2><p>${d.dead === 0 ? badge('none', 'ok') : badge(`${d.dead} waiting`, 'bad')} <a href="/admin/replay">Review and replay</a></p></div>
<div class="card"><h2>Recent admin actions</h2><table><tr><th>When (UTC)</th><th>Action</th><th>Shop</th><th>Note</th></tr>${audit || '<tr><td colspan="4" class="mut">Nothing yet.</td></tr>'}</table></div>`,
  });
}

// The outcomes a log can be filtered by (shared with the embedded app's log page).
export const LOG_OUTCOMES = ['created', 'updated', 'duplicate_detected', 'already_done', 'skipped', 'dry_run', 'recipe_disabled', 'unknown_topic', 'invalid_payload', 'retry', 'failed'];

const modeBadge = (r: RecipeView) => (!r.enabled ? badge(r.configured ? 'DISABLED' : 'not configured (disabled)', 'warn') : r.dryRun ? badge('DRY-RUN', 'ok') : badge('LIVE', 'bad'));

export function entriesTable(entries: LogEntry[]): string {
  const rows = entries.map((e) => {
    const tone = e.outcome === 'failed' ? 'bad' : e.outcome === 'retry' ? 'warn' : e.outcome === 'created' || e.outcome === 'updated' ? 'ok' : 'mut';
    const ops = (e.ops ?? []).map((o) => `${esc(o.kind)}: ${esc(o.outcome)}${o.sfId ? ` <code>${esc(o.sfId)}</code>` : ''}`).join('<br>');
    const why = [e.reason, e.errorClass, e.errorCode].filter(Boolean).map(esc).join(' · ');
    return `<tr><td class="mut">${esc(e.at)}</td><td>${badge(e.outcome, tone)}${e.dryRun ? ' <span class="mut">dry-run</span>' : ''}</td><td><code>${esc(e.objectId)}</code></td><td><code>${esc(e.webhookId)}</code></td><td>${why}</td><td>${ops}</td></tr>`;
  }).join('');
  return `<table><tr><th>When (UTC)</th><th>Outcome</th><th>Order</th><th>Webhook id</th><th>Reason</th><th>Operations</th></tr>${rows || '<tr><td colspan="6" class="mut">No entries.</td></tr>'}</table>`;
}

export function shopPage(d: {
  csrf: string; msg?: string | null; shop: string; recipe: RecipeView; conn: ConnectionInfo; entries: LogEntry[];
  form: Record<string, string | boolean>; errors?: string[]; connError?: string;
}): string {
  const f = d.form;
  const err = d.errors && d.errors.length ? notice(`Settings not saved: ${d.errors.join('; ')}`, 'bad') : '';
  const connErr = d.connError ? notice(d.connError, 'bad') : '';
  const shop = esc(d.shop);
  return layout({
    title: d.shop,
    csrf: d.csrf,
    body: `${message(d.msg)}${connErr}${err}<h1>${shop}</h1>
<div class="card"><h2>Salesforce connection</h2>
<p>${d.conn.stored ? badge('stored (encrypted)', 'ok') : badge('not set', 'warn')} ${d.conn.lastVerifiedAt ? `<span class="mut">last verified ${esc(d.conn.lastVerifiedAt)}</span>` : d.conn.stored ? '<span class="mut">not verified yet</span>' : ''}</p>
${d.conn.stored ? `<p class="mut">Org: ${esc(d.conn.loginUrl)} · client id: <code>${esc(d.conn.clientId)}</code></p>` : ''}
<form method="post" action="/admin/shops/${shop}/connection">${csrfField(d.csrf)}
<label for="loginUrl">My Domain URL</label><input id="loginUrl" type="text" name="loginUrl" placeholder="https://your-domain.my.salesforce.com" required>
<label for="clientId">Consumer key (client id)</label><input id="clientId" type="text" name="clientId" autocomplete="off" required>
<label for="clientSecret">Consumer secret</label><input id="clientSecret" type="password" name="clientSecret" autocomplete="off" required>
<p><button class="primary" type="submit">${d.conn.stored ? 'Replace connection' : 'Save connection'}</button></p></form>
${d.conn.stored ? `<form method="post" action="/admin/shops/${shop}/verify">${csrfField(d.csrf)}<button type="submit">Test connection</button></form>` : ''}</div>
<div class="card"><h2>Recipe R1 · ${esc(d.recipe.name)}</h2><p>Mode: ${modeBadge(d.recipe)}</p>
<div class="row">
<form method="post" action="/admin/shops/${shop}/recipe">${csrfField(d.csrf)}<input type="hidden" name="action" value="enable_dry"><button class="primary" type="submit">Enable in dry-run</button></form>
<form method="post" action="/admin/shops/${shop}/recipe">${csrfField(d.csrf)}<input type="hidden" name="action" value="disable"><button class="danger" type="submit">Kill switch: disable</button></form></div>
<form method="post" action="/admin/shops/${shop}/recipe" style="margin-top:12px">${csrfField(d.csrf)}<input type="hidden" name="action" value="go_live">
<label for="confirm">Go live: type LIVE to confirm that this writes Leads and Tasks to Salesforce</label>
<div class="row"><input id="confirm" type="text" name="confirm" autocomplete="off" style="max-width:160px"><button type="submit">Go live</button></div></form></div>
<div class="card"><h2>Settings</h2><form method="post" action="/admin/shops/${shop}/config">${csrfField(d.csrf)}
<label for="leadSource">Lead source (a value from your Salesforce picklist)</label><input id="leadSource" type="text" name="leadSource" value="${esc(f.leadSource)}">
<label for="minOrderTotal">Minimum order total</label><input id="minOrderTotal" type="text" name="minOrderTotal" value="${esc(f.minOrderTotal)}">
<label><input type="checkbox" name="requireConsent" ${f.requireConsent ? 'checked' : ''}> Only customers who accepted marketing (strongly recommended; you are responsible for your lawful basis if you turn this off)</label>
<label for="existingLeadAction">When the email is already a Lead</label><select id="existingLeadAction" name="existingLeadAction">
<option value="update" ${f.existingLeadAction === 'update' ? 'selected' : ''}>Add the order to the Lead's description</option><option value="skip" ${f.existingLeadAction === 'skip' ? 'selected' : ''}>Skip</option></select>
<label for="companyOverride">Company name override (leave empty to use the billing company or the email domain)</label><input id="companyOverride" type="text" name="companyOverride" value="${esc(f.companyOverride)}">
<label for="leadOwnerId">Default Lead owner (Salesforce User id, 005...; empty = the integration user)</label><input id="leadOwnerId" type="text" name="leadOwnerId" value="${esc(f.leadOwnerId)}">
<label for="allowDomains">Always allow these email domains (one per line)</label><textarea id="allowDomains" name="allowDomains">${esc(f.allowDomains)}</textarea>
<label for="denyDomains">Never create Leads for these domains (one per line)</label><textarea id="denyDomains" name="denyDomains">${esc(f.denyDomains)}</textarea>
<label for="freeEmailBlocklist">Free-mail domains to skip (one per line)</label><textarea id="freeEmailBlocklist" name="freeEmailBlocklist">${esc(f.freeEmailBlocklist)}</textarea>
<p><button class="primary" type="submit">Save settings</button></p></form></div>
<div class="card"><h2>Recent activity</h2>${entriesTable(d.entries)}<p><a href="/admin/shops/${shop}/log">Full log</a></p></div>`,
  });
}

export function logPage(d: { csrf: string; shop: string; entries: LogEntry[]; outcome: string; page: number; hasNext: boolean }): string {
  const shop = esc(d.shop);
  const q = (page: number) => `?page=${page}${d.outcome ? `&outcome=${encodeURIComponent(d.outcome)}` : ''}`;
  const outcomes = ['', ...LOG_OUTCOMES];
  return layout({
    title: `${d.shop} log`,
    csrf: d.csrf,
    body: `<h1>${shop} · log</h1><p><a href="/admin/shops/${shop}">&larr; back</a></p>
<form method="get" action="/admin/shops/${shop}/log" class="row"><label for="outcome" style="margin:0">Outcome</label>
<select id="outcome" name="outcome" style="max-width:220px">${outcomes.map((o) => `<option value="${esc(o)}" ${o === d.outcome ? 'selected' : ''}>${o === '' ? 'all' : esc(o)}</option>`).join('')}</select><button type="submit">Filter</button></form>
<div class="card">${entriesTable(d.entries)}</div>
<p class="row">${d.page > 1 ? `<a href="${esc(q(d.page - 1))}">&larr; newer</a>` : ''}<span class="mut">page ${d.page}</span>${d.hasNext ? `<a href="${esc(q(d.page + 1))}">older &rarr;</a>` : ''}</p>
<p class="mut">Personal values are masked in the log, and the order payload is never stored in it.</p>`,
  });
}

export function replayPage(d: { csrf: string; msg?: string | null; jobs: DeadJob[] }): string {
  const rows = d.jobs.map((j) => `<tr><td class="mut">${esc(j.deadAt)}</td><td>${esc(j.shop)}</td><td>${esc(j.topic)}</td><td><code>${esc(j.businessKey)}</code></td>
<td><form method="post" action="/admin/replay">${csrfField(d.csrf)}<input type="hidden" name="id" value="${esc(j.id)}"><button type="submit">Replay</button></form></td></tr>`).join('');
  return layout({
    title: 'Failed jobs',
    csrf: d.csrf,
    body: `${message(d.msg)}<h1>Failed jobs</h1>
<p class="mut">These jobs failed after all retries. Replaying moves a job back to the queue (for example after fixing the Salesforce connection). The order payload is kept for 14 days and is not shown here.</p>
<div class="card"><table><tr><th>Failed (UTC)</th><th>Shop</th><th>Topic</th><th>Order</th><th></th></tr>${rows || '<tr><td colspan="5" class="mut">No failed jobs.</td></tr>'}</table></div>
${d.jobs.length ? `<form method="post" action="/admin/replay">${csrfField(d.csrf)}<input type="hidden" name="id" value="all"><button class="primary" type="submit">Replay all (${d.jobs.length})</button></form>` : ''}`,
  });
}

const KIND_TEXT: Record<string, string> = {
  'customers/redact': 'Customer data deleted',
  'customers/data_request': 'Customer data report',
  'shop/redact': 'Shop data erased',
  'app/uninstalled': 'App uninstalled',
};

export function compliancePage(d: { csrf: string; entries: ComplianceEntry[] }): string {
  const rows = d.entries.map((e) => `<tr><td class="mut">${esc(e.at)}</td><td>${esc(KIND_TEXT[e.kind] ?? e.kind)}<br><span class="mut"><code>${esc(e.kind)}</code></span></td><td>${esc(e.shop)}</td><td><code>${esc(e.requestRef)}</code></td><td><a href="/admin/compliance/${esc(e.id)}">Details</a></td></tr>`).join('');
  return layout({
    title: 'Compliance',
    csrf: d.csrf,
    body: `<h1>Privacy requests</h1>
<p class="mut">Shopify sends these when a customer asks for their data or deletion, and when a store uninstalls the app. Each one is handled automatically and recorded here. This record contains no personal data.</p>
<div class="card"><table><tr><th>When (UTC)</th><th>What happened</th><th>Shop</th><th>Request</th><th></th></tr>${rows || '<tr><td colspan="5" class="mut">No requests yet.</td></tr>'}</table></div>`,
  });
}

export function complianceDetailPage(d: { csrf: string; entry: ComplianceEntry }): string {
  const e = d.entry;
  const detail = e.detail as Record<string, any>;
  const records: string[] = Array.isArray(detail.salesforceRecordsToReview) ? detail.salesforceRecordsToReview.map(String) : [];
  return layout({
    title: 'Compliance request',
    csrf: d.csrf,
    body: `<h1>${esc(KIND_TEXT[e.kind] ?? e.kind)}</h1><p><a href="/admin/compliance">&larr; back</a></p>
<div class="card"><p>Shop: <b>${esc(e.shop)}</b> &middot; <span class="mut">${esc(e.at)} &middot; request <code>${esc(e.requestRef)}</code></span></p>
${records.length ? `<h2>Salesforce records to review</h2><p class="mut">This app cannot delete in Salesforce (it has no delete permission, by design). These Leads and Tasks were written for the orders above; review or delete them in Salesforce if your data-protection duties require it.</p><p>${records.map((r) => `<code>${esc(r)}</code>`).join(' ')}</p>` : ''}
<h2>Record</h2><pre style="white-space:pre-wrap;word-break:break-word;font-size:12px">${esc(JSON.stringify(e.detail, null, 2))}</pre></div>`,
  });
}
