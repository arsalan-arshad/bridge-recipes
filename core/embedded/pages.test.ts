import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeFragment, logFragment, logPath, setupFragment, LOG_OUTCOMES, NOTICES } from './pages.ts';
import type { HomeData, SetupData } from './pages.ts';
import type { LogEntry } from '../worker/syncLog.ts';

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  at: '2026-10-26T11:04:43.489Z', shop: 's.myshopify.com', objectId: 'gid://shopify/Order/1', webhookId: 'wh-1', outcome: 'dry_run', dryRun: true,
  ops: [{ kind: 'createLead', outcome: 'planned' }], ...over,
} as LogEntry);

const home = (over: Partial<HomeData> = {}): HomeData => ({
  shop: 's.myshopify.com',
  connection: { stored: true, lastVerifiedAt: '2026-10-26T10:00:00Z' },
  recipe: { name: 'Lead Spotter', configured: true, enabled: true, dryRun: true },
  recent: [entry()], failedJobs: 0, ...over,
});

const HOSTILE = `<img src=x onerror=alert(1)>"'\`&`;
const escaped = (html: string) => !html.includes('<img') && !html.includes('onerror=alert') && !/[^&]"'`&[^a]/.test(html);

test('home: the mode banner and badge follow the recipe state (off, dry-run, live)', () => {
  const live = homeFragment(home({ recipe: { name: 'R', configured: true, enabled: true, dryRun: false } }));
  assert.ok(live.includes('tone="warning" heading="Recipe R1 is LIVE"') && live.includes('<s-badge tone="critical">LIVE</s-badge>'));
  const dry = homeFragment(home());
  assert.ok(dry.includes('heading="Recipe R1 is in dry-run"') && dry.includes('<s-badge tone="success">DRY-RUN</s-badge>') && !dry.includes('LIVE'));
  const off = homeFragment(home({ recipe: { name: 'R', configured: true, enabled: false, dryRun: true } }));
  assert.ok(off.includes('heading="Recipe R1 is off"') && off.includes('DISABLED') && !off.includes('is in dry-run'));
  const none = homeFragment(home({ recipe: { name: 'R', configured: false, enabled: false, dryRun: true } }));
  assert.ok(none.includes('NOT CONFIGURED') && none.includes('Next step: enable the recipe in dry-run.'));
});

test('home: connection, next step and failed jobs', () => {
  assert.ok(homeFragment(home({ connection: { stored: false, lastVerifiedAt: null } })).includes('<s-badge tone="caution">not set</s-badge>'));
  assert.ok(homeFragment(home({ connection: { stored: false, lastVerifiedAt: null } })).includes('Next step: connect Salesforce.'));
  assert.ok(homeFragment(home({ connection: { stored: true, lastVerifiedAt: null } })).includes('not verified yet'));
  assert.ok(homeFragment(home()).includes('last verified 2026-10-26T10:00:00Z'));
  assert.ok(homeFragment(home({ failedJobs: 3 })).includes('<s-badge tone="critical">3 waiting</s-badge>'));
  assert.ok(homeFragment(home({ failedJobs: 0 })).includes('<s-badge tone="success">none</s-badge>'));
  assert.ok(!homeFragment(home()).includes('Next step'));
});

test('home: outcome counts are over what was given, sorted by count, with the right tones; only five rows are shown', () => {
  const recent = [entry({ outcome: 'failed' }), entry({ outcome: 'created' }), entry({ outcome: 'created' }), entry({ outcome: 'retry' }), entry({ outcome: 'skipped' }), entry({ outcome: 'skipped' }), entry({ outcome: 'skipped' })];
  const html = homeFragment(home({ recent }));
  assert.ok(html.includes('Last 7 decisions'));
  assert.ok(html.indexOf('skipped 3') < html.indexOf('created 2') && html.indexOf('created 2') < html.indexOf('failed 1'));
  assert.ok(html.includes('<s-badge tone="success">created 2</s-badge>') && html.includes('<s-badge tone="critical">failed 1</s-badge>') && html.includes('<s-badge tone="caution">retry 1</s-badge>') && html.includes('<s-badge tone="neutral">skipped 3</s-badge>'));
  assert.equal(html.split('<s-table-row>').length - 1, 5);
  assert.ok(homeFragment(home({ recent: [entry()] })).includes('Last 1 decision:'));
});

test('home: an empty log says so and shows no table', () => {
  const html = homeFragment(home({ recent: [] }));
  assert.ok(html.includes('No orders have been processed for this store yet.') && !html.includes('<s-table>'));
});

test('every dynamic value is escaped (log fields, shop, recipe name, times, ids)', () => {
  const bad = entry({ reason: HOSTILE, errorClass: HOSTILE, errorCode: HOSTILE, objectId: HOSTILE, webhookId: HOSTILE, at: HOSTILE, ops: [{ kind: HOSTILE, outcome: HOSTILE, sfId: HOSTILE }] } as any);
  for (const html of [
    homeFragment(home({ recent: [bad], recipe: { name: HOSTILE, configured: true, enabled: true, dryRun: true }, connection: { stored: true, lastVerifiedAt: HOSTILE } })),
    logFragment({ shop: HOSTILE, outcome: '', page: 1, entries: [bad], hasNext: false }),
  ]) {
    assert.ok(!html.includes('<img'), 'raw tag');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'shown as text');
    assert.ok(!html.includes('<script'), 'no script');
  }
  const odd = entry({ outcome: HOSTILE as any });
  assert.ok(!homeFragment(home({ recent: [odd] })).includes('<img'));
});

test('navigation: every data-view is one of our /app/api/ paths and nothing else carries a link target', () => {
  const html = homeFragment(home()) + logFragment({ shop: 's', outcome: 'failed', page: 3, entries: [entry()], hasNext: true });
  const views = [...html.matchAll(/data-view="([^"]*)"/g)].map((m) => m[1].replaceAll('&amp;', '&')); // the browser decodes &amp; in attributes
  assert.ok(views.length > 10);
  for (const v of views) assert.match(v, /^\/app\/api\/(home|log|setup)(\?[a-z_=&0-9]*)?$/, v);
  assert.ok(!/href="(?!\/admin")/.test(html), 'the only href is the operator admin link');
  assert.ok(html.includes('<s-link href="/admin" target="_blank">'), 'the operator page opens in a new tab (it cannot be framed)');
});

test('log: filters cover every outcome plus all, the active one is primary, and paging links keep the filter', () => {
  const html = logFragment({ shop: 's', outcome: 'failed', page: 2, entries: [entry()], hasNext: true });
  for (const o of LOG_OUTCOMES) assert.ok(html.includes(`data-view="/app/api/log?outcome=${o}"`), o);
  assert.ok(html.includes('data-view="/app/api/log"') && html.includes('>all<'));
  assert.equal(html.split('variant="primary"').length - 1, 1);
  assert.ok(html.includes('<s-button variant="primary" data-view="/app/api/log?outcome=failed">failed</s-button>'));
  assert.ok(html.includes('data-view="/app/api/log?outcome=failed"') && html.includes('data-view="/app/api/log?outcome=failed&amp;page=3"'));
  assert.ok(html.includes('page 2'));
  const deep = logFragment({ shop: 's', outcome: 'failed', page: 3, entries: [entry()], hasNext: true });
  assert.ok(deep.includes('data-view="/app/api/log?outcome=failed&amp;page=2"') && deep.includes('>Newer<'), 'Newer from page 3 keeps the filter');
  assert.ok(deep.includes('data-view="/app/api/log?outcome=failed&amp;page=4"') && deep.includes('>Older<'), 'Older keeps it too');
  assert.equal(logPath('', 1), '/app/api/log');
  assert.equal(logPath('failed', 1), '/app/api/log?outcome=failed');
  assert.equal(logPath('', 4), '/app/api/log?page=4');
  assert.equal(logPath('failed', 2), '/app/api/log?outcome=failed&page=2');
});

test('log: the full table has webhook id and operations; an empty page says so', () => {
  const html = logFragment({ shop: 's', outcome: '', page: 1, entries: [entry({ ops: [{ kind: 'createLead', outcome: 'created', sfId: '00Qxx0000012345' }] } as any)], hasNext: false });
  assert.ok(html.includes('Webhook id') && html.includes('createLead: created') && html.includes('00Qxx0000012345') && html.includes('wh-1'));
  assert.ok(logFragment({ shop: 's', outcome: '', page: 1, entries: [], hasNext: false }).includes('No decisions yet.'));
});

const setup = (over: Partial<SetupData> = {}): SetupData => ({
  shop: 's.myshopify.com', connection: { stored: false, lastVerifiedAt: null },
  recipe: { name: 'Lead Spotter', configured: false, enabled: false, dryRun: true }, ...over,
});

test('setup: the forms post only to our write routes, and the secret field is a password field that never carries a value', () => {
  const html = setupFragment(setup({ connection: { stored: true, lastVerifiedAt: '2026-10-26T10:00:00Z', loginUrl: 'https://acme.my.salesforce.com', clientId: 'KEY123' } }));
  const posts = [...html.matchAll(/<form data-post="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(posts, ['/app/api/connection', '/app/api/verify', '/app/api/recipe', '/app/api/recipe']);
  assert.ok(html.includes('<s-password-field label="Consumer secret" name="clientSecret" autocomplete="off"></s-password-field>'));
  assert.ok(!/<s-password-field[^>]*value=/.test(html), 'no value attribute on the secret field');
  assert.ok(html.includes('Org: https://acme.my.salesforce.com · client id: KEY123'));
  assert.ok(html.includes('Replace connection') && html.includes('Test connection'));
  assert.ok(html.includes('<s-badge tone="success">stored (encrypted)</s-badge>') && !html.includes('<s-badge tone="caution">not set</s-badge>'));
  const fresh = setupFragment(setup());
  assert.ok(fresh.includes('Save connection') && !fresh.includes('Test connection') && fresh.includes('<s-badge tone="caution">not set</s-badge>'));
});

test('setup: only the safe recipe actions are offered (no go-live), pointing to the operator page; the mode badge is right', () => {
  const html = setupFragment(setup());
  for (const a of ['enable_dry', 'disable']) assert.ok(html.includes(`name="action" value="${a}"`), a);
  assert.ok(!html.includes('go_live') && !html.includes('name="confirm"') && !html.includes('Go live</s-button>') && !html.includes('Type LIVE'));
  assert.ok(html.includes('<s-link href="/admin" target="_blank">operator admin page</s-link>') && html.includes('needs the operator password'));
  assert.ok(html.includes('NOT CONFIGURED'));
  assert.ok(setupFragment(setup({ recipe: { name: 'R', configured: true, enabled: true, dryRun: false } })).includes('<s-badge tone="critical">LIVE</s-badge>'));
  assert.ok(setupFragment(setup({ recipe: { name: 'R', configured: true, enabled: true, dryRun: true } })).includes('DRY-RUN'));
  assert.ok(setupFragment(setup({ recipe: { name: 'R', configured: true, enabled: false, dryRun: true } })).includes('<s-badge tone="caution">DISABLED</s-badge>'));
});

test('setup: notices come from a fixed list; unknown codes show nothing; problems are escaped', () => {
  for (const [code, n] of Object.entries(NOTICES)) assert.ok(setupFragment(setup({ msg: code })).includes(`<s-banner tone="${n.tone}">`), code);
  assert.ok(!setupFragment(setup({ msg: '<img src=x>' })).includes('<s-banner tone="success"'));
  for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.ok(!setupFragment(setup({ msg: code })).includes('<s-banner'), code);
  const bad = setupFragment(setup({ errors: [HOSTILE], connError: HOSTILE }));
  assert.ok(!bad.includes('<img') && bad.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(bad.includes('heading="Not done"') && bad.includes('heading="Connection problem"'));
  const org = setupFragment(setup({ connection: { stored: true, lastVerifiedAt: HOSTILE, loginUrl: HOSTILE, clientId: HOSTILE } }));
  assert.ok(!org.includes('<img'));
});

test('home links to the setup page', () => {
  assert.ok(homeFragment(home()).includes('<s-button variant="primary" data-view="/app/api/setup">'));
});
