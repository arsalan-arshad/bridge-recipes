# Security

This app processes Shopify order data (including customer names and emails) and writes to the merchant's own Salesforce org. It keeps order ids, a sync log with personal values masked, and Salesforce record ids, and it handles Shopify's privacy webhooks (customers/data_request, customers/redact, shop/redact). It is a developer preview and has not been security-audited by a third party.

If you find a security issue, please **do not open a public issue**. Use GitHub's private vulnerability reporting
(the repository's Security tab, "Report a vulnerability"), or email arsalanarshad.dev@gmail.com with details.
We'll acknowledge within a few days.
