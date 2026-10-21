import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccountQuery,
  buildEmailQuery,
  pickAccountByDomain,
  soqlEscape,
  soqlEscapeLike,
  websiteHost,
  websiteMatchesDomain,
} from './lookups.ts';

test('soqlEscape escapes backslash and single quote', () => {
  assert.equal(soqlEscape("o'brien"), "o\\'brien");
  assert.equal(soqlEscape('a\\b'), 'a\\\\b');
  assert.equal(soqlEscape("\\'"), "\\\\\\'");
});

test('soqlEscapeLike also escapes % and _', () => {
  assert.equal(soqlEscapeLike('a%b_c'), 'a\\%b\\_c');
});

test('websiteHost handles URL variants', () => {
  const variants = [
    'acme.com', 'ACME.com', 'http://acme.com', 'https://www.acme.com/', 'www.acme.com/about?x=1#y',
    'https://acme.com:8443/path', ' https://user:pw@www.acme.com/ ', 'acme.com.',
  ];
  for (const v of variants) assert.equal(websiteHost(v), 'acme.com', v);
});

test('websiteHost returns null for junk', () => {
  for (const v of [null, undefined, '', '   ', 'not a url', 'http://', "acme.com'; DROP"]) {
    assert.equal(websiteHost(v as string | null | undefined), null, String(v));
  }
});

test('websiteMatchesDomain is host equality, not substring', () => {
  assert.equal(websiteMatchesDomain('https://www.acme.com/', 'acme.com'), true);
  assert.equal(websiteMatchesDomain('https://acme.com', 'www.acme.com'), true);
  assert.equal(websiteMatchesDomain('https://notacme.com', 'acme.com'), false);
  assert.equal(websiteMatchesDomain('https://acme.com.evil.io', 'acme.com'), false);
  assert.equal(websiteMatchesDomain('https://shop.acme.com', 'acme.com'), false);
  assert.equal(websiteMatchesDomain(null, 'acme.com'), false);
});

test('buildAccountQuery uses a LIKE prefilter and rejects bad domains', () => {
  assert.equal(
    buildAccountQuery('Acme.com'),
    "SELECT Id, OwnerId, Website FROM Account WHERE Website LIKE '%acme.com%' ORDER BY CreatedDate ASC LIMIT 50",
  );
  assert.throws(() => buildAccountQuery("x' OR Name != '"));
  assert.throws(() => buildAccountQuery(''));
});

test('buildEmailQuery builds Lead and Contact queries and rejects injection', () => {
  assert.equal(
    buildEmailQuery('Lead', ' Buyer@Acme.com '),
    "SELECT Id FROM Lead WHERE Email = 'buyer@acme.com' AND IsConverted = false ORDER BY CreatedDate ASC LIMIT 1",
  );
  assert.equal(
    buildEmailQuery('Contact', 'buyer@acme.com'),
    "SELECT Id, AccountId, OwnerId FROM Contact WHERE Email = 'buyer@acme.com' ORDER BY CreatedDate ASC LIMIT 1",
  );
  for (const bad of ["a'b@x.com", 'a"b@x.com', 'a\\b@x.com', 'a b@x.com', '']) {
    assert.throws(() => buildEmailQuery('Lead', bad), bad);
  }
});

test('pickAccountByDomain skips LIKE false positives and keeps query order', () => {
  const rows = [
    { Id: '001A', Website: 'https://notacme.com' },
    { Id: '001B', Website: 'https://www.acme.com/' },
    { Id: '001C', Website: 'acme.com' },
    { Id: '001D', Website: null },
  ];
  assert.equal(pickAccountByDomain(rows, 'acme.com')?.Id, '001B');
  assert.equal(pickAccountByDomain(rows, 'other.com'), null);
  assert.equal(pickAccountByDomain([], 'acme.com'), null);
});
