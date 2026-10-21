import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECURITY_HEADERS, badge, csrfField, esc, layout, notice } from './html.ts';
import { FormError, MAX_FORM_BYTES, parseForm } from './forms.ts';
import { configToForm, formToConfig } from '../../recipes/retail-b2b-lead-spotter/adminForm.ts';
import { validateR1Config } from '../../recipes/retail-b2b-lead-spotter/validateConfig.ts';
import { R1_DEFAULT_CONFIG } from '../../recipes/retail-b2b-lead-spotter/recipe.ts';

test('esc escapes every HTML-significant character and tolerates null/undefined/numbers', () => {
  assert.equal(esc(`<script>alert("x")</script>&'\``), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;&#96;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
  assert.equal(esc('plain text'), 'plain text');
});

test('attacker-controlled text cannot break out of any helper', () => {
  const evil = `"><img src=x onerror=alert(1)>`;
  for (const html of [badge(evil, 'bad'), notice(evil, 'warn'), csrfField(evil), layout({ title: evil, body: '', csrf: evil })]) {
    assert.ok(!html.includes('<img'), html.slice(0, 60));
    assert.ok(!html.includes('onerror=alert') || html.includes('&quot;') || html.includes('&gt;'));
  }
  assert.ok(layout({ title: evil, body: '' }).includes('&quot;&gt;&lt;img'));
});

test('layout is self-contained: no scripts, no external resources, no inline handlers', () => {
  const html = layout({ title: 't', body: '<p>x</p>', csrf: 'c' });
  assert.ok(!/<script/i.test(html));
  assert.ok(!/\son[a-z]+=/i.test(html));
  assert.ok(!/(src|href)=["']https?:/i.test(html));
  assert.ok(!/<link/i.test(html));
  assert.ok(html.includes('noindex'));
});

test('security headers: strict CSP, no framing, no sniffing, no caching, same-origin referrer', () => {
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['Cache-Control'], 'no-store');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'same-origin'); // not no-referrer: browsers would post forms with Origin: null
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  for (const d of ["default-src 'none'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!csp.includes('script-src') && !csp.includes("'unsafe-eval'"));
});

test('parseForm decodes + and %xx, keeps empty values, ignores empty names, rejects duplicates and bad encoding', () => {
  const f = parseForm('a=1&b=hello+world&c=%E2%9C%93&d=&=ignored&e');
  assert.deepEqual([...f], [['a', '1'], ['b', 'hello world'], ['c', '✓'], ['d', ''], ['e', '']]);
  assert.equal(parseForm('').size, 0);
  assert.throws(() => parseForm('a=1&a=2'), FormError);
  assert.throws(() => parseForm('a=%E0%A4%A'), FormError);
  assert.throws(() => parseForm(Array.from({ length: 61 }, (_, i) => `k${i}=1`).join('&')), FormError);
  assert.ok(MAX_FORM_BYTES >= 1024);
});

test('R1 form round trip: defaults -> form -> config equals the defaults', () => {
  const form = configToForm(R1_DEFAULT_CONFIG);
  const map = new Map<string, string>(Object.entries(form).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'on' : '') : v]));
  if (!form.requireConsent) map.delete('requireConsent');
  assert.deepEqual(validateR1Config(formToConfig(map)), R1_DEFAULT_CONFIG);
});

test('R1 form parsing: lines are trimmed and lower-cased, blanks dropped, a missing consent checkbox means false', () => {
  const f = new Map([['allowDomains', ' ACME.com \r\n\r\n beta.io\n'], ['denyDomains', ''], ['freeEmailBlocklist', 'gmail.com'], ['minOrderTotal', ' 12.5 '], ['existingLeadAction', 'skip'], ['leadSource', ' Web '], ['companyOverride', ''], ['leadOwnerId', '']]);
  const c = formToConfig(f) as any;
  assert.deepEqual(c.allowDomains, ['acme.com', 'beta.io']);
  assert.equal(c.minOrderTotal, 12.5);
  assert.equal(c.requireConsent, false);
  assert.equal(c.leadSource, 'Web');
  assert.equal(c.companyOverride, null);
  assert.equal(c.leadOwnerId, null);
});

test('R1 form parsing never produces a config the validator would accept for bad input', () => {
  const base = () => new Map([['allowDomains', ''], ['denyDomains', ''], ['freeEmailBlocklist', 'gmail.com'], ['minOrderTotal', '0'], ['requireConsent', 'on'], ['existingLeadAction', 'update'], ['leadSource', 'Web'], ['companyOverride', ''], ['leadOwnerId', '']]);
  assert.doesNotThrow(() => validateR1Config(formToConfig(base())));
  for (const [k, v] of [['minOrderTotal', ''], ['minOrderTotal', 'abc'], ['minOrderTotal', '-1'], ['existingLeadAction', 'delete'], ['leadSource', ''], ['leadOwnerId', 'bad'], ['allowDomains', 'not a domain']] as const) {
    const f = base();
    f.set(k, v);
    assert.throws(() => validateR1Config(formToConfig(f)), undefined, `${k}=${v}`);
  }
});
