# R1 Platform Facts — research run 1

_Date: 2026-10-19. Read-only research by three Sonnet teammates (`sf-auth`, `shopify-facts`, `sf-objects`), synthesised by the lead. Nothing here is a test or a decision; it feeds the owner's rulings on `docs/R1_CONTRACT.md`._

**Confidence key:** `stated` = stated in an official doc page the teammate read or saw as a search snippet; `inferred` = reasoned from related docs or recall; `not found` = no usable source.

**Source limits (read this first).** `developer.salesforce.com` returned HTTP 403 to every direct fetch, so most Salesforce facts come from search snippets of official pages, a Context7 mirror of the official guides (github.com/damecek/salesforce-documentation-context), or recall. Several Shopify pages were truncated before the `orders/paid` section. "Stated" below therefore means "stated in an official page as seen by a teammate", not "I opened the page myself". Anything that gates code should be re-checked in a Developer org or dev store first (section 5).

---

## 1. Salesforce auth (D4) — teammate `sf-auth`

| Question | Answer | Source | Confidence |
|---|---|---|---|
| Client credentials flow: setup | Enable the flow in the External Client App (ECA) OAuth settings and policies; set a single **Run As** user (required). Token request: `grant_type=client_credentials` with consumer key and secret. | https://help.salesforce.com/s/articleView?id=sf.meta_configure_client_credentials_flow_for_external_client_apps.htm&language=en_US&type=5 | stated (fetched) |
| Client credentials: scopes, refresh | No scope parameter on the token request; scopes come from the ECA (`api` for REST). No refresh token; request a new token when it expires. | same page + search summary of a related help article | inferred |
| Token lifetime | Probably follows the org session-timeout setting. | none | not found |
| What we store (client credentials) | Consumer key and secret. Anyone holding both can mint tokens; rotate the secret. | same | stated |
| JWT bearer: setup | Generate a key pair, upload the public certificate to the ECA, enable JWT Bearer. The `sub` user must be pre-authorized: Permitted Users = "Admin approved users are pre-authorized" plus a permission set assigned to that user (permission set or profile, not both). Consumer key is the `iss` claim. | https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth-eca.html (403 on fetch; from search summaries of several official pages) | stated (snippets) |
| What we store (JWT) | The private key only; no shared secret leaves our side. | same | stated (snippets) |
| Local vs Packaged distribution | Metadata API enum has `Local` and `Packaged`. Whether it is permanent after creation is not stated. Choose Local for self-host; a multi-merchant ECA will probably need Packaged (unconfirmed). | https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_externalclientapplication.htm | not found (permanence) |
| Connected App creation disabled (Spring '26) | Confirmed: new Connected App creation is disabled by default, UI and APIs; existing apps keep working; Support can still enable it for now; end of support announced. | https://help.salesforce.com/s/articleView?id=005228017&language=en_US&type=1 | stated |
| Username-Password flow retirement | The retirement concerns Connected Apps; ECAs do not support the flow at all. Reported enforcement date 20 Feb 2027 and already blocked in orgs created Summer '26+ comes from **third-party sources only**. | none official | inferred |
| Minimum permissions | One dedicated integration user + one narrow custom permission set: **API Enabled** (system); Lead Read/Create/Edit (no Delete, no View All); Task Create (+Read if we look tasks up); Account and Contact Read only; field-level security only on fields R1 sends or reads (`Company` and `LastName` writable). API Only User permission recommended for the Run As user on Enterprise+. "Edit Tasks" user permission: unconfirmed. | same help page confirms the integration-user + permission-set pattern only | pattern stated; object list inferred |

**Recommendation (inferred, see lead's section 6):** client credentials for v1 self-host; JWT bearer if/when multi-merchant.

## 2. Shopify side — teammate `shopify-facts`

| Question | Answer | Source | Confidence |
|---|---|---|---|
| API version to pin | **2026-10** is latest stable (released 2026-10-01); 2027-01 is a release candidate; 2026-01/04/07 stable. | https://shopify.dev/docs/api/usage/versioning | stated |
| Customer email, last name, billing company, line item titles in `orders/paid` | Seen in sibling `checkouts/*` samples as `customer.email`, `customer.last_name`, `billing_address.company`, `line_items[].title`. The `orders/paid` sample itself was not reached. | https://shopify.dev/docs/api/admin-rest/2026-10/resources/order | inferred |
| Marketing consent field | `customer.email_marketing_consent` exists on the Customer resource with `state`, `opt_in_level`, `consent_updated_at`; REST state value `subscribed` (lowercase); GraphQL enum `CustomerEmailMarketingState`: SUBSCRIBED, NOT_SUBSCRIBED, PENDING, UNSUBSCRIBED, INVALID, REDACTED. The object appears in the `customers_email_marketing_consent/update` topic sample; **not confirmed inside the `orders/paid` customer object**. Order-level `buyer_accepts_marketing` is confirmed in the sample (order-level flag, not marked deprecated). | https://shopify.dev/docs/api/admin-rest/2026-10/resources/customer ; https://shopify.dev/docs/api/admin-graphql/latest/enums/CustomerEmailMarketingState | stated (resource) / not found (in orders/paid) |
| `accepts_marketing` deprecated? | Removed from the Customer resource in 2024-01; release notes say use `email_marketing_consent`. The search filter of the same name is deprecated. Teammate did not open the page. | https://shopify.dev/docs/api/release-notes/previous-versions/2024-01 | stated (snippet only) |
| Protected customer data | Level 1 = no name/address/phone/email; **Level 2 = name, address, phone, email**, each field requested individually. Level 2: "Requires review" for public apps, "Always available" for custom apps (admin-created custom apps: "varies by plan"). Public apps request in the Partner Dashboard (Protected customer data access + Data protection details). Dev-store testing needs no review. | https://shopify.dev/docs/apps/launch/protected-customer-data | stated |
| HMAC | Header `X-Shopify-Hmac-SHA256` (HTTP headers are case-insensitive, so SPEC's `X-Shopify-Hmac-Sha256` is the same header); base64 HMAC-SHA256 of the raw body with the app client secret; verify before any parser runs; 401 on failure; a rotated secret can take up to an hour to apply. | https://shopify.dev/docs/apps/build/webhooks/subscribe/https | stated |
| Delivery / event ids | `X-Shopify-Webhook-Id`: "Unique per delivery. Use it to detect duplicates." `X-Shopify-Event-Id`: shared by all deliveries from the same merchant action, including multiple subscriptions to the same topic. **Whether Webhook-Id is identical across retries of one delivery is not stated** (probably yes; inferred). | same | stated (descriptions) / inferred (retry stability) |
| Compliance webhooks | `customers/data_request`, `customers/redact`, `shop/redact`; mandatory for App Store apps, docs silent on custom apps; declared with `compliance_topics` + `uri` under `[[webhooks.subscriptions]]` in `shopify.app.toml`. | https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance | stated |
| What registers them | Dev mode syncs the TOML on save; docs name `shopify app deploy` as the step that releases subscriptions, but never state it for `compliance_topics` specifically. | https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started | inferred |

## 3. Salesforce objects and REST — teammate `sf-objects`

| Question | Answer | Source | Confidence |
|---|---|---|---|
| Lead required fields | `Company` required (Context7 mirror of Lead object docs). `LastName` required per another Salesforce page (automotive Sales Lead mapping); not seen on the Lead object's own page. | https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_lead.htm (unreadable, 403) | Company stated; LastName inferred |
| LeadSource outside the picklist | Restricted picklist: HTTP 400, `errorCode: INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`, message "bad value for restricted picklist field: <value>", `fields` names the field. Unrestricted picklist accepts any value. | vendor pages only (Marketo, Revenue.io) | not found in official docs |
| Duplicate rules on API-created records | They apply. `actionOnInsert` Block: API error, record not inserted. Allow + Alert: error unless `allowSave=true` in the header. Allow without Alert: saves silently. | Metadata API `DuplicateRule` docs (search snippet) | stated (snippet) |
| `Sforce-Duplicate-Rule-Header` | API v52.0+; options `allowSave`, `includeRecordDetails`, `runAsCurrentUser`, all default false. Docs show both `;` and `,` separators — test which. `allowSave` helps only for Alert-type rules, not Block. | https://developer.salesforce.com/docs/platform/api-rest/guide/headers-duplicaterules.html | stated (snippet) |
| `DUPLICATES_DETECTED` REST JSON | Exact shape not found. `DuplicateResult` (SOAP docs) has `allowSave`, `duplicateRule`, `errorMessage`, `matchResults`. | https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_objects_duplicateresult.htm | not found (REST shape) |
| Task attach to Account | `WhatId` is a polymorphic "Related To" for non-person objects; Account allowed; if it points at an Account/Opportunity/Contract, `AccountId` is derived. `WhoId` holds Lead/Contact — **never put a Lead id in `WhatId`**. | https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_objects_task.htm ; SOQL polymorphic keys guide | stated |
| Task `Status` | Required, defaults to "Not Started"; valid values via the TaskStatus object. So R1 can omit it. | Context7 mirror | stated |
| Task `OwnerId`, `Subject`, `ActivityDate` | `ActivityDate` is a date (midnight UTC). `OwnerId` presumably defaults to the API user; `Subject` required-ness not confirmed. R1 should set both explicitly. | — | not found |
| Email lookup SOQL | String comparison is case-insensitive by default (inferred). REST has no bind variables: escape backslash and single quote, or reject emails containing quotes before querying. | — | inferred |
| Account by `Website` | Recall, no source: `Website LIKE '%acme.com%'` (escaped), then re-parse each returned Website client-side (strip scheme, `www.`, path, port; lower-case; require host equality or dot-boundary subdomain). Removes `notacme.com` false positives and matches contract §5. LIKE on free text may be slow on large orgs. | — | inferred |
| Limit header | `Sforce-Limit-Info` on every REST call except `/services/data/`; format `api-usage=10018/100000`, newer docs add `; api-bursts=1/750`. Parse tolerantly: split on `;`, ignore unknown keys. `/services/data/vXX.X/limits` resource exists; response shape unconfirmed. | https://developer.salesforce.com/docs/platform/api-rest/guide/headers-api-usage.html | stated |
| Consent into Salesforce | No standard opt-in field. `HasOptedOutOfEmail` means opted **out**; do not write it from Shopify (writing false could clear an existing opt-out). Prefer a Description note (e.g. "Shopify marketing consent: subscribed"), which needs no new permission; a custom field needs owner sign-off and widens the integration user's field access. With `requireConsent` on (the default) a non-subscribed customer creates no Lead, so the consent note matters only when the filter is off. | — | inferred |

## 4. Cross-checks and disagreements

- `sf-auth` and `sf-objects` compared permissions: **no disagreement**. Both are inferred, neither found an official minimum list. `sf-auth` added: `allowSave` only for Alert rules; a help article suggests rule settings can be overridden for API saves (sandbox test); no extra permission found for rules to run on API saves.
- `shopify-facts` sent the consent proposal (`email_marketing_consent.state == "subscribed"`, fail closed) to `sf-objects`. `sf-objects` found nothing that disproves it from the Salesforce side (recall only) and added the `HasOptedOutOfEmail` warning.
- `shopify-facts` did not cross-check with `sf-auth`; nothing in their areas overlapped.
- **Open disagreements: none.** That reflects shared gaps (everything inferred stays inferred), not independent confirmation.

## 5. Must be verified hands-on before code depends on it

1. A real `orders/paid` payload from a dev store, as a fixture: which consent field is present in `customer`, and exact field names.
2. Whether `X-Shopify-Webhook-Id` repeats on a retry (force a non-200 response and compare).
3. In a Developer org: Lead without `Company`/`LastName`; Task without `Subject`/`OwnerId`; a restricted `LeadSource`; a Block and an Alert duplicate rule via REST (capture the real JSON); the permission set with and without "Edit Tasks".
4. That client credentials works end to end with the Run As user and the permission set above.

## 6. Lead's synthesis

### (a) The three [confirm] items in `docs/R1_CONTRACT.md`
(The contract has a fourth mark, the domain-derived Company name; covered with item 2.)

1. **Op fields `targetId` / `ownerId` / `accountId`** — platform facts support them. Updating a Lead needs its record id; a Task attaches via `WhatId` = Account id and takes `OwnerId`. Add `targetId`, `ownerId`, `accountId` to SPEC §2. Also set `Subject` explicitly; `Status` may be omitted. No platform fact contradicts the contract here.
2. **Company precedence (override > domain-derived > billing company)** — the platform does not decide this; it only requires `Company` to be non-empty, which any of the three satisfies. This is a product ruling for the owner. Note the domain-derived name is a guess (`acme.com`), while billing company is what the customer typed.
3. **Existing Contact by email → `skip('existing_contact')`** — the platform allows the alternative: a Task can carry `WhoId` = Contact plus `WhatId` = Contact's account. Not decided by docs. The skip is the safer v1 choice; the alternative needs the Contact's `AccountId` and `OwnerId` added to `Context`.

Related, from the contract's field note on consent: the contract's boolean `marketingConsent` should be derived from `customer.email_marketing_consent.state` equal to `subscribed` (case-insensitive, anything else or missing = false). `buyer_accepts_marketing` is an order-level fallback only. Confirm with a real payload (section 5 item 1).

### (b) Recommendation for D4
**Client credentials flow through an External Client App, distribution Local, one dedicated Run As integration user with a narrow permission set**, for v1 self-hosted. Reasons: one org, one operator, no key-pair handling, and the Run As user makes the write identity explicit. Store only the consumer key and secret (encrypted, per SPEC §8) plus the instance URL; fetch a token on demand and on expiry (no refresh token). Switch to JWT bearer if the service becomes multi-merchant (per-org key pair, nothing shared). Caveats: token lifetime and Local→Packaged permanence were not found, and the JWT/permission details come from snippets. Never use Username-Password. Confidence: this is a judgement from inferred facts, not a stated recommendation in the docs.

### (c) Contradictions with `docs/SPEC.md`, the README and `PROJECT_CONTEXT.md`
- **SPEC §3 step 2 / README §3** (dedupe on "event/delivery id header"): use `X-Shopify-Webhook-Id`, not `X-Shopify-Event-Id`. Event-Id is shared across subscriptions and deliveries; the business key `(recipe, shop, shopifyObjectId)` remains the safety net since retry stability of Webhook-Id is unconfirmed (`shopify-facts` suggests order id plus topic as the backup key, which is the same job).
- **SPEC §4 rule 6 (LeadSource fallback to Description):** workable, but the error is only confirmed by vendor pages, and a restricted picklist means the first write fails; the executor must catch `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` and retry once without LeadSource. Not an option for `decide()` alone.
- **SPEC §10 risk row / contract:** duplicate rules do run on API creates and can Block or Alert. The contract has no outcome for a duplicate error; a policy is needed (skip vs fail, logged).
- **SPEC §7 "limit-usage header":** it is `Sforce-Limit-Info`, format above. Not a contradiction, a fill-in.
- **SPEC §8 `X-Shopify-Hmac-Sha256`:** same header as `X-Shopify-Hmac-SHA256` (case-insensitive). No change except spelling.
- **SPEC §6 / README §3 "mandatory compliance webhooks":** docs say mandatory for App Store apps and are silent on custom apps. Keeping them mandatory is still the project's own rule (CLAUDE.md), but README/SPEC should not claim Shopify requires them for self-hosted custom installs. "TOML alone does not register them" is likely true but only inferred for `compliance_topics`.
- **SPEC §7 / README §6 permissions:** the README table says "Lead create/read/update" and "Task create"; the inferred permission set agrees. Add API Enabled and the field-level scope; mark "Edit Tasks" as to verify.
- **PROJECT_CONTEXT §6:** the protected-data note is incomplete: Level 1 is also reviewed for public apps; Level 2 = name, address, phone, email, requested per field; admin-created custom apps "varies by plan" (not "always"). README §5 Phase A repeats "always available to custom apps"; the access table qualifies this for admin-created custom apps. Dev Dashboard custom distribution was not separately checked.
- **PROJECT_CONTEXT §6, Salesforce line:** Username-Password is not merely "being retired": ECAs do not support it. Retirement dates remain unverified.
- **Contract §2 consent note** ("older `accepts_marketing` flag is deprecated in favour of consent objects"): confirmed for the Customer resource (removed 2024-01); the `orders/paid` location of the consent object is still unconfirmed.

---

## 7. Update 2026-10-19 (terminal Claude): hands-on results, supersede the "inferred" rows above

Sources: two real signed Shopify deliveries and one Shopify example delivery (receiver `scripts/capture-webhook.ts`, dev store, API 2026-10), and `scripts/org-checks.ts` against the Developer org (Run As = admin, so permission failures are NOT covered). Confidence here is **observed** (the strongest in this file) but limited to what is stated.

| Topic | Result | Replaces |
|---|---|---|
| Signature | `X-Shopify-Hmac-SHA256` verified with our own `core/shopify/verifyHmac.ts` against real deliveries, signed with the store's webhook signing key. | HMAC checked only against an openssl vector |
| Field names in `orders/paid` | `admin_graphql_api_id`, `name`, `currency`, `total_price` (string), `contact_email`, `email`, `buyer_accepts_marketing`, `customer.{email,last_name,admin_graphql_api_id}`, `billing_address.company`, `line_items[].title` all present as inferred. | "inferred from `checkouts/*`" |
| Consent | `customer.email_marketing_consent` is **absent** (also `accepts_marketing`, sms consent). Only order-level `buyer_accepts_marketing` exists: `false` for #1004 (customer not subscribed), `true` for #1005 (subscribed). Owner ruled to use it (contract §2). Admin-created draft orders only. | "consent object presence in `orders/paid` unconfirmed" |
| Retry ids | `X-Shopify-Webhook-Id`, `X-Shopify-Event-Id` and triggered-at identical between the forced-500 delivery and its retry (~1.1 to 1.5 s later), for both orders; both differ between the two orders; Webhook-Id never equals Event-Id. Later back-off retries not observed. | "retry stability inferred" |
| Salesforce auth | Client credentials works: `scope api`, no refresh token, no `expires_in` in the response. API v68.0, `Sforce-Limit-Info: api-usage=1/15000`. | token lifetime "not found" |
| Lead / Task | Lead requires `LastName`, `Company`. Task requires nothing (describe shows none); `Status`, `OwnerId` (running user) default; `AccountId` derived from `WhatId`; Lead id in `WhatId` rejected, in `WhoId` accepted; Task with `WhoId` Contact (no account) accepted. | Lead `LastName` "inferred"; Task required fields "not found" |
| `LeadSource` | Not restricted in this org (arbitrary value saved). The restricted-picklist error stays vendor-sourced only. | unchanged: still "not found in official docs" |
| Duplicates | `Standard_Lead_Duplicate_Rule` alerts: HTTP 400 `DUPLICATES_DETECTED`; `allowSave=true` lets the save through. Shape: `errors[0].duplicateResult.{allowSave, duplicateRule, duplicateRuleEntityType, errorMessage, matchResults[].{entityType, matchEngine, rule, size, matchRecords[].{matchConfidence, record.Id}}}`. | "REST JSON shape not found" |
| SOQL | Email equality is case-insensitive; Website `LIKE` prefilter + host check found the right Account. | "inferred" |

**Still not verified:** storefront-checkout orders (consent flag, payload); retries beyond the immediate one; Contact/Account duplicate rules; permission failures and "Edit Tasks" (needs the dedicated integration user); Task assignment to a different owner; the restricted-picklist error in a real org; whether `compliance_topics` registration needs `shopify app deploy`.

**Minimal permission list proposed for the dedicated integration user (NOT yet approved, nothing created):** see `PROJECT_CONTEXT.md` section 15.
