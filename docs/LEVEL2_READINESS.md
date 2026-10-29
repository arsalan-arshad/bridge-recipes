# Shopify protected customer data: readiness (public app)

Shopify requires level 1 and level 2 practices for apps that use customer name or email, and may run a data protection review
([Work with protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data), read 2026-10-29). Status below is
the honest state of this repository and the single Railway deployment; "not verified" means nobody has checked.

| Requirement | Status |
|---|---|
| Process only the minimum personal data | **Yes.** Unused fields (addresses, phone, payment details) are dropped before an order is queued (`minimizeOrderPaid`, tested to change nothing the recipe sees); the queued copy keeps only order id/name/total/currency/product titles, customer email and last name, billing company and the consent flag; emails are masked in logs. Jobs queued before 2026-10-29 may still hold full notifications until they expire |
| Tell merchants what is processed and why | **Draft written** (`docs/legal/PRIVACY_POLICY.md`); not published |
| Limit processing to the stated purposes | **Yes**, by design (R1 only) |
| Respect customer consent | **Yes**: marketing-consent filter on by default |
| Respect opt-outs of data sale | Not applicable: nothing is sold or shared |
| Do not keep data longer than needed | **Mostly**: log retention 14 to 365 days, configurable; queued orders 1 hour to 14 days; erased on `shop/redact` |
| Encrypt data in transit | **Yes** (HTTPS at the host) |
| Encrypt data at rest | Salesforce secrets: **yes** (AES-256-GCM in the app). Database disk encryption: **not verified** (provider) |
| Encrypt backups | **Not verified**; no backup or restore has been set up or tested |
| Keep test and production data separate | **Partly**: local development uses a local database; the only hosted service is "production" and is used with a development store. A staging service is not set up |
| Data loss prevention strategy | **Partly**: minimised data, no bulk export feature, secrets never shown; no formal strategy document |
| Limit staff access | One operator today. Provider account protections (two-step sign-in on Railway, GitHub, Shopify Partners, Salesforce): **not verified** |
| Strong passwords for staff accounts | Operator admin password minimum 12 characters; **others not verified** |
| Access log for protected customer data | **Yes for the app pages**: changes and reads of the decision log and privacy records are audited with the Shopify user (`admin_audit`). The operator's own `/admin` pages do not log reads yet |
| Incident response policy | **Draft** (`docs/legal/INCIDENT_RESPONSE.md`); never rehearsed |

## To do before submitting to the App Store
1. Fill the square-bracket items, have a lawyer read `docs/legal/`, publish the policy and terms at public URLs.
2. Verify and document: database encryption, backups and a restore test, two-step sign-in on every account that can reach data.
3. Log reads on the operator `/admin` pages too.
4. Add a staging service so tests never touch production data.
5. Consider shortening failed-job retention (14 days).
6. Request protected customer data access in the Partner Dashboard with the minimum fields, and prepare for a data protection review.
