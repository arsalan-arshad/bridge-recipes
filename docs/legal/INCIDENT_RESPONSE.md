# Security incident response (DRAFT)

Shopify's protected-customer-data rules (level 2) require a written incident response policy. This is a plan for a one-person
operation; adapt it if more people join. It has not been rehearsed.

**Contact:** arsalanarshad.dev@gmail.com (the one public contact; also the Shopify emergency developer contact).

## Severity
| Level | Meaning | Example |
|---|---|---|
| 1 | Confirmed exposure of customer data or Salesforce credentials | A database dump leaves our control; the encryption key leaks |
| 2 | Likely exposure or a successful attack with no known data loss | Unexplained admin logins; a vulnerability exploited |
| 3 | Weakness found, no sign of misuse | A reported bug; a dependency advisory |

## Steps
1. **Contain (first hour).** Set `MERCHANT_GO_LIVE` and `OPEN_REGISTRATION` off; use each store's kill switch or disable the recipes
   in bulk (so nothing more is written to any Salesforce); rotate `ADMIN_PASSWORD`; if credentials may have leaked, rotate
   `ENCRYPTION_KEY` plan (stored secrets must be re-entered by merchants) and the Shopify client secret
   (https://shopify.dev/docs/apps/build/authentication-authorization/manage-credentials).
2. **Assess (same day).** What data, which stores, since when. Evidence: the service log, `admin_audit`, Railway and GitHub audit logs.
3. **Notify.** Affected merchants by email without undue delay (and within any legal deadline that applies: [confirm, e.g. 72 hours
   for personal-data breaches under GDPR]); Shopify through the Partner support channel; regulators where required. Tell merchants to
   rotate the consumer secret of their External Client App.
4. **Fix and verify.** Patch, add a test, deploy, confirm.
5. **Review (within a week).** Write what happened and what changes; append it to `PROJECT_CONTEXT.md` without personal data.

## Not yet in place
Practised drill; alerting on unusual access; a second person with access.
