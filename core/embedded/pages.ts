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

export interface HomeData {
  shop: string;
  connection: { stored: boolean; lastVerifiedAt: string | null };
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
<s-paragraph><s-text color="subdued">${next ? `${esc(next)} ` : ''}Connecting, settings, the go-live switch and replay move into this page next; until then use the ${operator}.</s-text></s-paragraph>
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
