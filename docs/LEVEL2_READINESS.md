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
| Do not keep data longer than needed | **Mostly**: log retention 14 to 365 days, configurable; queued orders 1 hour to 7 days; erased on `shop/redact` |
| Encrypt data in transit | **Done.** HTTPS with TLS 1.2 or 1.3 on public endpoints, database reached over Railway's private network with public access off ([Railway security](https://docs.railway.com/enterprise/security), read 2026-11-04) |
| Encrypt data at rest | **Done, by the provider's statement.** Railway states all data stored on it, including volumes, is encrypted at rest with AES-256 ([Railway security](https://docs.railway.com/enterprise/security), read 2026-11-04); the Railway settings page does not show it, so it is not independently verified. Salesforce secrets are additionally encrypted in the app (AES-256-GCM) |
| Encrypt backups | **No.** There are no backups. The Railway plan in use has none and the owner cannot buy Pro; a weekly encrypted manual dump was designed and then dropped on 2026-11-03 (not built, nothing to restore from). The data is small and mostly recreated from Shopify and Salesforce, but the decision log, settings, stored connections and privacy records are lost if the database is lost. Shopify lists encrypted backups under level 2, so this is a known gap a review may raise. Options (owner's decision): a Railway plan that includes volume backups and point-in-time recovery, or manual dumps; see `docs/DATA_LOSS_PREVENTION.md` |
| Keep test and production data separate | **Partly.** Tests use a local database; `docker-compose.staging.yml` and `docs/ENVIRONMENTS.md` provide a staging with its own database that cannot reach production. It has not been run, and the dev store's app still points at production until a staging Shopify app is created |
| Data loss prevention strategy | **Documented** in `docs/DATA_LOSS_PREVENTION.md`: what exists, and the gaps (no backups, no staging) |
| Limit staff access | One operator today. Two-step sign-in on Railway, GitHub, Shopify Partners and Salesforce: **not claimed**; nobody has checked that it is on |
| Strong passwords for staff accounts | Operator admin password minimum 12 characters; **others not verified** |
| Access log for protected customer data | **Yes**: changes and reads of the decision log and privacy records are audited (`admin_audit`), in the app with the Shopify user and on the operator `/admin` pages |
| Incident response policy | **Draft** (`docs/legal/INCIDENT_RESPONSE.md`); never rehearsed |

## To do before submitting to the App Store
1. Fill the square-bracket items, have a lawyer read `docs/legal/`, publish the policy and terms at public URLs.
2. Verify and document: database encryption at rest, two-step sign-in on every account that can reach data. Decide how to answer the backup gap (buy a plan with backups, or a different host) or state it plainly to the reviewer; there is no restore test because there is nothing to restore.
3. Add a staging service (a second Railway service) so tests never touch production data, and decide on backups (a plan that includes them).
4. Request protected customer data access in the Partner Dashboard with the minimum fields, and prepare for a data protection review.

## Protected-data questionnaire: saved as a draft in the Partner Dashboard on 2026-11-03 (not submitted)
Tell merchants what is processed: **No** (until the policy is published). Merchant agreements: **No** (until the terms are published). Encrypt at rest and in transit: **No** (at rest not verified). Limit staff access: **Yes** (one operator). Backups: **No**. Test and production separation: **No**. Data loss prevention: **No**. Undecided (owner): strong passwords, incident response.

Railway facts read in the dashboard on 2026-11-03: Postgres and app in US West (California, USA); Postgres public access off (private address in use); volume encryption not shown in the settings (not verified); no backups (Pro only).
