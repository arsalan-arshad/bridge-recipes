// R1 Retail-to-B2B Lead Spotter: pure decision. No I/O, clock, randomness, env or logging.
// Rules and field rules: docs/R1_CONTRACT.md sections 4 and 5.

import type { Config, Context, Decision, OrderPaidEvent } from './types.ts';

// Returns the lower-cased, trimmed email and its domain, or null if malformed
// (not exactly one "@", empty local part or empty domain).
function normaliseEmail(raw: string | null): { email: string; domain: string } | null {
  if (raw === null) return null;
  const email = raw.trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local === '' || domain === '') return null;
  return { email, domain };
}

function stripWww(domain: string): string {
  return domain.startsWith('www.') ? domain.slice(4) : domain;
}

function describeOrder(event: OrderPaidEvent): string {
  return `Order ${event.orderName}: ${event.productTitles.join(', ')}. Total: ${event.total} ${event.currency}`;
}

export function decide(event: OrderPaidEvent, ctx: Context, config: Config): Decision {
  // 1. Normalise
  const parsed = normaliseEmail(event.customer.email);
  if (parsed === null) return { skip: 'no_email' };
  const { email, domain } = parsed;

  // 2. Domain filter (allowlist beats every blocklist)
  if (!config.allowDomains.includes(domain)) {
    if (config.denyDomains.includes(domain) || config.freeEmailBlocklist.includes(domain)) {
      return { skip: 'free_or_denied_domain' };
    }
  }

  // 3. Minimum (equal passes)
  if (event.total < config.minOrderTotal) return { skip: 'below_minimum' };

  // 4. Consent
  if (config.requireConsent && !event.customer.marketingConsent) return { skip: 'no_consent' };

  const matchKey = `r1:${event.orderId}`;
  const description = describeOrder(event);
  const derivedName = stripWww(domain);

  // 5. Existing record by email
  const existing = ctx.existingByEmail;
  if (existing !== null) {
    if (existing.type === 'Lead') {
      if (config.existingLeadAction === 'skip') return { skip: 'existing_lead_skipped' };
      return {
        ops: [
          {
            kind: 'updateLead',
            matchKey,
            targetId: existing.id,
            fields: { Description: description },
          },
        ],
      };
    }
    return {
      ops: [
        {
          kind: 'createTask',
          matchKey,
          ownerId: existing.ownerId,
          accountId: existing.accountId,
          contactId: existing.id,
          fields: { Subject: `Shopify order ${event.orderName} from ${derivedName}`, Description: description },
        },
      ],
    };
  }

  // 6. Existing Account by domain
  if (ctx.accountByDomain !== null) {
    return {
      ops: [
        {
          kind: 'createTask',
          matchKey,
          ownerId: ctx.accountByDomain.ownerId,
          accountId: ctx.accountByDomain.id,
          contactId: null,
          fields: { Subject: `Shopify order ${event.orderName} from ${derivedName}`, Description: description },
        },
      ],
    };
  }

  // 7. New Lead. Company: override > billing company > domain-derived.
  const billing = event.billingCompany === null ? '' : event.billingCompany.trim();
  const company = config.companyOverride ?? (billing !== '' ? billing : derivedName);
  const lastName = event.customer.lastName === null ? '' : event.customer.lastName.trim();

  return {
    ops: [
      {
        kind: 'createLead',
        matchKey,
        fields: {
          Company: company,
          LastName: lastName !== '' ? lastName : 'Unknown',
          Email: email,
          LeadSource: config.leadSource,
          Description: description,
          ...(config.leadOwnerId !== null ? { OwnerId: config.leadOwnerId } : {}),
        },
      },
    ],
  };
}
