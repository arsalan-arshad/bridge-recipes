# Data loss prevention: what exists today

Written 2026-11-04 from the code and from Railway's published security page
([docs.railway.com/enterprise/security](https://docs.railway.com/enterprise/security), read 2026-11-04). It describes what is in
place, not what is planned. Shopify's level 2 list asks for a data loss prevention strategy; this is it, including its gaps.

## What the service holds
Per store: recipe settings, the encrypted Salesforce connection, a decision log (masked emails), links from Shopify orders to Salesforce
records, audit entries, privacy-request records, and short-lived queued order notifications. Nothing else. Orders themselves are not stored.

## Protections that exist
| Risk | What exists | Where |
|---|---|---|
| Disk or storage exposure | Railway states all data stored on Railway, including volumes, is encrypted at rest with AES-256, keys managed by Railway. This is the provider's statement; the Railway settings page does not show it and we have not verified it independently | Railway docs (above) |
| Secrets exposure | Each store's Salesforce consumer secret is encrypted in the app with AES-256-GCM before it is stored; it is never shown again or logged | `core/crypto/secretBox.ts` |
| Interception | HTTPS with TLS 1.2 or 1.3 on public endpoints (Railway); the database is reached over Railway's private network with public access off | Railway docs; service settings read 2026-11-03 |
| Forged or replayed input | Shopify HMAC checked over the raw body before parsing; every handler is idempotent, so a repeat delivery changes nothing | `core/gateway`, `core/worker` |
| Loss of a job | Failed jobs are kept and can be replayed by the store from the app or by the operator | `/app/api/jobs`, `/admin` |
| Collecting too much | Only the fields the recipe reads are kept (`minimizeOrderPaid`); emails are masked in the log | `recipes/retail-b2b-lead-spotter/minimizeOrderPaid.ts` |
| Keeping data too long | Defaults: decision log 30 days, webhook receipts 14 days, record links 30 days, privacy records 365 days, each configurable from 1 to 3650 days by environment variable; queued order notification 1 hour after success, 7 days after failure | `core/queue/retention.ts`, `core/queue/config.ts` |
| A store asks to be forgotten | `shop/redact` and `customers/redact` really delete (tested against a real database); uninstall disables the recipe and deletes the stored credentials immediately | `core/compliance/handlers.ts` |
| A bad recipe run | Per-recipe kill switch; new recipes start in dry-run; going live needs a typed word | app and `/admin` |
| Bulk export | There is no export feature; the app shows one store only its own data | `core/embedded` |

## What is not in place (said plainly)
- **No backups.** The Railway plan in use (Hobby) has no automatic backups. Railway documents volume backups and point-in-time recovery for
  PostgreSQL, but those are not available on this plan, and we take no manual dumps (a manual encrypted dump was designed and dropped on
  2026-11-03). If the database is lost, the data below is lost.
- **No hosted staging.** `docker-compose.staging.yml` and `docs/ENVIRONMENTS.md` describe a local staging with its own database, but it has not been run; the only hosted service is production. Tests run against a local database.
- **No independent check** of the at-rest encryption beyond Railway's statement.

## If the database were lost: what can and cannot be rebuilt
| Data | Rebuildable? |
|---|---|
| Orders | The service stores no orders and calls no Shopify order API (it holds no Shopify access token), so it cannot fetch past orders. Only deliveries Shopify itself retries would arrive again |
| Stored Salesforce connections | No. Each merchant must enter the connection again (the secret is only in the database, encrypted) |
| Recipe settings | No. They return to defaults (recipe off, dry-run) |
| Decision log, audit entries, privacy-request records | No. The decision log is a convenience record; the audit trail and privacy-request history are lost |
| Links from orders to Salesforce records | No. They are used to avoid duplicates; what happens to duplicates afterwards is untested |
| Records already written to Salesforce | Unaffected: they live in the merchant's own org |
| Erasures already carried out | Not restored: an empty database holds no erased data, but a restore from some other copy could bring erased data back, so any restore would need erasures replayed first |

## Options to close the gaps (owner's decision)
1. A Railway plan that includes volume backups and PostgreSQL point-in-time recovery (confirm the current plan terms and price in the dashboard).
2. A second Railway service as hosted staging (the local one needs a tunnel to receive Shopify webhooks).
3. Manual encrypted dumps (was designed, rejected as manual and single-operator).
