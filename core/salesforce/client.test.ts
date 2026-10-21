import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SalesforceClient, SalesforceError } from './client.ts';
import type { FetchLike } from './client.ts';

const SECRET = 'S3CR3T-value';
const TOKEN = 'TOKEN-value-abcdefghijklmnop';

interface Call { method: string; url: string; body: string | null; auth: string | null }

// A scripted fake fetch. Handlers are matched in order by predicate; the last matching handler is reused.
function fake(handlers: { match: (c: Call) => boolean; reply: (c: Call, n: number) => Response | Promise<Response> }[]) {
  const calls: Call[] = [];
  const counts = new Map<number, number>();
  const f: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as any);
    const body = init?.body === undefined ? null : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const call: Call = { method: init?.method ?? 'GET', url, body, auth: headers.get('authorization') };
    calls.push(call);
    const i = handlers.findIndex((h) => h.match(call));
    if (i === -1) throw new Error(`unexpected call ${call.method} ${url}`);
    const n = (counts.get(i) ?? 0) + 1;
    counts.set(i, n);
    const r = handlers[i].reply(call, n);
    // honour the abort signal the client passes (for the timeout test)
    return init?.signal ? Promise.race([Promise.resolve(r), new Promise<never>((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))]) : r;
  };
  return { f, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const isToken = (c: Call) => c.url.endsWith('/services/oauth2/token');
const tokenOk = (token = TOKEN) => ({ match: isToken, reply: () => json(200, { access_token: token, instance_url: 'https://org.example.my.salesforce.com', scope: 'api', token_type: 'Bearer' }) });
const versions = { match: (c: Call) => c.url.endsWith('/services/data/'), reply: () => json(200, [{ version: '66.0' }, { version: '68.0' }]) };

const make = (f: FetchLike, extra: Record<string, unknown> = {}) =>
  new SalesforceClient({ loginUrl: 'https://login.example.test', clientId: 'CID', clientSecret: SECRET, fetch: f, ...extra });

test('authenticates once and reuses the token; uses the instance url and the latest API version', async () => {
  const { f, calls } = fake([tokenOk(), versions, { match: (c) => c.url.includes('/query'), reply: () => json(200, { records: [{ Id: '1' }] }) }]);
  const sf = make(f);
  assert.deepEqual(await sf.query('SELECT Id FROM Lead'), [{ Id: '1' }]);
  await sf.query('SELECT Id FROM Lead');
  assert.equal(calls.filter(isToken).length, 1);
  const q = calls.filter((c) => c.url.includes('/query'));
  assert.ok(q[0].url.startsWith('https://org.example.my.salesforce.com/services/data/v68.0/query?q='));
  assert.equal(q[0].auth, `Bearer ${TOKEN}`);
  assert.equal(calls.filter((c) => c.url.endsWith('/services/data/')).length, 1, 'version discovered once');
});

test('concurrent first requests share ONE token request', async () => {
  const { f, calls } = fake([tokenOk(), versions, { match: (c) => c.url.includes('/query'), reply: () => json(200, { records: [] }) }]);
  const sf = make(f);
  await Promise.all([sf.query('SELECT Id FROM Lead'), sf.query('SELECT Id FROM Lead'), sf.query('SELECT Id FROM Lead')]);
  assert.equal(calls.filter(isToken).length, 1);
});

test('401 -> re-authenticates once and retries; a second 401 is an auth error (no loop)', async () => {
  let tokens = 0;
  const { f, calls } = fake([
    { match: isToken, reply: () => json(200, { access_token: `T${++tokens}`, instance_url: 'https://org.example.my.salesforce.com' }) },
    versions,
    { match: (c) => c.url.includes('/query'), reply: (c) => (c.auth === 'Bearer T2' ? json(200, { records: [{ Id: 'x' }] }) : json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }])) },
  ]);
  assert.deepEqual(await make(f).query('SELECT Id FROM Lead'), [{ Id: 'x' }]);
  assert.equal(calls.filter(isToken).length, 2);

  const always401 = fake([tokenOk(), versions, { match: (c) => c.url.includes('/query'), reply: () => json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'x' }]) }]);
  await assert.rejects(() => make(always401.f).query('SELECT Id FROM Lead'), (e: any) => e instanceof SalesforceError && e.kind === 'auth' && e.retryable);
  assert.equal(always401.calls.filter(isToken).length, 2, 'exactly one re-authentication, then give up');
});

test('authentication failures: bad credentials = auth (retryable so the owner can fix them), login host 503 = transient; the secret never leaks', async () => {
  const bad = fake([{ match: isToken, reply: () => json(400, { error: 'invalid_client', error_description: `client secret ${SECRET} is wrong` }) }]);
  await assert.rejects(() => make(bad.f).query('SELECT Id FROM Lead'), (e: any) => {
    assert.equal(e.kind, 'auth');
    assert.equal(e.errorCode, 'invalid_client');
    assert.ok(!e.message.includes(SECRET) && !JSON.stringify(e).includes(SECRET) && !String(e.stack).includes(SECRET));
    return true;
  });
  const down = fake([{ match: isToken, reply: () => json(503, { error: 'unavailable' }) }]);
  await assert.rejects(() => make(down.f).query('x'), (e: any) => e.kind === 'transient');
});

test('error classification', async () => {
  const table: [number, unknown, string, boolean][] = [
    [400, [{ errorCode: 'DUPLICATES_DETECTED', message: 'Use one of these records?', duplicateResult: { matchResults: [{ matchRecords: [{ record: { Id: '00Qaaaaaaaaaaaa1' } }, { record: { Id: '00Qaaaaaaaaaaaa2' } }] }] } }], 'duplicate', false],
    [400, [{ errorCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', message: 'bad value for restricted picklist field: X' }], 'restricted_picklist', false],
    [403, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }], 'rate_limit', true],
    [429, null, 'rate_limit', true],
    [500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'boom' }], 'transient', true],
    [503, null, 'transient', true],
    [400, [{ errorCode: 'UNABLE_TO_LOCK_ROW', message: 'unable to obtain exclusive access' }], 'transient', true],
    [400, [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]' }], 'permanent', false],
    [404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }], 'permanent', false],
    [403, [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'insufficient access rights' }], 'permanent', false],
  ];
  for (const [status, body, kind, retryable] of table) {
    const { f } = fake([tokenOk(), versions, { match: (c) => c.url.includes('/sobjects/'), reply: () => json(status, body) }]);
    await assert.rejects(() => make(f).create('Lead', { LastName: 'x' }), (e: any) => {
      assert.equal(e.kind, kind, `${status} ${JSON.stringify(body)}`);
      assert.equal(e.retryable, retryable, kind);
      assert.equal(e.status, status);
      return true;
    });
  }
});

test('DUPLICATES_DETECTED exposes the matched record ids', async () => {
  const { f } = fake([tokenOk(), versions, { match: (c) => c.url.includes('/sobjects/'), reply: () => json(400, [{ errorCode: 'DUPLICATES_DETECTED', message: 'Use one of these records?', duplicateResult: { matchResults: [{ matchRecords: [{ record: { Id: '00Qaaaaaaaaaaaa1' } }] }, { matchRecords: [{ record: { Id: '00Qaaaaaaaaaaaa2' } }] }] } }]) }]);
  await assert.rejects(() => make(f).create('Lead', { LastName: 'x' }), (e: any) => e.kind === 'duplicate' && JSON.stringify(e.matchedIds) === JSON.stringify(['00Qaaaaaaaaaaaa1', '00Qaaaaaaaaaaaa2']));
});

test('network failure and timeout are transient and leak nothing from the cause', async () => {
  const down: FetchLike = async () => { throw new Error(`connect ECONNREFUSED https://org?token=${TOKEN}`); };
  await assert.rejects(() => make(down).query('x'), (e: any) => e.kind === 'transient' && e.errorCode === 'NETWORK_ERROR' && !e.message.includes(TOKEN));
  const hang = fake([{ match: () => true, reply: () => new Promise<Response>(() => {}) }]);
  await assert.rejects(() => make(hang.f, { timeoutMs: 30 }).query('x'), (e: any) => e.kind === 'transient');
});

test('limit guard: at or above the threshold calls stop locally (retryable), below it they continue', async () => {
  let usage = '50/100';
  const { f, calls } = fake([tokenOk(), versions, { match: (c) => c.url.includes('/query'), reply: () => json(200, { records: [] }, { 'Sforce-Limit-Info': `api-usage=${usage}` }) }]);
  const sf = make(f, { maxUsageRatio: 0.95 });
  await sf.query('x');
  assert.equal(sf.usageRatio, 0.5);
  usage = '96/100';
  await sf.query('x'); // this response reports 96%
  assert.equal(sf.usageRatio, 0.96);
  const before = calls.length;
  await assert.rejects(() => sf.query('x'), (e: any) => e.kind === 'rate_limit' && e.retryable && e.errorCode === 'LOCAL_LIMIT_GUARD');
  assert.equal(calls.length, before, 'no HTTP call was made once the guard tripped');
});

test('email addresses inside Salesforce messages are redacted', async () => {
  const { f } = fake([tokenOk(), versions, { match: (c) => c.url.includes('/sobjects/'), reply: () => json(400, [{ errorCode: 'INVALID_EMAIL_ADDRESS', message: 'Email: invalid email address: bob.smith@acme.com' }]) }]);
  await assert.rejects(() => make(f).create('Lead', {}), (e: any) => !e.message.includes('bob.smith') && e.message.includes('b***@acme.com'));
});

test('an explicit API version skips discovery; failed discovery falls back to a pinned version', async () => {
  const pinned = fake([tokenOk(), { match: (c) => c.url.includes('/query'), reply: () => json(200, { records: [] }) }]);
  await make(pinned.f, { apiVersion: 'v66.0' }).query('x');
  assert.ok(pinned.calls.some((c) => c.url.includes('/services/data/v66.0/query')));
  assert.ok(!pinned.calls.some((c) => c.url.endsWith('/services/data/')));
  const broken = fake([tokenOk(), { match: (c) => c.url.endsWith('/services/data/'), reply: () => json(500, null) }, { match: (c) => c.url.includes('/query'), reply: () => json(200, { records: [] }) }]);
  await make(broken.f).query('x');
  assert.ok(broken.calls.some((c) => c.url.includes('/services/data/v60.0/query')));
});

test('create / update / getRecord use the right verbs and paths; unsafe types, ids and fields never reach the network', async () => {
  const { f, calls } = fake([
    tokenOk(), versions,
    { match: (c) => c.method === 'POST' && c.url.endsWith('/sobjects/Lead'), reply: () => json(201, { id: '00Qaaaaaaaaaaaa1', success: true }) },
    { match: (c) => c.method === 'PATCH', reply: () => json(204, null) },
    { match: (c) => c.method === 'GET' && c.url.includes('/sobjects/Lead/'), reply: () => json(200, { Description: 'd' }) },
  ]);
  const sf = make(f);
  assert.deepEqual(await sf.create('Lead', { LastName: 'x' }), { id: '00Qaaaaaaaaaaaa1' });
  await sf.update('Lead', '00Qaaaaaaaaaaaa1', { Description: 'n' });
  assert.deepEqual(await sf.getRecord('Lead', '00Qaaaaaaaaaaaa1', ['Description']), { Description: 'd' });
  const n = calls.length;
  for (const bad of [
    () => sf.create('Lead/../x', {}),
    () => sf.update('Lead', '../../x', {}),
    () => sf.update('Lead', '00Q', {}),
    () => sf.getRecord('Lead', '00Qaaaaaaaaaaaa1', ['Description,Name FROM User--']),
  ]) await assert.rejects(bad, (e: any) => e.errorCode === 'INVALID_ARGUMENT');
  assert.equal(calls.length, n, 'nothing sent for unsafe input');
  assert.equal(calls.find((c) => c.method === 'PATCH')!.body, JSON.stringify({ Description: 'n' }));
});

test('limit guard boundary: exactly at the threshold already stops', async () => {
  const { f } = fake([tokenOk(), versions, { match: (c) => c.url.includes('/query'), reply: () => json(200, { records: [] }, { 'Sforce-Limit-Info': 'api-usage=95/100' }) }]);
  const sf = make(f, { maxUsageRatio: 0.95 });
  await sf.query('x');
  await assert.rejects(() => sf.query('x'), (e: any) => e.kind === 'rate_limit');
});

test('without maxUsageRatio there is no local guard', async () => {
  const { f } = fake([tokenOk(), versions, { match: (c) => c.url.includes('/query'), reply: () => json(200, { records: [] }, { 'Sforce-Limit-Info': 'api-usage=99/100' }) }]);
  const sf = make(f);
  await sf.query('x');
  await sf.query('x');
});

test('an instance_url outside Salesforce is refused: no token kept, nothing sent there', async () => {
  for (const evil of ['https://evil.example.com', 'http://org.example.my.salesforce.com', 'https://169.254.169.254', 'https://org.my.salesforce.com.evil.io']) {
    const { f, calls } = fake([{ match: isToken, reply: () => json(200, { access_token: 'T', instance_url: evil }) }]);
    await assert.rejects(() => make(f).query('SELECT Id FROM Lead'), (e: any) => e instanceof SalesforceError && e.kind === 'auth' && e.errorCode === 'BAD_INSTANCE_URL', evil);
    assert.equal(calls.length, 1, `only the token call happened for ${evil}`);
  }
});

test('requests never follow redirects (credentials must not be re-sent elsewhere)', async () => {
  let seen: RequestInit | undefined;
  const f: FetchLike = async (_u, init) => { seen = init; return json(200, { access_token: 'T', instance_url: 'https://org.example.my.salesforce.com' }); };
  await make(f).query('SELECT Id FROM Lead').catch(() => {});
  assert.equal(seen?.redirect, 'error');
});
