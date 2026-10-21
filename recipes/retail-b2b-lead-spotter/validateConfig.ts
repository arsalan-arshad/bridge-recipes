// Strict validation of R1's per-shop config (docs/R1_CONTRACT.md section 2). Unknown keys, wrong types and out-of-range
// values are rejected; nothing is coerced. Used on write (so a bad config can never be stored) and on read (fail closed).

import type { Config } from './types.ts';

export class ConfigValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid R1 config: ${problems.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }
}

const KEYS = ['allowDomains', 'denyDomains', 'freeEmailBlocklist', 'minOrderTotal', 'requireConsent', 'existingLeadAction', 'leadSource', 'companyOverride', 'leadOwnerId'];
const DOMAIN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const SF_USER_ID = /^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

export function validateR1Config(input: unknown): Config {
  const problems: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ConfigValidationError(['config must be an object']);
  const c = input as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) problems.push(`unknown key ${k}`);

  const domains = (name: string): string[] => {
    const v = c[name];
    if (!Array.isArray(v) || v.length > 5000) { problems.push(`${name} must be an array of at most 5000 domains`); return []; }
    const out: string[] = [];
    for (const d of v) {
      if (typeof d !== 'string' || d !== d.toLowerCase() || !DOMAIN.test(d)) { problems.push(`${name} entries must be lower-case domains`); return []; }
      out.push(d);
    }
    return out;
  };
  const allowDomains = domains('allowDomains');
  const denyDomains = domains('denyDomains');
  const freeEmailBlocklist = domains('freeEmailBlocklist');

  const min = c.minOrderTotal;
  if (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 1e12) problems.push('minOrderTotal must be a number between 0 and 1e12');
  if (typeof c.requireConsent !== 'boolean') problems.push('requireConsent must be true or false');
  if (c.existingLeadAction !== 'update' && c.existingLeadAction !== 'skip') problems.push("existingLeadAction must be 'update' or 'skip'");
  if (typeof c.leadSource !== 'string' || c.leadSource.trim() === '' || c.leadSource.length > 255) problems.push('leadSource must be a non-empty string of at most 255 characters');
  if (c.companyOverride !== null && (typeof c.companyOverride !== 'string' || c.companyOverride.trim() === '' || c.companyOverride.length > 255)) problems.push('companyOverride must be null or a non-empty string of at most 255 characters');
  if (c.leadOwnerId !== null && (typeof c.leadOwnerId !== 'string' || !SF_USER_ID.test(c.leadOwnerId))) problems.push('leadOwnerId must be null or a Salesforce User id (005...)');

  if (problems.length > 0) throw new ConfigValidationError(problems);
  return {
    allowDomains, denyDomains, freeEmailBlocklist, minOrderTotal: min as number, requireConsent: c.requireConsent as boolean,
    existingLeadAction: c.existingLeadAction as 'update' | 'skip', leadSource: c.leadSource as string,
    companyOverride: c.companyOverride as string | null, leadOwnerId: c.leadOwnerId as string | null,
  };
}
