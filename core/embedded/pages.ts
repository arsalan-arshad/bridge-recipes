// Page fragments for the embedded app: pure functions from data to an HTML string made of Polaris web components
// (https://shopify.dev/docs/api/app-home/v2.0). THE RULE is the same as for the admin pages: every dynamic value goes through esc().
// Navigation is a `data-view` attribute holding one of OUR /app/api/ paths; the browser script loads it (no inline handlers).

import { esc } from '../admin/html.ts';
import { LOG_OUTCOMES } from '../admin/pages.ts';
import type { LogEntry } from '../worker/syncLog.ts';

export const PAGE_SIZE = 50;
export const HOME_SAMPLE = 100; // the home page summarises the latest decisions, not all history

export { LOG_OUTCOMES };

type Tone = 'success' | 'caution' | 'critical' | 'neutral';

const badge = (text: string, tone: Tone) => `<s-badge tone="${tone}">${esc(text)}</s-badge>`;

function outcomeTone(outcome: string): Tone {
  if (outcome === 'failed') return 'critical';
  if (outcome === 'retry') return 'caution';
  if (outcome === 'created' || outcome === 'updated') return 'success';
  return 'neutral';
}

const view = (path: string, label: string, variant = 'tertiary') => `<s-button variant="${variant}" data-view="${esc(path)}">${esc(label)}</s-button>`;

function decisionsTable(entries: LogEntry[], full: boolean): string {
  const head = full
    ? '<s-table-header>When (UTC)</s-table-header><s-table-header>Outcome</s-table-header><s-table-header>Order</s-table-header><s-table-header>Webhook id</s-table-header><s-table-header>Reason</s-table-header><s-table-header>Operations</s-table-header>'
    : '<s-table-header>When (UTC)</s-table-header><s-table-header>Outcome</s-table-header><s-table-header>Order</s-table-header><s-table-header>Reason</s-table-header>';
  const rows = entries.map((e) => {
    const why = [e.reason, e.errorClass, e.errorCode].filter(Boolean).map(esc).join(' · ');
    const outcome = `${badge(e.outcome, outcomeTone(e.outcome))}${e.dryRun ? ' <s-text color="subdued">dry-run</s-text>' : ''}`;
    const ops = (e.ops ?? []).map((o) => `${esc(o.kind)}: ${esc(o.outcome)}${o.sfId ? ` <s-text type="code">${esc(o.sfId)}</s-text>` : ''}`).join('<br>');
    const cells = full
      ? `<s-table-cell>${esc(e.at)}</s-table-cell><s-table-cell>${outcome}</s-table-cell><s-table-cell><s-text type="code">${esc(e.objectId)}</s-text></s-table-cell><s-table-cell><s-text type="code">${esc(e.webhookId)}</s-text></s-table-cell><s-table-cell>${why}</s-table-cell><s-table-cell>${ops}</s-table-cell>`
      : `<s-table-cell>${esc(e.at)}</s-table-cell><s-table-cell>${outcome}</s-table-cell><s-table-cell><s-text type="code">${esc(e.objectId)}</s-text></s-table-cell><s-table-cell>${why}</s-table-cell>`;
    return `<s-table-row>${cells}</s-table-row>`;
  }).join('');
  if (entries.length === 0) return '<s-paragraph>No decisions yet.</s-paragraph>';
  return `<s-table><s-table-header-row>${head}</s-table-header-row><s-table-body>${rows}</s-table-body></s-table>`;
}

export interface ConnectionView {
  stored: boolean;
  lastVerifiedAt: string | null;
  loginUrl?: string; // shown so the operator can see which org it points at; the secret is never part of the data
  clientId?: string;
}

export interface HomeData {
  shop: string;
  connection: ConnectionView;
  recipe: { name: string; configured: boolean; enabled: boolean; dryRun: boolean };
  recent: LogEntry[]; // newest first, at most HOME_SAMPLE
  failedJobs: number;
}

export function homeFragment(d: HomeData): string {
  const r = d.recipe;
  const mode = !r.enabled ? badge(r.configured ? 'DISABLED' : 'NOT CONFIGURED', 'caution') : r.dryRun ? badge('DRY-RUN', 'success') : badge('LIVE', 'critical');
  const banner = r.enabled && !r.dryRun
    ? '<s-banner tone="warning" heading="Recipe R1 is LIVE">Qualifying orders from this store are written to Salesforce as Leads and Tasks.</s-banner>'
    : !r.enabled
      ? '<s-banner tone="info" heading="Recipe R1 is off">No orders are processed or written until it is enabled.</s-banner>'
      : '<s-banner tone="info" heading="Recipe R1 is in dry-run">It reads from Salesforce and logs what it would do, but writes nothing.</s-banner>';

  const conn = d.connection.stored
    ? `${badge('stored', 'success')} <s-text color="subdued">${d.connection.lastVerifiedAt ? `last verified ${esc(d.connection.lastVerifiedAt)}` : 'not verified yet'}</s-text>`
    : badge('not set', 'caution');
  const failed = d.failedJobs === 0 ? badge('none', 'success') : badge(`${d.failedJobs} waiting`, 'critical');

  const counts = new Map<string, number>();
  for (const e of d.recent) counts.set(e.outcome, (counts.get(e.outcome) ?? 0) + 1);
  const countBadges = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${badge(`${o} ${n}`, outcomeTone(o))}`).join(' ');

  const next = !d.connection.stored
    ? 'Next step: connect Salesforce.'
    : !r.configured
      ? 'Next step: enable the recipe in dry-run.'
      : '';
  const operator = '<s-link href="/admin" target="_blank">operator admin page</s-link>';

  return `<s-page heading="Bridge Recipes">${banner}
<s-section heading="Setup">
<s-paragraph>Salesforce connection: ${conn}</s-paragraph>
<s-paragraph>${esc(r.name)}: ${mode}</s-paragraph>
<s-paragraph>Failed jobs: ${failed}</s-paragraph>
<s-paragraph><s-text color="subdued">${next ? `${esc(next)} ` : ''}Going live is done from the ${operator}.</s-text></s-paragraph>
<s-paragraph>${view('/app/api/setup', 'Set up Salesforce and the recipe', 'primary')} ${view('/app/api/settings', 'Recipe settings')} ${view('/app/api/jobs', d.failedJobs === 0 ? 'Failed jobs' : `Failed jobs (${d.failedJobs})`)}</s-paragraph>
</s-section>
<s-section heading="Latest decisions">
${d.recent.length === 0 ? '<s-paragraph>No orders have been processed for this store yet.</s-paragraph>' : `<s-paragraph>Last ${d.recent.length} decision${d.recent.length === 1 ? '' : 's'}: ${countBadges}</s-paragraph>${decisionsTable(d.recent.slice(0, 5), false)}`}
<s-paragraph>${view('/app/api/log', 'Open the full log')}</s-paragraph>
</s-section></s-page>`;
}

export interface LogData {
  shop: string;
  outcome: string; // '' = all; otherwise one of LOG_OUTCOMES
  page: number; // 1-based
  entries: LogEntry[]; // this page, at most PAGE_SIZE
  hasNext: boolean;
}

export function logPath(outcome: string, page: number): string {
  const q: string[] = [];
  if (outcome !== '') q.push(`outcome=${encodeURIComponent(outcome)}`);
  if (page > 1) q.push(`page=${page}`);
  return `/app/api/log${q.length ? `?${q.join('&')}` : ''}`;
}

export function logFragment(d: LogData): string {
  const filters = ['', ...LOG_OUTCOMES].map((o) => view(logPath(o, 1), o === '' ? 'all' : o, o === d.outcome ? 'primary' : 'tertiary')).join(' ');
  const paging = `${d.page > 1 ? view(logPath(d.outcome, d.page - 1), 'Newer') : ''} <s-text color="subdued">page ${esc(d.page)}</s-text> ${d.hasNext ? view(logPath(d.outcome, d.page + 1), 'Older') : ''}`;
  return `<s-page heading="Decision log">
<s-section><s-paragraph>${view('/app/api/home', 'Back to home')}</s-paragraph><s-paragraph>Show: ${filters}</s-paragraph></s-section>
<s-section padding="none">${decisionsTable(d.entries, true)}</s-section>
<s-section><s-paragraph>${paging}</s-paragraph><s-paragraph><s-text color="subdued">Personal values are masked in the log, and the order payload is never stored in it.</s-text></s-paragraph></s-section></s-page>`;
}

// ---- setup page: the Salesforce connection and the recipe controls (the first screens that WRITE) --------------------------------------------

// What the operator is told after an action (codes come from core/admin/actions.ts). Fixed text only.
export const NOTICES: Record<string, { tone: 'success' | 'warning'; text: string }> = {
  connection_saved: { tone: 'success', text: 'Salesforce connection saved. The secret is stored encrypted and is never shown again. Use "Test connection".' },
  verified_ok: { tone: 'success', text: 'The Salesforce connection works.' },
  config_saved: { tone: 'success', text: 'Settings saved.' },
  replayed: { tone: 'success', text: 'Jobs moved back to the queue; the worker will retry them.' },
  nothing_to_replay: { tone: 'warning', text: 'Nothing to replay.' },
  enabled_dry: { tone: 'success', text: 'Recipe enabled in DRY-RUN: it reads from Salesforce and logs what it would do, but writes nothing.' },
  disabled: { tone: 'warning', text: 'Recipe disabled (kill switch): no Salesforce calls from the next job on.' },
};

export interface SetupData {
  shop: string;
  connection: ConnectionView;
  recipe: { name: string; configured: boolean; enabled: boolean; dryRun: boolean };
  msg?: string; // a key of NOTICES
  errors?: string[]; // settings/go-live problems (fixed or validated text)
  connError?: string; // a connection problem (already free of secrets)
}

// The consumer key identifies the Salesforce app; staff do not need all of it. Show only the end, and nothing for a short one.
export function maskKey(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : '••••';
}

const field = (label: string, name: string, extra = '') => `<s-text-field label="${esc(label)}" name="${esc(name)}" autocomplete="off" ${extra}></s-text-field>`;

export function setupFragment(d: SetupData): string {
  const r = d.recipe;
  const mode = !r.enabled ? badge(r.configured ? 'DISABLED' : 'NOT CONFIGURED', 'caution') : r.dryRun ? badge('DRY-RUN', 'success') : badge('LIVE', 'critical');
  const note = d.msg && Object.hasOwn(NOTICES, d.msg) ? `<s-banner tone="${NOTICES[d.msg].tone}">${esc(NOTICES[d.msg].text)}</s-banner>` : '';
  const problems = d.errors && d.errors.length ? `<s-banner tone="critical" heading="Not done">${d.errors.map(esc).join('; ')}</s-banner>` : '';
  const connProblem = d.connError ? `<s-banner tone="critical" heading="Connection problem">${esc(d.connError)}</s-banner>` : '';
  const c = d.connection;
  const status = c.stored
    ? `${badge('stored (encrypted)', 'success')} <s-text color="subdued">${c.lastVerifiedAt ? `last verified ${esc(c.lastVerifiedAt)}` : 'not verified yet'}</s-text>${c.loginUrl ? `<br><s-text color="subdued">Org: ${esc(c.loginUrl)}${c.clientId ? ` · client id: ${esc(maskKey(c.clientId))}` : ''}</s-text>` : ''}`
    : badge('not set', 'caution');
  const post = (path: string, inner: string) => `<form data-post="${esc(path)}">${inner}</form>`;
  const act = (value: string) => `<input type="hidden" name="action" value="${esc(value)}">`;
  return `<s-page heading="Set up">
<s-section><s-paragraph>${view('/app/api/home', 'Back to home')}</s-paragraph></s-section>
${note}${connProblem}${problems}
<s-section heading="Salesforce connection">
<s-paragraph>${status}</s-paragraph>
${post('/app/api/connection', `${field('My Domain URL', 'loginUrl', 'placeholder="https://your-domain.my.salesforce.com"')}
${field('Consumer key (client id)', 'clientId')}
<s-password-field label="Consumer secret" name="clientSecret" autocomplete="off"></s-password-field>
<s-button variant="primary" data-submit>${c.stored ? 'Replace connection' : 'Save connection'}</s-button>`)}
${c.stored ? post('/app/api/verify', '<s-button data-submit>Test connection</s-button>') : ''}
</s-section>
<s-section heading="${esc(r.name)}">
<s-paragraph>Mode: ${mode}</s-paragraph>
${post('/app/api/recipe', `${act('enable_dry')}<s-button variant="primary" data-submit>Enable in dry-run</s-button>`)}
${post('/app/api/recipe', `${act('disable')}<s-button tone="critical" data-submit>Kill switch: disable</s-button>`)}
<s-paragraph><s-text color="subdued">Going live (writing Leads and Tasks to Salesforce) is not done from here: it needs the operator password, on the <s-link href="/admin" target="_blank">operator admin page</s-link>. From here you can connect, test, run in dry-run, and switch the recipe off.</s-text></s-paragraph>
</s-section></s-page>`;
}

// ---- settings page: the recipe's own settings (the same fields as the operator page) ------------------------------------------------------------

export interface SettingsData {
  shop: string;
  form: Record<string, string | boolean>; // the stored settings, or what the operator just typed when it was refused
  msg?: string;
  errors?: string[];
}

const text = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null || v === false ? '' : String(v));

export function settingsFragment(d: SettingsData): string {
  const f = d.form;
  const note = d.msg && Object.hasOwn(NOTICES, d.msg) ? `<s-banner tone="${NOTICES[d.msg].tone}">${esc(NOTICES[d.msg].text)}</s-banner>` : '';
  const problems = d.errors && d.errors.length ? `<s-banner tone="critical" heading="Settings not saved">${d.errors.map(esc).join('; ')}</s-banner>` : '';
  const area = (label: string, name: string) => `<s-text-area label="${esc(label)}" name="${esc(name)}" rows="4" value="${esc(text(f[name]))}"></s-text-area>`;
  const input = (label: string, name: string) => `<s-text-field label="${esc(label)}" name="${esc(name)}" autocomplete="off" value="${esc(text(f[name]))}"></s-text-field>`;
  const existing = text(f.existingLeadAction) === 'skip' ? 'skip' : 'update';
  return `<s-page heading="Recipe settings">
<s-section><s-paragraph>${view('/app/api/home', 'Back to home')}</s-paragraph></s-section>
${note}${problems}
<s-section heading="Lead Spotter settings">
<form data-post="/app/api/settings">
${input('Lead source (a value from your Salesforce picklist)', 'leadSource')}
${input('Minimum order total', 'minOrderTotal')}
<s-checkbox label="Only customers who accepted marketing (strongly recommended; you are responsible for your lawful basis if you turn this off)" name="requireConsent"${f.requireConsent === true ? ' checked' : ''}></s-checkbox>
<s-select label="When the email is already a Lead" name="existingLeadAction" value="${esc(existing)}"><s-option value="update">Add the order to the Lead's description</s-option><s-option value="skip">Skip</s-option></s-select>
${input('Company name override (leave empty to use the billing company or the email domain)', 'companyOverride')}
${input('Default Lead owner (Salesforce User id, 005...; empty = the integration user)', 'leadOwnerId')}
${area('Always allow these email domains (one per line)', 'allowDomains')}
${area('Never create Leads for these domains (one per line)', 'denyDomains')}
${area('Free-mail domains to skip (one per line)', 'freeEmailBlocklist')}
<s-button variant="primary" data-submit>Save settings</s-button>
</form>
<s-paragraph><s-text color="subdued">Saving settings never changes whether the recipe is on or live.</s-text></s-paragraph>
</s-section></s-page>`;
}

// ---- failed jobs page: this shop's jobs that ran out of retries, with replay -------------------------------------------------------------------

export interface JobView {
  id: string;
  topic: string;
  businessKey: string;
  webhookId: string;
  deadAt: string;
}

export interface JobsData {
  shop: string;
  jobs: JobView[]; // ONLY this shop's
  msg?: string;
  errors?: string[];
}

export function jobsFragment(d: JobsData): string {
  const note = d.msg && Object.hasOwn(NOTICES, d.msg) ? `<s-banner tone="${NOTICES[d.msg].tone}">${esc(NOTICES[d.msg].text)}</s-banner>` : '';
  const problems = d.errors && d.errors.length ? `<s-banner tone="critical" heading="Not done">${d.errors.map(esc).join('; ')}</s-banner>` : '';
  const rows = d.jobs.map((j) => `<s-table-row><s-table-cell>${esc(j.deadAt)}</s-table-cell><s-table-cell>${esc(j.topic)}</s-table-cell><s-table-cell><s-text type="code">${esc(j.businessKey)}</s-text></s-table-cell><s-table-cell><form data-post="/app/api/replay"><input type="hidden" name="id" value="${esc(j.id)}"><s-button data-submit>Replay</s-button></form></s-table-cell></s-table-row>`).join('');
  const table = d.jobs.length === 0
    ? '<s-paragraph>No failed jobs.</s-paragraph>'
    : `<s-table><s-table-header-row><s-table-header>Failed (UTC)</s-table-header><s-table-header>Topic</s-table-header><s-table-header>Order</s-table-header><s-table-header></s-table-header></s-table-header-row><s-table-body>${rows}</s-table-body></s-table>`;
  const all = d.jobs.length === 0 ? '' : `<s-paragraph><form data-post="/app/api/replay"><input type="hidden" name="id" value="all"><s-button variant="primary" data-submit>Replay all (${esc(d.jobs.length)})</s-button></form></s-paragraph>`;
  return `<s-page heading="Failed jobs">
<s-section><s-paragraph>${view('/app/api/home', 'Back to home')}</s-paragraph></s-section>
${note}${problems}
<s-section padding="none">${table}</s-section>
<s-section><s-paragraph><s-text color="subdued">These jobs failed after all retries. Replaying moves a job back to the queue (for example after fixing the Salesforce connection). The order payload is kept for 14 days and is never shown here. You can only replay this store's jobs.</s-text></s-paragraph>${all}</s-section></s-page>`;
}
