// Pure helpers for the read-only lookups that build R1's Context. No network here.
// Facts and confidence: docs/research/R1_PLATFORM_FACTS.md section 3 (REST has no bind
// variables, so values are escaped; Website is free text, so matches are re-checked client-side).

// SOQL string literal escaping (backslash first, then the single quote).
export function soqlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Same, plus the LIKE wildcards % and _ (escaped with a backslash).
export function soqlEscapeLike(value: string): string {
  return soqlEscape(value).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

// Host of a free-text Website value: lower-case, scheme/userinfo/port/path/query/hash and a leading
// "www." removed. Returns null when nothing host-like is left.
export function websiteHost(website: string | null | undefined): string | null {
  if (typeof website !== 'string') return null;
  let s = website.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^[^@]*@/, '');
  s = s.replace(/:\d+$/, '');
  s = s.replace(/\.$/, '');
  if (s.startsWith('www.')) s = s.slice(4);
  return DOMAIN_RE.test(s) ? s : null;
}

// Equality on the host, no subdomain or public-suffix logic (contract section 5).
export function websiteMatchesDomain(website: string | null | undefined, domain: string): boolean {
  const host = websiteHost(website);
  const wanted = websiteHost(domain);
  return host !== null && wanted !== null && host === wanted;
}

export function buildAccountQuery(domain: string): string {
  const d = websiteHost(domain);
  if (d === null) throw new Error('invalid domain for Account lookup');
  return `SELECT Id, OwnerId, Website FROM Account WHERE Website LIKE '%${soqlEscapeLike(d)}%' ORDER BY CreatedDate ASC LIMIT 50`;
}

export function buildEmailQuery(object: 'Lead' | 'Contact', email: string): string {
  const e = email.trim().toLowerCase();
  if (e === '' || /[\s'"\\]/.test(e)) throw new Error('invalid email for lookup');
  const fields = object === 'Contact' ? 'Id, AccountId, OwnerId' : 'Id';
  const live = object === 'Lead' ? ' AND IsConverted = false' : '';
  return `SELECT ${fields} FROM ${object} WHERE Email = '${soqlEscape(e)}'${live} ORDER BY CreatedDate ASC LIMIT 1`;
}

// Rows come back in query order (oldest first); take the first row whose Website host equals the domain.
export function pickAccountByDomain<T extends { Website?: string | null }>(rows: T[], domain: string): T | null {
  for (const row of rows) if (websiteMatchesDomain(row.Website, domain)) return row;
  return null;
}
