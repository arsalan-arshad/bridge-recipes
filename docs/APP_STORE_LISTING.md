# App Store listing and review preparation (DRAFT)

Drafted 2026-10-29 from Shopify's pages ([App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements),
[Best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices), [Submit your app](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)).
Nothing here has been submitted. Submitting is the owner's decision. Rules are summarised, not quoted: re-read the pages before submitting.

## Listing text
- **App name:** Bridge Recipes (must be unique, and similar to the name in the Dev Dashboard; the Dev Dashboard name today is the
  development app's name, so rename it or create a production app first: Shopify advises choosing the distribution method on the
  production app).
- **App introduction (100 characters, benefit-led, no keyword stuffing):** "Turn business buyers in your Shopify orders into Salesforce Leads, after a safe dry-run first." (94 characters)
- **Details:** Bridge Recipes watches paid orders and spots buyers who look like businesses (a company billing name, or a company email
  domain). In dry-run it only shows what it would do. When you turn it on, it creates a Lead in your Salesforce, adds the order to a
  Lead you already have, or logs a Task on an existing Account or Contact. It never deletes or merges anything, honours your
  customers' marketing consent by default, and keeps nothing it does not need.
- **Feature list:** dry-run first, nothing written until you go live; one kill switch; decision log with the reason for every order;
  consent filter on by default; free-mail domains skipped; duplicate-safe; set-up guide and a read-only "Check my setup" for Salesforce.
- **Integrations:** Salesforce.
- **Pricing details:** free. (Pricing may appear only in the pricing section, never in images or text elsewhere.)
- **Support:** arsalanarshad.dev@gmail.com. **Privacy policy URL:** [publish `docs/legal/PRIVACY_POLICY.md` first].
- **Install eligibility:** Online Store sales channel; no country limits. [Confirm after the first real storefront order.]

## Images (all 1600 x 900, 16:9, no pricing, no personal data, alt text for each)
1. Feature image: one focal point, solid background, no Shopify logo, not a copy of the introduction.
2. Screenshots, 3 to 6 desktop: home with the first-run checklist; the decision log with a skipped and a dry-run row; the Salesforce
   setup guide with a passing check; recipe settings; the Privacy requests page.
3. App icon 1200 x 1200 PNG or JPEG.
4. Optional 2 to 3 minute video, promotional, screencast under 25%.
Use only the development store; mask or avoid real emails (the app already masks them).

## What the reviewer needs
- A **demo / test store link** and a one-page instruction: install, open the app, follow the guide, place a paid test order, read the decision.
- **Working Salesforce test credentials with full access** (Shopify asks for valid credentials for third-party platforms): a dedicated
  Developer Edition org already set up as in `docs/SETUP_SALESFORCE.md` (full-licence integration user, permission set, External Client
  App). Give the reviewer the My Domain URL, consumer key and secret in the submission form only, never in this repository, and rotate them after review.
- A **screencast** (English) of: install, set-up guide, connection test, dry-run order, decision, going live, kill switch, uninstall.
  Show the expected result for each test case.
- Compliance webhooks are subscribed; the endpoint verifies signatures and answers 401 to a bad one (checked on the live service).
- Protected customer data: request name and email in the Partner Dashboard with the reason from `docs/legal/PRIVACY_POLICY.md`
  (the minimum the recipe needs: email to find or create the Lead, last name and company for the Lead's required fields).

## Known gaps before submitting (be honest in the review notes)
- Privacy policy and terms not yet reviewed or published; Level 2 items in `docs/LEVEL2_READINESS.md` not all closed.
- Hosting: one service on one provider, no staging service, no verified backups or restore.
- Not tested on a real storefront order from a non-admin customer; not tested in Chrome incognito or on a phone-sized admin; no Lighthouse run.
- The Salesforce side asks a merchant for about 15 minutes of set-up in their own org (guide plus check). Expect reviewer friction there.
- Settings to switch on for a public app (off by default): `OPEN_REGISTRATION=true`, `MAX_SHOPS`, `MERCHANT_GO_LIVE=true`.
- The app has no billing (free). Charging later would need Shopify's billing API.
