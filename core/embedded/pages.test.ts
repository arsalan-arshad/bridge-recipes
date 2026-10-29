import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeFragment, jobsFragment, logFragment, logPath, maskKey, onboardingSteps, privacyDetailFragment, privacyFragment, settingsFragment, setupFragment, LOG_OUTCOMES, NOTICES } from './pages.ts';
import type { HomeData, JobsData, SetupData, SettingsData } from './pages.ts';
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
  assert.ok(logFragment({ shop: 's', outcome: '', page: 1, entries: [], hasNext: false }).includes('When a paid order arrives, each decision the recipe makes appears here.'));
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
  for (const v of views) assert.match(v, /^\/app\/api\/(home|log|setup|settings|jobs|privacy)(\?[a-z_=&0-9]*)?$/, v);
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
  assert.ok(html.includes('Org: https://acme.my.salesforce.com · client id: ••••') && !html.includes('KEY123'), 'a short key is fully masked');
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

test('the consumer key is shown masked: only the last four of a long one, nothing of a short one', () => {
  assert.equal(maskKey('FAKEKEY-abcdefghijkl-WXYZ'), '…WXYZ');
  assert.equal(maskKey('abcdefghi'), '…fghi');
  for (const short of ['', 'a', 'abcdefgh']) assert.equal(maskKey(short), '••••', JSON.stringify(short));
  const key = 'FAKEKEY-abcdefghijkl.SECRETISH-REST';
  const html = setupFragment(setup({ connection: { stored: true, lastVerifiedAt: null, loginUrl: 'https://a.my.salesforce.com', clientId: key } }));
  assert.ok(html.includes('client id: …REST') && !html.includes('FAKEKEY') && !html.includes('SECRETISH'));
  assert.ok(!setupFragment(setup({ connection: { stored: true, lastVerifiedAt: null, clientId: HOSTILE + 'abcdefgh' } })).includes('<img'));
});

const settings = (over: Partial<SettingsData> = {}): SettingsData => ({
  shop: 's.myshopify.com',
  form: { leadSource: 'Shopify Order', minOrderTotal: '50', requireConsent: true, existingLeadAction: 'update', companyOverride: '', leadOwnerId: '', allowDomains: 'a.com\nb.com', denyDomains: '', freeEmailBlocklist: 'gmail.com' },
  ...over,
});

test('settings: every field is present with its stored value, the form posts to the save route, and the mode is not part of it', () => {
  const html = settingsFragment(settings());
  assert.ok(html.includes('<form data-post="/app/api/settings">'));
  for (const n of ['leadSource', 'minOrderTotal', 'requireConsent', 'existingLeadAction', 'companyOverride', 'leadOwnerId', 'allowDomains', 'denyDomains', 'freeEmailBlocklist']) assert.ok(html.includes(`name="${n}"`), n);
  assert.ok(html.includes('name="leadSource" autocomplete="off" value="Shopify Order"') && html.includes('name="minOrderTotal" autocomplete="off" value="50"'));
  assert.ok(html.includes('name="requireConsent" checked></s-checkbox>'), 'consent on');
  assert.ok(settingsFragment(settings({ form: { ...settings().form, requireConsent: false } })).includes('name="requireConsent"></s-checkbox>'), 'consent off: no checked attribute');
  assert.ok(html.includes('name="existingLeadAction" value="update"'));
  assert.ok(settingsFragment(settings({ form: { ...settings().form, existingLeadAction: 'skip' } })).includes('name="existingLeadAction" value="skip"'));
  assert.ok(settingsFragment(settings({ form: { ...settings().form, existingLeadAction: '<img>' } })).includes('name="existingLeadAction" value="update"'), 'an unknown value falls back to update');
  assert.ok(!html.includes('name="action"') && !html.includes('go_live') && !html.includes('enable_dry'), 'no mode controls here');
  assert.ok(html.includes('Saving settings never changes whether the recipe is on or live.'));
});

test('settings: values and problems are escaped; notices come from the fixed list', () => {
  const form = { ...settings().form, leadSource: HOSTILE, allowDomains: HOSTILE, companyOverride: HOSTILE };
  const html = settingsFragment(settings({ form, errors: [HOSTILE], msg: 'config_saved' }));
  assert.ok(!html.includes('<img') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('heading="Settings not saved"') && html.includes('<s-banner tone="success">Settings saved.</s-banner>'));
  for (const code of ['__proto__', 'constructor']) assert.ok(!settingsFragment(settings({ msg: code })).includes('<s-banner'), code);
  assert.ok(!settingsFragment(settings({ form: {} })).includes('undefined'), 'missing values are empty, not "undefined"');
});

const jobs = (over: Partial<JobsData> = {}): JobsData => ({
  shop: 's.myshopify.com',
  jobs: [{ id: '11111111-1111-4111-8111-111111111111', topic: 'orders/paid', businessKey: 'orders/paid|s.myshopify.com|gid://shopify/Order/9', webhookId: 'w9', deadAt: '2026-10-26T12:00:00Z' }],
  ...over,
});

test('failed jobs: one row per job with a replay form for that id, replay all with the count, and an empty state', () => {
  const html = jobsFragment(jobs());
  assert.ok(html.includes('<input type="hidden" name="id" value="11111111-1111-4111-8111-111111111111">') && html.includes('Replay all (1)'));
  assert.ok(html.includes('<input type="hidden" name="id" value="all">'));
  assert.deepEqual([...html.matchAll(/<form data-post="([^"]*)"/g)].map((m) => m[1]), ['/app/api/replay', '/app/api/replay']);
  assert.ok(html.includes("You can only replay this store's jobs."));
  const none = jobsFragment(jobs({ jobs: [] }));
  assert.ok(none.includes('No failed jobs.') && !none.includes('<form') && !none.includes('Replay all') && !none.includes('<s-table>'));
  assert.ok(!html.includes('webhookId') && !html.includes('w9'), 'no payload or extra ids');
});

test('failed jobs: everything dynamic is escaped; notices are fixed', () => {
  const html = jobsFragment(jobs({ jobs: [{ id: HOSTILE, topic: HOSTILE, businessKey: HOSTILE, webhookId: HOSTILE, deadAt: HOSTILE }], errors: [HOSTILE], msg: 'replayed' }));
  assert.ok(!html.includes('<img') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('Jobs moved back to the queue'));
  assert.ok(jobsFragment(jobs({ msg: 'nothing_to_replay' })).includes('Nothing to replay.'));
});

test('home: shows a failed-jobs button with the count, and links to settings', () => {
  assert.ok(homeFragment(home({ failedJobs: 3 })).includes('data-view="/app/api/jobs">Failed jobs (3)</s-button>'));
  assert.ok(homeFragment(home({ failedJobs: 0 })).includes('data-view="/app/api/jobs">Failed jobs</s-button>'));
  assert.ok(homeFragment(home()).includes('data-view="/app/api/settings">Recipe settings</s-button>'));
});

const fresh = (over: Partial<HomeData> = {}): HomeData => home({ connection: { stored: false, lastVerifiedAt: null }, recipe: { name: 'R', configured: false, enabled: false, dryRun: true }, recent: [], ...over });

test('first-run guide: the steps follow the real state, in order, and only what is left to do has a button', () => {
  const state = (d: HomeData) => onboardingSteps(d).map((s) => s.done);
  assert.deepEqual(state(fresh()), [false, false, false, false]);
  assert.deepEqual(state(fresh({ connection: { stored: true, lastVerifiedAt: null } })), [true, false, false, false]);
  assert.deepEqual(state(fresh({ connection: { stored: true, lastVerifiedAt: '2026-10-26T10:00:00Z' } })), [true, true, false, false]);
  assert.deepEqual(state(fresh({ connection: { stored: true, lastVerifiedAt: 'x' }, recipe: { name: 'R', configured: true, enabled: true, dryRun: true } })), [true, true, true, false]);
  assert.deepEqual(state(fresh({ connection: { stored: false, lastVerifiedAt: 'x' } })), [false, false, false, false], 'a verified time without a stored connection counts for nothing');
  assert.deepEqual(state(fresh({ recent: [entry()] })), [false, false, false, true]);
  const html = homeFragment(fresh());
  assert.ok(html.includes('<s-section heading="Get started">') && html.includes('data-view="/app/api/setup">Connect</s-button>') && html.includes('Place a paid test order'));
  assert.equal(html.split('<s-badge tone="caution">to do</s-badge>').length - 1, 4);
  const half = homeFragment(fresh({ connection: { stored: true, lastVerifiedAt: '2026-10-26T10:00:00Z' } }));
  assert.ok(half.includes('<s-badge tone="success">done</s-badge> Connect Salesforce') && !half.includes('>Connect</s-button>') && !half.includes('>Test</s-button>') && half.includes('>Turn on</s-button>'));
});

test('first-run guide: when everything is done it becomes a "Setup complete" note and the checklist is gone', () => {
  const done = home({ recipe: { name: 'R', configured: true, enabled: true, dryRun: true } });
  const html = homeFragment(done);
  assert.ok(html.includes('<s-banner tone="success" heading="Setup complete">') && !html.includes('Get started') && !html.includes('to do'));
  assert.ok(homeFragment(home({ recipe: { name: 'R', configured: true, enabled: true, dryRun: false } })).includes('Setup complete'), 'also when live');
  assert.ok(!homeFragment(home({ recipe: { name: 'R', configured: true, enabled: false, dryRun: true } })).includes('Setup complete'), 'a disabled recipe is not "complete"');
});

const priv = (over: Record<string, unknown> = {}) => ({ id: 7, at: '2026-10-28T10:00:00Z', kind: 'shop/redact', requestRef: 'abc-123', detail: { ordersRedacted: 4, salesforceRecordsToReview: ['00Qxx0000012345', '00Txx0000067890'] }, ...over });

test('privacy requests: a table of this shop\'s requests with details links, a clear empty state, and a notice that no personal data is held', () => {
  const html = privacyFragment({ shop: 's', entries: [priv(), priv({ id: 8, kind: 'app/uninstalled', requestRef: 'r2' })] });
  assert.ok(html.includes('Shop data erased') && html.includes('App uninstalled') && html.includes('data-view="/app/api/privacy?id=7">Details</s-button>') && html.includes('data-view="/app/api/privacy?id=8">'));
  assert.ok(html.includes('contains no personal data') && html.includes("only this store's requests"));
  const none = privacyFragment({ shop: 's', entries: [] });
  assert.ok(none.includes('No privacy requests yet.') && !none.includes('<s-table>'));
  const odd = privacyFragment({ shop: 's', entries: [priv({ kind: 'toString' }), priv({ kind: '__proto__' }), priv({ kind: 'constructor' })] });
  assert.ok(!odd.includes('native code') && !odd.includes('[object') && odd.includes('<s-table-cell>toString<br>') && odd.includes('<s-table-cell>__proto__<br>') && odd.includes('<s-table-cell>constructor<br>'), 'unknown kinds are shown as their own text, never as inherited labels');
  const hostile = privacyFragment({ shop: 's', entries: [priv({ at: HOSTILE, kind: HOSTILE, requestRef: HOSTILE })] });
  assert.ok(!hostile.includes('<img') && hostile.includes('&lt;img src=x onerror=alert(1)&gt;'), 'every value in the list is escaped');
});

test('privacy request details: the records to review and plain numbers only; everything escaped; free text and nested data never shown', () => {
  const html = privacyDetailFragment(priv());
  assert.ok(html.includes('00Qxx0000012345') && html.includes('00Txx0000067890') && html.includes('ordersRedacted</s-text>: 4'));
  assert.ok(html.includes('This app cannot delete in Salesforce'));
  const odd = privacyDetailFragment(priv({ detail: { note: 'FREE TEXT secret', nested: { email: 'x@y.z' }, count: 2, flag: true, list: ['a'], salesforceRecordsToReview: [HOSTILE] } }));
  assert.ok(!odd.includes('FREE TEXT') && !odd.includes('x@y.z') && !odd.includes('<img') && odd.includes('count</s-text>: 2') && odd.includes('flag</s-text>: true'));
  assert.ok(odd.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!privacyDetailFragment(priv({ detail: {} })).includes('Salesforce records to review'));
  const many = privacyDetailFragment(priv({ detail: { salesforceRecordsToReview: Array.from({ length: 800 }, (_, i) => `rec${i}`) } }));
  assert.equal(many.split('<s-text type="code">rec').length - 1, 500, 'capped');
  assert.ok(!privacyDetailFragment(priv({ requestRef: HOSTILE, at: HOSTILE, kind: HOSTILE })).includes('<img'));
});

test('home links to privacy requests', () => {
  assert.ok(homeFragment(home()).includes('data-view="/app/api/privacy">Privacy requests</s-button>'));
});

test('the guide page lists the steps, offers the check, and escapes anything it was given', async () => {
  const { guideFragment, GUIDE_STEPS } = await import('./pages.ts');
  const html = guideFragment({ shop: 's.myshopify.com', stored: false });
  for (const s of GUIDE_STEPS) assert.ok(html.includes(s.title));
  assert.ok(html.includes('data-post="/app/api/check"') && html.includes('Save your connection on the Set up page first.'));
  const shown = guideFragment({ shop: 's.myshopify.com', stored: true, result: { ok: true, checks: [{ id: 'x', title: '<img src=x>', status: 'fail', fix: '<script>1</script>' }] } });
  assert.ok(!shown.includes('<img') && !shown.includes('<script>') && shown.includes('fix needed') && shown.includes('Some things need attention.'));
  assert.ok(guideFragment({ shop: 's', stored: true, result: { ok: true, checks: [{ id: 'x', title: 'T', status: 'warn', fix: 'f' }] } }).includes('too broad'));
  assert.ok(guideFragment({ shop: 's', stored: true, result: { ok: true, checks: [{ id: 'x', title: 'T', status: 'pass' }] } }).includes('Everything the recipe needs is in place'));
  assert.ok(guideFragment({ shop: 's', stored: true, result: { ok: false, reason: 'no_connection' } }).includes('Save your connection first'));
  assert.ok(guideFragment({ shop: 's', stored: true, result: { ok: false, reason: '__proto__' as any } }).includes('could not be reached'));
});

test('the first-run checklist links to the Salesforce setup guide, and the Set up page does too', () => {
  assert.ok(homeFragment(fresh()).includes('data-view="/app/api/guide">Open the Salesforce setup guide</s-button>'));
  assert.ok(setupFragment({ shop: 's', connection: { stored: false, lastVerifiedAt: null }, recipe: { name: 'R', configured: false, enabled: false, dryRun: true } }).includes('data-view="/app/api/guide"'));
});
