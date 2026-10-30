# Submission pack (ready to paste, DRAFT)

Everything the owner needs to paste into Shopify's forms, and the steps only the owner can do. Written 2026-10-30. Nothing here has been submitted.

## 1. Owner-only steps (an assistant cannot do these)
1. **Two-step sign-in** on Railway, GitHub, Shopify Partners and Salesforce (account security settings).
2. **Legal:** answer the six questions in section 2, then have a lawyer read `docs/legal/`.
3. **Hosting facts:** in Railway, check whether the database volume is encrypted and whether backups exist, then tell me the answer so the Level 2 list can be updated.
4. **Reviewer Salesforce org:** sign up a second free Developer Edition org and follow `docs/SETUP_SALESFORCE.md` in it (an assistant cannot create accounts).
5. **Partner Dashboard:** paste section 3 into the protected customer data request; paste section 4 into the listing and review notes.
6. **Screencast:** record it from the script in section 5.
7. **Submit** the app.

## 2. Six facts for the legal drafts
Reply with: (1) the legal name or your own name to publish, (2) the country for governing law, (3) the Railway region, (4) whether any other service touches data, (5) how many days' notice before ending the free service, (6) the privacy contact (the project's one public email is used unless you say otherwise).

## 3. Protected customer data request (paste)
- **Data requested:** customer email and last name; billing company (all from the order-paid notification). Level 2.
- **Why the minimum:** the email finds or creates the merchant's Lead and Contact match in the merchant's own Salesforce; the last name and company fill the Lead's required fields. Nothing else is read: addresses, phone numbers and payment data are dropped when the notification arrives.
- **Processing:** only the store's own recipe, only into that store's own Salesforce, only when the merchant turns the recipe LIVE (it starts as a dry-run that writes nothing). Marketing consent is honoured by default.
- **Retention:** decision log 30 days with the email masked; queued notification 1 hour after success or 7 days if it failed; erased on `shop/redact`; credentials deleted on uninstall.
- **Safeguards:** HTTPS; signature checked on every webhook; Shopify session token checked on every in-app request; Salesforce secrets encrypted at rest; access to the log audited.

## 4. Review notes (paste)
Bridge Recipes spots business buyers in paid orders and, once the merchant turns it live, creates Leads or Tasks in the merchant's own Salesforce.
1. Install the app and open it from Apps. The home page shows a "Get started" checklist.
2. Open **Salesforce setup guide**. For review we pre-configured a Salesforce Developer org: open **Set up** and press **Test connection** (already saved), then the guide's **Check my setup** (all "ok").
3. Place a paid test order for a customer with a company email and the marketing box ticked. Within a minute the **Decision log** shows a `dry_run` row: nothing was written (the recipe starts in dry-run).
4. To see a write: on Set up, once the readiness list is complete, press **Go live**, type LIVE, place another test order, and look for the new Lead in Salesforce (credentials in the form). Press **Stop writing** or the kill switch to stop.
5. Uninstall: the recipe is disabled and the Salesforce credentials are deleted immediately; the rest is erased when Shopify sends the privacy request.
Test credentials for the Salesforce org go in the submission form only.

## 5. Screencast script (2 to 3 minutes, English)
1. Install from the Partner dashboard (10 s). 2. Open the app, show the checklist (10 s). 3. Open the guide, press Check my setup, all "ok" (30 s). 4. Place a paid test order, show the dry-run decision and the masked email (40 s). 5. Settings: minimum order total and consent (15 s). 6. Go live, place an order, show the Lead in Salesforce (40 s). 7. Kill switch and uninstall (15 s).

## 6. Assets
- App icon, 1200 x 1200: `docs/listing/app-icon.png` (source `app-icon.svg`).
- Screenshots (1600 x 900, 3 to 6): take them from the development store, cropped to the app, with order ids and emails already masked by the app.
