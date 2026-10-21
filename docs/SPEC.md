# Bridge Recipes — Spec

_Status: v1 core, R1, the admin and the privacy-webhook handlers are implemented (see docs/BUILD_PLAN.md); R2/R3 are planned. Re-verify platform behaviour against current docs before changing anything._

## 1. Scope (v1)
Core + **R1 only**, self-hosted, one Shopify shop ↔ one Salesforce org, with dry-run, kill switch, log and replay. R2 and R3 follow as separate milestones.

**Non-goals:** bulk/historical sync, two-way field sync, mirroring customers or orders, a field-mapping UI for arbitrary objects, multi-org.

## 2. Recipe contract
Each recipe splits **decision** (pure, tested) from **execution** (shared, retried):

```ts
interface Recipe<Event, Config> {
  id: string;
  topics: string[];                      // Shopify webhook topics it listens to
  configSchema: Schema<Config>;          // per-shop settings, validated
  decide(event: Event, ctx: Context, config: Config): Decision;   // PURE
}
type Decision = { skip: string }                       // reason, logged
              | { ops: SalesforceOp[] };               // what to write
type SalesforceOp =
  | { kind: 'createLead'; matchKey: string; fields: LeadFields }
  | { kind: 'updateLead'; matchKey: string; targetId: string; fields: { Description: string } }
  | { kind: 'createTask'; matchKey: string; ownerId: string;
      accountId: string | null /* WhatId */; contactId: string | null /* WhoId */; fields: TaskFields };
```
Amended 2026-10-19 to match `docs/R1_CONTRACT.md` (an update needs the target Lead id; a Task needs owner, account and contact). Never put a Lead id in `WhatId`. Authoritative shapes live in `recipes/<id>/types.ts`.
`decide` receives pre-fetched context (e.g. existing-account lookup result) so it stays side-effect free. The executor runs ops, retries, logs. **Dry-run** = execute nothing, log the ops.

## 3. Event flow
1. Webhook arrives → verify `X-Shopify-Hmac-Sha256` over the **raw** body → 401 on failure.
2. Dedupe on `X-Shopify-Webhook-Id` ("unique per delivery" per Shopify docs; **not** `X-Shopify-Event-Id`, which is shared across subscriptions to the same topic) **and** on a business key `(recipe, shop, shopifyObjectId)`. The docs do not state whether Webhook-Id is identical across retries of one delivery. **Observed 2026-10-19** (dev store, two admin-created orders, forced 500): both Webhook-Id and Event-Id, and the triggered-at time, were identical between the failed delivery and its retry (~1 s later); later back-off retries were not observed. The business key stays as the safety net.
3. Persist job, return 200 immediately.
4. Worker loads the recipe config (a disabled or unconfigured recipe makes zero Salesforce calls), calls `decide` once on an empty context (a skip that needs no Salesforce data is final, so e.g. free-email and no-consent orders cost no API calls), gathers context with read-only lookups, calls `decide`, then executes ops (dry-run: logs the planned ops, writes nothing).
5. Outcome + minimal metadata written to the sync log; failures retried with exponential backoff and jitter; after N attempts → dead-letter (visible, replayable).

## 4. R1 rules (in order)
1. No email → skip(`no_email`).
2. Domain on allowlist → continue. Else on denylist or free-email blocklist → skip(`free_or_denied_domain`).
3. Order total below merchant minimum → skip(`below_minimum`).
4. Consent required (default on) and the order's `buyer_accepts_marketing` is not boolean `true` → skip(`no_consent`). Source and its limits (verified for admin-created orders only; re-check on the first storefront order in dry-run): `docs/R1_CONTRACT.md` §2.
5. Salesforce lookup (read-only): Account by `Website` domain; Contact/Lead by `Email`.
   - Existing Lead by email → `updateLead` (append order note) or skip per config.
   - Existing Contact by email → `createTask` (WhoId = the Contact, WhatId = its Account if any, owner = the Contact's owner); no Lead.
   - Account matched by domain → `createTask` for the Account's `OwnerId`.
   - Otherwise → `createLead`.
6. Lead fields: `Company` (merchant override, else the billing company, else the domain-derived name; ruled 2026-10-19), `LastName` (customer last name, or "Unknown" — Salesforce requires it), `Email`, `LeadSource` (configurable value; if the org's picklist is restricted the first write fails, so the **executor** — not `decide()` — retries once without it and notes the value in the description), `Description` (order name, product titles, total).

## 5. Data model (as built: SQL migrations 001-007, schema `bridge`)
| Table | Purpose |
|---|---|
| `webhook_intake` | dedupe record per delivery (webhook id and business key both unique), written atomically with the enqueue |
| `entity_map` | match key (`r1:<order gid>`) to Salesforce type and id, plus `shop`; stops double writes |
| `recipe_config` | per shop and recipe: enabled, dry-run, settings JSON (no row = disabled) |
| `salesforce_connection` | per shop: login URL, **encrypted** client credentials, last verified |
| `sync_log` | per processed order: outcome, reason, error class, operations (personal values masked) |
| `admin_audit` | operator actions (sign-in, mode changes, connection changes) |
| `compliance_log` | one non-personal record per privacy request or uninstall |
| pg-boss tables | the job queue and dead-letter queue (queue state, attempts, next run) |

No raw webhook payloads are stored beyond the minimum needed to retry; payloads are deleted once the job succeeds or the retention window ends.

## 6. Compliance behaviour (mandatory for Shopify review)
Implemented in `core/compliance/` (M4). Payload shapes and timings, verified 2026-10-21 against https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance: `customers/data_request` `{shop_id, shop_domain, orders_requested[], customer{id,email,phone}, data_request{id}}`; `customers/redact` `{shop_id, shop_domain, customer{id,email,phone}, orders_to_redact[]}` (sent 10 days after the request when the customer had no order in the last six months, otherwise withheld until six months have passed); `shop/redact` `{shop_id, shop_domain}` (sent 48 hours after uninstall). Obligations: answer 2xx, finish within 30 days, answer 401 to an invalid HMAC, JSON body.
- **Delivery:** the gateway verifies the HMAC (401 otherwise), requires the authenticated `X-Shopify-Shop-Domain` header to match the body's `shop_domain` (400 otherwise), validates the order ids (positive integers, at most 10,000), and queues ONLY `{topic, shopDomain, orders[], requestId}`: the customer's email, phone and id are dropped before anything is stored. Compliance deliveries dedupe on their own delivery id (two different requests for one shop must both run).
- `customers/redact`: in ONE transaction (our tables and the queue's own job tables), delete for the listed orders the sync-log rows, the entity-map rows (including legacy rows with no shop), the intake delivery records and the queued/dead-lettered jobs that carry the raw payload; then write a compliance record. Idempotent; a failure rolls everything back and the queue retries. It never touches another shop's rows or other orders of the shop.
- `customers/data_request`: deletes nothing; writes a compliance record with a report of what is held for the listed orders (sync-log outcomes, Salesforce record ids, counts of delivery records and queued jobs). The report contains no personal data; names, emails and order details written to Salesforce live in the merchant's Salesforce records (listed in the report) and in Shopify.
- `shop/redact`: one transaction deleting everything for the shop: sync log, entity map, intake records, recipe settings, the stored (encrypted) Salesforce credentials, admin audit rows, earlier compliance records and all queued/dead-lettered jobs. What remains: one non-personal record of the erasure itself, and the delivery record of the erase request (so a Shopify retry cannot re-run it). Entity-map rows written before the shop column existed and not attributable to any shop age out with the retention window.
- `app/uninstalled` (ordinary topic): disables the shop's recipes (settings kept), deletes the stored Salesforce credentials and removes queued jobs; the remaining shop data is erased by `shop/redact` 48 hours later.
- **Salesforce records are the merchant's data.** Leads and Tasks already written to the merchant's org are the merchant's own CRM records; this app has no delete permission in Salesforce by design, so every redaction lists the Salesforce record ids to review in its compliance record (admin page "Compliance"). The compliance record holds no personal data and is kept 365 days (configurable).
- The privacy jobs are handled without a sync-log entry (the log is shop data; an erased shop must not get a new row).
- Declare all subscriptions in `shopify.app.toml` **and** run `shopify app deploy` — editing the TOML alone does not register them (Shopify's docs name `shopify app deploy` as the release step; they do not state it for `compliance_topics` specifically — verify when deploying).
- Shopify mandates the three privacy topics for apps distributed through the App Store and is silent on custom apps; this project implements them regardless (project rule).

## 7. Salesforce side
- **External Client App** (Connected App creation is disabled in all orgs since Spring '26 — re-verify), integration user, permission set limited to the objects/fields in README §6.
- **Zero Salesforce footprint in v1:** no package, no custom fields; matching uses standard fields (Email, Website). The ID map lives in Postgres.
- Optional later: an unlocked package with `Shopify_Id__c` external-id fields and a log object (reusing the smart-record-cloner 2GP release process).
- Respect API limits: read the `Sforce-Limit-Info` response header (format `api-usage=used/max`, newer API versions may add `; api-bursts=...`; parse tolerantly, ignore unknown keys) and back off.
- Duplicate rules run on API-created records: a Block rule rejects the write, an Alert rule rejects it unless the request sends `Sforce-Duplicate-Rule-Header: allowSave=true`. The executor needs a policy for the resulting error (skip vs fail, always logged) — open, see `PROJECT_CONTEXT.md`.
- Never write `HasOptedOutOfEmail` from Shopify consent (it means opted *out*; writing false could clear an existing opt-out). Consent is recorded as a Description note only.
- Integration user: API Enabled, Lead read/create/edit, Task create, Account/Contact read, field-level access only to fields used (inferred, verify in a Developer org).
- Source for these Salesforce and Shopify facts and their confidence: `docs/research/R1_PLATFORM_FACTS.md`.
- **Observed in the Developer org 2026-10-19** (`scripts/org-checks.ts`, run as the admin Run As user, test records deleted afterwards):
  - Client credentials works end to end: token response has `scope: api`, **no refresh token and no `expires_in`**, so the client must re-authenticate on a 401, not on a timer. Latest API version was v68.0; `Sforce-Limit-Info: api-usage=1/15000`.
  - A Lead needs `LastName` and `Company` (`REQUIRED_FIELD_MISSING`). A Task needs nothing: `Status` defaults to Not Started, `OwnerId` to the running user, and `AccountId` is derived from `WhatId`. A Lead id in `WhatId` is rejected (`FIELD_INTEGRITY_EXCEPTION`); in `WhoId` it is accepted.
  - `LeadSource` is **not restricted** in this org (a made-up value was saved), so the restricted-picklist retry in §4 rule 6 is covered by unit tests only, not by this org.
  - **Duplicate rules do alert here:** `Standard_Lead_Duplicate_Rule` returned HTTP 400 `DUPLICATES_DETECTED` for a second Lead with the same email; with `allowSave=true` the Lead was created. So `duplicate_detected` **is** testable in this org. Error shape: `errors[0].duplicateResult.{allowSave, duplicateRule, matchResults[].matchRecords[].record.Id}`. The executor never sends `allowSave` and records `duplicate_detected` (owner-confirmed policy). Contacts and Accounts were not checked for duplicate rules.
  - SOQL email comparison is case-insensitive; the Account `Website` LIKE prefilter plus host check returned the right Account.
  - Not covered by that run because it was the admin: field and object permission failures, assigning a Task to a different owner, and "Edit Tasks". These were then tested as the real integration user (next bullet).
- **Observed as the dedicated integration user 2026-10-20** (`scripts/permission-checks.ts`; user on the *Salesforce Integration* licence, profile "Minimum Access - API Only Integrations", permission set `Bridge_Recipes_Integration`):
  - Works: client-credentials token; reading Account, Contact and Lead rows (SOQL); creating a Lead with the fields R1 sets including an explicit `OwnerId` of another user (the owner took effect); updating Lead `Description`.
  - Denied as designed: Lead delete (`INSUFFICIENT_ACCESS_OR_READONLY`), Account create/update and Contact create (`CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`); `Lead.Phone` is not visible. The integration user therefore cannot clean up its own test Leads.
  - **(Superseded below for a full licence.)** Under the *Salesforce Integration* licence, **Task is not reachable through the REST API for this user**: `GET /sobjects/Task/describe` and `POST /sobjects/Task` both return 404 `NOT_FOUND`, even with the system permission "Edit Tasks" granted. So R1's Task path (existing Account or Contact) does **not** work under the Salesforce Integration licence. Unresolved: which licence/permission exposes Task to the API (to be investigated; a full Salesforce licence is the likely candidate, unconfirmed).
  - Some standard Lead fields cannot be restricted: `Status` and `Company` were writable without any field permission (as were `LastName`).
  - `GET /limits` returns 403 for this user; the `Sforce-Limit-Info` header on ordinary calls is the only limit source the client should rely on.

## 8. Security
- HMAC verification (`X-Shopify-Hmac-SHA256`, base64 HMAC-SHA256 of the raw body; header names are case-insensitive) before any parsing; constant-time compare.
- Credentials AES-256-GCM encrypted at rest; key only in environment.
- Never log tokens or full payloads; redact emails in logs to `a***@domain` form.
- Kill switch disables a recipe immediately; dry-run is the default for a newly enabled recipe.

## 9. Acceptance criteria (R1 / v1)
- A forged webhook is rejected; a replayed delivery creates no duplicate.
- With dry-run on, nothing is written to Salesforce and the log shows exactly what would be.
- `@gmail.com` order → skipped with reason; corporate-domain order → Lead; domain matching an existing Account → Task for its owner, no Lead.
- Salesforce down for an hour → jobs retry, then succeed after recovery; nothing lost, nothing duplicated.
- `customers/redact` removes the customer's rows; `shop/redact` empties the shop.
- A recipe disabled by the kill switch performs zero writes.

## 10. Risks
| Risk | Mitigation |
|---|---|
| CRM flood / bad leads | Narrow filters, minimum order value, dry-run first |
| Privacy law (consent for sales outreach) | Consent filter on by default; override carries a warning; docs state the merchant owns the lawful basis |
| Protected data review (public listing) | Self-host first; list only after proof |
| Salesforce validation/duplicate rules reject a Lead | Map errors to readable log entries; configurable defaults; duplicate-error policy (skip vs fail) still to be ruled |
| Webhook ordering / retries | Idempotency keys; never assume order |
| Scope creep into "universal sync" | The recipe contract is the boundary; new needs become new recipes |
- **Observed as a second integration user on a full *Salesforce* licence 2026-10-20** (profile "Minimum Access - Salesforce", permission set `Bridge_Recipes_Integration_SF`): the Task object **is** reachable (describe works; a Task with only `Subject` was created and deleted; deleting Tasks works via Edit Tasks). So the Task blocker was the licence. The first check found `Task.Description`, `Task.WhatId` and `Task.WhoId` **not visible** (`INVALID_FIELD: No such column ...`) until the permission set granted Read+Edit on them (owner did, 2026-10-20). **Re-checked after the grant: a Task on an existing Account (`WhatId`) and one on an existing Contact (`WhoId`), each with `OwnerId` set to another user, are created (HTTP 201), and a Task with no owner given is created too.** The integration user could delete only the Task it owned itself; the two Tasks assigned to other users could not be deleted by it (HTTP 400), so test Tasks assigned to others need an admin to remove. Everything else matched the first integration user (Lead create/edit with `OwnerId`, Lead delete and Account/Contact writes denied, reads allowed). **The setup guide must state the licence requirement: the integration user needs a full Salesforce licence, not the Salesforce Integration licence.**
