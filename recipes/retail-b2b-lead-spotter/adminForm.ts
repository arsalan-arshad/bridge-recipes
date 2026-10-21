// R1 settings <-> an editable HTML form. Parsing is deliberately dumb: it only builds an object for validateR1Config(), which
// does all the checking. Nothing is trusted or coerced here beyond splitting lines and reading a number.

import type { Config } from './types.ts';

const lines = (text: string): string[] =>
  text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');

export interface R1FormValues {
  allowDomains: string;
  denyDomains: string;
  freeEmailBlocklist: string;
  minOrderTotal: string;
  requireConsent: boolean;
  existingLeadAction: string;
  leadSource: string;
  companyOverride: string;
  leadOwnerId: string;
}

export function configToForm(c: Config): R1FormValues {
  return {
    allowDomains: c.allowDomains.join('\n'),
    denyDomains: c.denyDomains.join('\n'),
    freeEmailBlocklist: c.freeEmailBlocklist.join('\n'),
    minOrderTotal: String(c.minOrderTotal),
    requireConsent: c.requireConsent,
    existingLeadAction: c.existingLeadAction,
    leadSource: c.leadSource,
    companyOverride: c.companyOverride ?? '',
    leadOwnerId: c.leadOwnerId ?? '',
  };
}

// Returns an UNVALIDATED object for validateR1Config().
export function formToConfig(f: Map<string, string>): unknown {
  const num = (f.get('minOrderTotal') ?? '').trim();
  const co = (f.get('companyOverride') ?? '').trim();
  const owner = (f.get('leadOwnerId') ?? '').trim();
  return {
    allowDomains: lines((f.get('allowDomains') ?? '').toLowerCase()),
    denyDomains: lines((f.get('denyDomains') ?? '').toLowerCase()),
    freeEmailBlocklist: lines((f.get('freeEmailBlocklist') ?? '').toLowerCase()),
    minOrderTotal: num === '' ? NaN : Number(num),
    requireConsent: f.get('requireConsent') === 'on',
    existingLeadAction: f.get('existingLeadAction') ?? '',
    leadSource: (f.get('leadSource') ?? '').trim(),
    companyOverride: co === '' ? null : co,
    leadOwnerId: owner === '' ? null : owner,
  };
}
