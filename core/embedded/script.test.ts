// Tests for the browser script (core/embedded/assets/app.js) run in Node against a tiny fake page, because it handles the secret field
// and the LIVE confirmation. The fake implements only what the script uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new globalThis.URL('./assets/app.js', import.meta.url), 'utf8');

class El {
  tag: string;
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  listeners = new Map<string, ((ev: any) => void)[]>();
  value: unknown = undefined;
  checked = false;
  type = '';
  textContent = '';
  innerHTML = '';
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag;
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  get tagName() { return this.tag.toUpperCase(); }
  add(child: El) { child.parent = this; this.children.push(child); return child; }
  getAttribute(n: string) { return this.attrs.has(n) ? this.attrs.get(n)! : null; }
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  hasAttribute(n: string) { return this.attrs.has(n); }
  addEventListener(t: string, f: (ev: any) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]); }
  // selectors used by the script: "[attr]", "tag[attr]"
  matches(sel: string): boolean {
    const m = /^([a-z-]*)\[([a-z-]+)\]$/.exec(sel);
    if (!m) return false;
    return (m[1] === '' || m[1] === this.tag) && this.attrs.has(m[2]);
  }
  closest(sel: string): El | null {
    for (let e: El | null = this; e; e = e.parent) if (e.matches(sel)) return e;
    return null;
  }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (e: El) => { for (const c of e.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  fire(type: string, target: El = this) {
    const ev = { target, prevented: false, preventDefault() { this.prevented = true; } };
    for (const f of this.listeners.get(type) ?? []) f(ev);
    return ev;
  }
}

function run(opts: { respond?: (url: string, init: any) => { status: number; type: string; body: string } } = {}) {
  const root = new El('div', { id: 'app' });
  const requests: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  let tokens = 0;
  const sandbox: any = {
    document: { getElementById: (id: string) => (id === 'app' ? root : null) },
    window: { shopify: { idToken: async () => `TOKEN-${++tokens}` } },
    URLSearchParams,
    fetch: async (url: string, init: any = {}) => {
      requests.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
      const r = opts.respond ? opts.respond(url, init) : { status: 200, type: 'text/html; charset=utf-8', body: '<s-page>ok</s-page>' };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? r.type : null) }, text: async () => r.body };
    },
  };
  sandbox.window.fetch = sandbox.fetch;
  vm.runInNewContext(SOURCE, sandbox);
  return { root, requests, tick: () => new Promise((r) => setTimeout(r, 20)) };
}

function form(root: El, path: string, fields: El[], extra: Record<string, string> = {}) {
  const f = root.add(new El('form', { 'data-post': path, ...extra }));
  for (const x of fields) f.add(x);
  const button = f.add(new El('s-button', { 'data-submit': '' }));
  return { f, button };
}

test('on load it asks for the home page with a fresh Bearer token and shows the fragment', async () => {
  const { root, requests, tick } = run();
  await tick();
  assert.deepEqual(requests.map((r) => [r.url, r.method, r.headers.Authorization]), [['/app/api/home', 'GET', 'Bearer TOKEN-1']]);
  assert.equal(root.innerHTML, '<s-page>ok</s-page>');
});

test('clicking a data-view element loads that page; anything outside /app/api/ is ignored', async () => {
  const { root, requests, tick } = run();
  await tick();
  const ok = root.add(new El('s-button', { 'data-view': '/app/api/log?outcome=failed' }));
  const ev = root.fire('click', ok);
  await tick();
  assert.ok(ev.prevented);
  assert.equal(requests[1].url, '/app/api/log?outcome=failed');
  for (const bad of ['https://evil.example/app/api/log', '//evil.example', '/admin', '/app/assets/app.js', 'javascript:alert(1)', '/app/api']) {
    const el = root.add(new El('s-button', { 'data-view': bad }));
    const e2 = root.fire('click', el);
    await tick();
    assert.equal(e2.prevented, false, bad);
  }
  assert.equal(requests.length, 2, 'no request for the refused paths');
});

test('a form is sent as a POST with the token and a form-encoded body made of the named fields, including the secret', async () => {
  const { root, requests, tick } = run();
  await tick();
  const url = new El('s-text-field', { name: 'loginUrl' }); url.value = 'https://acme.my.salesforce.com';
  const key = new El('s-text-field', { name: 'clientId' }); key.value = 'KEY 1&x=y';
  const secret = new El('s-password-field', { name: 'clientSecret' }); secret.value = 'S3CR3T=&value';
  const unnamed = new El('s-text-field', {}); unnamed.value = 'ignored';
  const { f, button } = form(root, '/app/api/connection', [url, key, secret, unnamed]);
  const ev = root.fire('click', button);
  await tick();
  assert.ok(ev.prevented);
  const req = requests[1];
  assert.deepEqual([req.url, req.method, req.headers.Authorization, req.headers['Content-Type']], ['/app/api/connection', 'POST', 'Bearer TOKEN-2', 'application/x-www-form-urlencoded']);
  const sent = new URLSearchParams(req.body);
  assert.deepEqual([...sent.entries()], [['loginUrl', 'https://acme.my.salesforce.com'], ['clientId', 'KEY 1&x=y'], ['clientSecret', 'S3CR3T=&value']]);
  assert.ok(button.hasAttribute('disabled'), 'the button is disabled while sending');
  assert.ok(f);
});

test('hidden inputs, the LIVE word, and checkboxes are collected correctly', async () => {
  const { root, requests, tick } = run();
  await tick();
  const action = new El('input', { name: 'action', type: 'hidden' }); action.value = 'go_live'; action.type = 'hidden';
  const confirm = new El('s-text-field', { name: 'confirm' }); confirm.value = 'LIVE';
  const on = new El('input', { name: 'requireConsent' }); on.type = 'checkbox'; on.checked = true;
  const off = new El('input', { name: 'other' }); off.type = 'checkbox'; off.checked = false;
  const polaris = new El('s-checkbox', { name: 'flag' }); polaris.checked = true;
  const { button } = form(root, '/app/api/recipe', [action, confirm, on, off, polaris]);
  root.fire('click', button);
  await tick();
  assert.deepEqual([...new URLSearchParams(requests[1].body).entries()], [['action', 'go_live'], ['confirm', 'LIVE'], ['requireConsent', 'on'], ['flag', 'on']]);
});

test('a form that does not post under /app/api/ sends nothing; Enter (submit) sends the form once; a disabled button does not resend', async () => {
  const { root, requests, tick } = run();
  await tick();
  const bad = form(root, 'https://evil.example/steal', []);
  root.fire('click', bad.button);
  await tick();
  assert.equal(requests.length, 1);
  const good = form(root, '/app/api/verify', []);
  const ev = root.fire('submit', good.f);
  await tick();
  assert.ok(ev.prevented);
  assert.equal(requests.length, 2);
  root.fire('click', good.button); // now disabled
  await tick();
  assert.equal(requests.length, 2, 'a second click while disabled does nothing');
});

test('a 400 or 422 with an HTML body is shown (it holds the problems); refusals and failures show a fixed message, never the body', async () => {
  const cases: [number, string, string, string][] = [
    [400, 'text/html; charset=utf-8', '<s-page>problem text</s-page>', '<s-page>problem text</s-page>'],
    [403, 'text/plain; charset=utf-8', 'forbidden', 'This store is not set up for this Bridge Recipes service. Ask the operator to add it.'],
    [415, 'text/plain; charset=utf-8', 'rejected', 'That request was refused. Reload the app and try again.'],
    [413, 'text/plain; charset=utf-8', 'rejected', 'That request was refused. Reload the app and try again.'],
    [500, 'text/plain; charset=utf-8', 'error SECRET-DETAIL', 'Could not complete that. Reload the app.'],
  ];
  for (const [status, type, body, shown] of cases) {
    const { root, tick } = run({ respond: (_u, init) => (init.method === 'POST' ? { status, type, body } : { status: 200, type: 'text/html', body: '<s-page>home</s-page>' }) });
    await tick();
    const { button } = form(root, '/app/api/recipe', []);
    root.fire('click', button);
    await tick();
    const out = status === 400 ? root.innerHTML : root.textContent;
    assert.equal(out, shown, String(status));
    assert.ok(!String(root.textContent).includes('SECRET-DETAIL'));
  }
});

test('a 401 is retried once with a fresh token, then reported', async () => {
  let n = 0;
  const { root, requests, tick } = run({ respond: (_u, init) => (init.method === 'POST' ? { status: ++n === 1 ? 401 : 200, type: n === 1 ? 'text/plain' : 'text/html', body: n === 1 ? 'unauthorized' : '<s-page>done</s-page>' } : { status: 200, type: 'text/html', body: '<s-page>home</s-page>' }) });
  await tick();
  const { button } = form(root, '/app/api/recipe', []);
  root.fire('click', button);
  await tick();
  const posts = requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].headers.Authorization, posts[1].headers.Authorization, 'a fresh token for the retry');
  assert.equal(root.innerHTML, '<s-page>done</s-page>');

  const always = run({ respond: (_u, init) => (init.method === 'POST' ? { status: 401, type: 'text/plain', body: 'unauthorized' } : { status: 200, type: 'text/html', body: '<s-page>home</s-page>' }) });
  await always.tick();
  const b2 = form(always.root, '/app/api/recipe', []);
  always.root.fire('click', b2.button);
  await always.tick();
  assert.equal(always.requests.filter((r) => r.method === 'POST').length, 2, 'only one retry');
  assert.equal(always.root.textContent, 'Could not complete that. Reload the app.');
});

test('a network failure shows a fixed message and never an error detail', async () => {
  const { root, tick } = run({ respond: (_u, init) => { if (init.method === 'POST') throw new Error('socket hang up with SECRET-DETAIL'); return { status: 200, type: 'text/html', body: '<s-page>home</s-page>' }; } });
  await tick();
  const { button } = form(root, '/app/api/recipe', []);
  root.fire('click', button);
  await tick();
  assert.equal(root.textContent, 'Could not reach the service. Reload the app.');
});
