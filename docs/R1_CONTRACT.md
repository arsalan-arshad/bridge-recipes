# R1 Lead Spotter — decide() Contract

_Status: implemented (2026-10-21); originally drafted 2026-10-19 before any code. Source of truth for the shapes and rules is `docs/SPEC.md` §2 and §4; this file fixes the details SPEC leaves open and lists the fixture cases. Rulings marked **[confirm]** need the owner's OK before they are tests._
_Language-neutral on purpose (open decision D3). Shapes are written as TypeScript-style notation._

## 1. Purity
`decide(event, ctx, config)` returns the same output for the same input, never mutates its arguments, and does no I/O, clock read, randomness, env read or logging. Everything it needs arrives in `ctx`. The runner handles "recipe disabled / kill switch" (decide is not called) and dry-run (ops are logged, not executed).

## 2. Input shapes (minimum data only)
```ts
interface OrderPaidEvent {                 // normalised from the orders/paid payload by the gateway
  orderId: string;                         // Shopify GID
  orderName: string;                       // e.g. "#1042"
  currency: string;                        // ISO 4217
  total: number;                           // order total in shop currency, >= 0
  productTitles: string[];                 // line-item titles only
  customer: {
    id: string | null;
    email: string | null;
    lastName: string | null;
    marketingConsent: boolean;             // true only when order-level buyer_accepts_marketing === true (see below)
  };
  billingCompany: string | null;
}
interface Context {                        // pre-fetched, read-only Salesforce lookups
  accountByDomain: { id: string; ownerId: string } | null;
  existingByEmail:
    | { type: 'Lead'; id: string }
    | { type: 'Contact'; id: string; accountId: string | null; ownerId: string }
    | null;
}
interface Config {
  allowDomains: string[];                  // lower-case
  denyDomains: string[];
  freeEmailBlocklist: string[];            // shipped default list, merchant-extendable
  minOrderTotal: number;                   // default 0
  requireConsent: boolean;                 // default true
  existingLeadAction: 'update' | 'skip';   // default 'update'
  leadSource: string;                      // configured picklist value
  companyOverride: string | null;
  leadOwnerId: string | null;              // explicit OwnerId for new Leads; null = Salesforce default
}
```
No phone, address, full name, payload or order amounts per line are passed in.

**Consent source (owner ruling 2026-10-19):** `marketingConsent` is the order-level `buyer_accepts_marketing` flag of the `orders/paid` payload, and is true only for a boolean `true`; missing, null, string or number means no consent (fail closed). `customer.email_marketing_consent` is **not** read: it is absent from the real payload. Evidence: two real signed deliveries (API 2026-10, 2026-10-19): order #1004 sent with the customer not subscribed gave `false`, #1005 sent after subscribing gave `true` (fixtures `recipes/retail-b2b-lead-spotter/payloads/SHOPIFY_real_*`). **Verified for admin-created (draft) orders, and for ONE real storefront checkout order (2026-10-21, #1007, API 2026-10: marketing box ticked at checkout, the service processed it past the consent rule and planned a Lead, so `buyer_accepts_marketing` was boolean `true`; the raw payload is not kept, so this is inferred from the decision, not read).** The storefront case with the box UNticked has not been observed; until it is, the consent filter is verified for the ticked case only. The flag is consent at order time, not the customer's current state. Log only the boolean outcome, never the raw payload. No new Shopify scope is needed.

## 3. Output shapes
```ts
type Decision = { skip: SkipReason } | { ops: SalesforceOp[] };   // ops is never empty
type SkipReason = 'no_email' | 'free_or_denied_domain' | 'below_minimum' | 'no_consent'
                | 'existing_lead_skipped';
type SalesforceOp =
  | { kind: 'createLead'; matchKey: string; fields: LeadFields }
  | { kind: 'updateLead'; matchKey: string; targetId: string; fields: { Description: string } }
  | { kind: 'createTask'; matchKey: string; ownerId: string; accountId: string | null;
      contactId: string | null; fields: TaskFields };   // accountId -> WhatId, contactId -> WhoId
```
`matchKey` = `r1:<orderId>` (one op per order per recipe; the executor uses it with EntityMap for idempotency).
**Gap in SPEC §2 (resolved in the code):** the SPEC op type has no `targetId` (needed to update a Lead) and no owner, account or contact for a Task. This contract adds `targetId`, `ownerId`, `accountId` and `contactId`; SPEC §2 was amended to match on 2026-10-19 (still **[confirm]** for the Contact-without-account sub-case below). Platform check (`docs/research/R1_PLATFORM_FACTS.md`): `WhatId` takes an Account, `WhoId` takes a Contact or Lead; never put a Lead id in `WhatId`.

## 4. Rules, in order (the first rule that fires decides)
1. **Normalise:** `email` trimmed and lower-cased; domain = text after the single `@`. Missing, blank or malformed (not exactly one `@`, empty local part or domain) -> `skip('no_email')`.
2. **Domain filter:** domain in `allowDomains` -> continue (allowlist beats every blocklist). Else in `denyDomains` or `freeEmailBlocklist` -> `skip('free_or_denied_domain')`.
3. **Minimum:** `total < minOrderTotal` -> `skip('below_minimum')`. Equal passes.
4. **Consent:** `requireConsent` and not `marketingConsent` -> `skip('no_consent')`.
5. **Existing record by email (`ctx.existingByEmail`):** if both a non-converted Lead and a Contact match the email, the **Lead wins** (owner ruling 2026-10-19). This is decided by the runner when it builds `ctx` (Lead lookup first, Contact only if no Lead), not by `decide()`.
   - Lead and `existingLeadAction = 'update'` -> `updateLead` (append order note to Description).
   - Lead and `'skip'` -> `skip('existing_lead_skipped')`.
   - Contact -> `createTask` with `contactId` = the Contact, `accountId` = the Contact's account (may be null), `ownerId` = the Contact's `ownerId`. No Lead. _Owner ruled 2026-10-19 (replaces the earlier `skip('existing_contact')` proposal)._ Sub-case Contact with no account -> Task with `accountId` null (WhoId only), owner = the Contact's owner: **tested in the Developer org 2026-10-19** (`scripts/org-checks.ts`): a Task with `WhoId` only is accepted, `AccountId` stays null, and an explicit `OwnerId` equal to the Contact's owner is accepted. Limit: the run used the admin as Run As and the Contact owner was that same admin, so assigning to a different owner, and a parent-controlled Contact owner, are **not yet tested**.
6. **Existing Account by domain (`ctx.accountByDomain`)** -> `createTask` for `ownerId`, no Lead.
7. Otherwise -> `createLead`.

Rule order is the SPEC order (email checks before Account). Where two rules would both skip, the earlier one is reported.

## 5. Field rules
- `Company`: `companyOverride`, else `billingCompany` (trimmed, non-blank), else the domain-derived name. _Owner ruled 2026-10-19: override > billing company > domain-derived._ SPEC §4 rule 6 wording ("domain-derived ... falls back to the billing company") must be amended to match. Salesforce requires `Company`, and the domain-derived name is always non-empty, so the field is never blank.
- Domain-derived name: the email domain as written, lower-cased, with a leading `www.` removed (e.g. `acme.com`). No public-suffix logic in v1. _(implemented as written)_
- Account match key: `www.`-stripped, lower-cased Website host compared for equality with the email domain; no subdomain or public-suffix logic in v1 (done by the runner when it builds `ctx`, not by `decide`).
- `OwnerId` (Lead): `config.leadOwnerId` when set, otherwise omitted. _Owner decision 2026-10-19 ("go" on the recommendation): set it explicitly to a configured default owner, because Salesforce otherwise gives a new Lead to the running user, which with a dedicated integration user would be that user._ Tasks keep the Account's or Contact's owner.
- `LastName`: `customer.lastName` trimmed, else `"Unknown"`.
- `Email`: normalised email. `LeadSource`: `config.leadSource`.
- `Description`: order name, product titles joined by `, `, and `total` with currency. Nothing else about the customer.
- Task: subject names the order; owner is `ctx.accountByDomain.ownerId`; no customer fields beyond what the subject needs.

## 6. Fixture cases (JSON in `recipes/retail-b2b-lead-spotter/fixtures/`, one file per case)
| ID | Case | Expected |
|---|---|---|
| F01 | No email (null) | skip `no_email` |
| F02 | Malformed email (`a@@b.com`, `@x.com`) | skip `no_email` |
| F03 | `@gmail.com`, default config | skip `free_or_denied_domain` |
| F04 | `@gmail.com` on allowlist | createLead |
| F05 | Corporate domain on denylist | skip `free_or_denied_domain` |
| F06 | Corporate domain, total below minimum | skip `below_minimum` |
| F07 | Total exactly equal to minimum | createLead |
| F08 | Corporate, no consent, `requireConsent` true | skip `no_consent` |
| F09 | Corporate, no consent, `requireConsent` false | createLead |
| F10 | Domain matches an Account | createTask for the Account's owner, no Lead |
| F11 | Existing Lead by email, action `update` | updateLead with `targetId`, Description appended |
| F12 | Existing Lead by email, action `skip` | skip `existing_lead_skipped` |
| F13 | Existing Contact by email, with account | createTask: `contactId`, `accountId` = Contact's account, `ownerId` = Contact's owner; no Lead |
| F13b | Existing Contact by email, no account (org-tested, see rule 5) | createTask: `accountId` null, `contactId` set, owner = Contact's owner |
| F13c | Existing Contact AND matching Account by domain | Contact task wins (rule 5 before 6) |
| F14 | No last name | `LastName` = `"Unknown"` |
| F15 | Email with upper-case and spaces | normalised in output |
| F16 | No billing company, no override | `Company` domain-derived |
| F16b | Billing company present, no override | `Company` = billing company (beats domain-derived) |
| F16c | Billing company blank/whitespace, no override | `Company` domain-derived |
| F17 | Override set (billing company also present) | `Company` = override |
| F18 | Free domain AND no consent | reports `free_or_denied_domain` (rule order) |
| F19 | Existing Lead AND matching Account | updateLead wins (rule 5 before 6) |
| F20 | Same input twice; input deep-frozen | identical output, no mutation, no throw |
| F21 | Description content | contains order name, titles, total; contains no phone/address/full name |

A mutation check follows the first green run: flip each comparison and ordering rule on a scratch copy and confirm tests fail (done this way in the sibling 02 project).

## 7. Out of scope here
Webhook verification, dedupe, queue, retries, Salesforce calls, redaction in logs and compliance webhooks belong to the core (BUILD_PLAN M1, M4).
