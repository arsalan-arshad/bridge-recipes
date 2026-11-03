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

## 4. Review notes (paste; 1877 of 2800 characters)
Bridge Recipes spots business buyers in paid orders and, once the merchant turns it live, creates Leads or Tasks in the merchant's own Salesforce. Each store starts empty: nothing is pre-configured for you.
1. Install the app and open it from Apps. Home shows a "Get started" checklist (recipe R1 is off).
2. Press "Set up Salesforce and the recipe". Enter the My Domain URL (in the account description), the Consumer key (test-account username) and the Consumer secret (test-account password), then press "Save connection" and "Test connection". No Salesforce sign-in, 2FA or one-time code is involved: the app uses the Salesforce Client Credentials flow.
3. Open "Salesforce setup guide" and press "Check my setup". All 7 checks should show "ok". It only reads; it writes nothing to Salesforce.
4. On Set up press "Enable in dry-run".
5. Place a paid test order for a customer with a company email (not gmail, yahoo etc.) with the marketing box ticked. Within a minute "Latest decisions" shows a dry_run row. Dry-run means the app decided it would create a Lead and wrote nothing. Emails are masked in the log.
6. Going live (writing to Salesforce) is an operator-only step on a separate admin page protected by a password; it is not done inside the app. You will therefore see dry_run decisions only. This does not limit what you can review: install, connection, setup check, decisions, settings, privacy pages and uninstall.
7. "Recipe settings": minimum order total, marketing-consent filter (on by default), domain lists. "Kill switch: disable" stops all processing.
8. Uninstall: the recipe is disabled, the stored Salesforce credentials are deleted and queued jobs are removed immediately. Shopify then sends the shop erasure request (about 48 hours later) and the app erases everything else it holds for the store.
Test-account credentials are in the form fields only.

**Account description for the test-account fields (222 of 255 characters; put the My Domain URL in place of the placeholder):**
Username = Consumer key, Password = Consumer secret. Enter both on the app's Set up page with the My Domain URL <MY_DOMAIN_URL>. No Salesforce sign-in, 2FA or OTP step is involved: the app uses the Client Credentials flow.

## 5. Screencast script (2 to 3 minutes, English)
1. Install from the Partner dashboard (10 s). 2. Open the app, show the checklist (10 s). 3. Open the guide, press Check my setup, all "ok" (30 s). 4. Place a paid test order, show the dry-run decision and the masked email (40 s). 5. Settings: minimum order total and consent (15 s). 6. Open the dry-run decision and show the planned Lead and masked email; say that going live is an operator-only step (30 s). 7. Kill switch and uninstall (15 s).

## 6. Assets
- App icon, 1200 x 1200: `docs/listing/app-icon.png` (source `app-icon.svg`).
- Screenshots (1600 x 900, 3 to 6): take them from the development store, cropped to the app, with order ids and emails already masked by the app.
