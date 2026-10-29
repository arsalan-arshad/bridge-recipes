# Installing the Shopify app on a store

Bridge Recipes is a Shopify app that **you** create in **your own** Shopify account (Dev Dashboard) and point at **your own**
copy of the service. This guide covers the Shopify side: creating the app, getting its credentials, releasing its configuration,
installing it on a store, and opening it. The server side is in [`DEPLOY_RAILWAY.md`](DEPLOY_RAILWAY.md) and the Salesforce side in
[`SETUP_SALESFORCE.md`](SETUP_SALESFORCE.md). Do the Railway guide's steps 1 to 4 first: the app needs a public address to point at.

**Status.** Written from Shopify's documentation (read on 2026-10-29, URLs inline) and from the maintainer's development store,
where the app is installed and opens inside the admin. What was and was not seen is listed at the end. Dashboard labels change;
treat the menu names as a map.

## 1. Decide two things first
**a) A development store or a real store?** Start with a **development store** (you can create one from your Partner account): test
orders are not real sales and nothing is written to Salesforce while the recipe is in dry-run. Move to a real store only after you have read
several dry-run decisions.

**b) The distribution method. This cannot be changed after you choose it**
([Select a distribution method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)):
| You want | Choose | Note |
|---|---|---|
| To try it on a development store | Any; the Dev Dashboard's **Installs** card installs on a development store | The Distribution card appears only for apps that belong to a Partner organization; an app created in your store's own organization is installed from the Installs card instead. |
| To run it for **one real store** (yours or a client's) | **Custom distribution** | Shopify's guidance for "building for a specific merchant". You generate an install link and the store owner opens it. |
| To list it in the Shopify App Store for many merchants | **Public distribution** | Needs App Store registration (a one-time fee) and review. See `docs/BUILD_PLAN.md`, milestone M7: that is a separate project, not part of self-hosting. |
Shopify's advice: if you keep separate apps for development and production, choose the distribution method on the **production**
app ([About app distribution](https://shopify.dev/docs/apps/launch/distribution)). The maintainer's development app was set to Public.

## 2. Create the app and get its credentials
1. Open the **Dev Dashboard**, **Apps**, create a new app (it needs a Shopify Partner account).
2. Open the app, **Settings**, **Credentials**: you will see the **client ID** (public, permanent) and the **client secret**
   ([Manage your app credentials](https://shopify.dev/docs/apps/build/authentication-authorization/manage-credentials)).
3. Put them on your service (Railway, service variables, never in a file or a chat):
   - `SHOPIFY_API_KEY` = the **client ID** (switches on the page inside the Shopify admin).
   - `SHOPIFY_WEBHOOK_SECRET` = the **client secret** (Shopify signs every webhook with it, and the service also uses it to verify
     the app's sign-in token).

## 3. Release the app's configuration
An app must have at least one released **version** before it can be installed
([Create apps using the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard)). The
version holds the App URL, the webhooks and the scopes. Use the Shopify CLI, so the configuration lives in a file you control:
1. Copy [`shopify.app.toml.example`](../shopify.app.toml.example) to `shopify.app.toml` (git-ignored on purpose) and fill in your
   client ID, a name, and your service address in two places (the App URL ending in `/app`, and the webhook address ending in
   `/webhooks/shopify`). `shopify app config link` can also write the file for you.
2. It asks for **one scope, `read_orders`**, subscribes to `orders/paid` and `app/uninstalled`, and declares the three privacy
   webhooks. Do not add scopes without a reason.
3. Run `shopify app deploy` and approve the release (it is interactive). The Dev Dashboard's **Versions** page then shows your
   version as Active, with the same App URL, scope and webhook addresses.
4. Whenever you change the file, run it again. New scopes are not applied to stores automatically: the store owner must approve
   them in the Shopify admin.

## 4. Install it on a store
**Development store.** Dev Dashboard, **Apps**, your app, the **Installs** card, **Install app**, choose the store, **Install**.
The install opens Shopify's consent screen in a new tab; approve it. (You can also use the three-dot menu on the app's row, or the
CLI.) ([Create apps using the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard))

**A real store with Custom distribution.** In the app's Home, the **Distribution** card, select **Custom distribution**, enter the
store's `myshopify.com` address, **Generate link**, and send the link to the store owner, who opens it and approves
([Select a distribution method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)). To limit the app
to that one store, clear "Allow multi-store installs".

**What the owner approves:** reading orders (`read_orders`). Nothing else.

**Protected customer data.** The name and email that arrive with an order are protected customer data. On the maintainer's
development store the orders arrived with what R1 needs; for a real store check Shopify's current rules and request access if
needed ([Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)). Without it, R1 may see no
email and will skip orders with `no_email`.

## 5. Tell the service the store is yours, then open the app
1. Open your service's `/admin`, sign in, **Add a shop**: `<your-store>.myshopify.com`. Only stores you add can open the app (so
   another store that installs a public app cannot).
2. In the Shopify admin open **Apps**, then your app. It opens **inside the admin** on its home page, with a "Get started"
   checklist: connect Salesforce, test it, turn the recipe on in dry-run, place a paid test order.
3. If a store has a **storefront password** (development stores often do), enter it before placing a test order, or the order never
   happens.

## 6. Uninstalling and reinstalling
- Uninstalling sends `app/uninstalled`. The service then **disables the recipe, deletes the stored Salesforce credentials and
  removes queued jobs** for that store (the **Privacy requests** page records it). **After a reinstall you must reconnect
  Salesforce and turn the recipe on again.**
- Shopify documents that it sends `shop/redact` 48 hours after an uninstall, asking the app to erase the store's data
  ([Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)). On the maintainer's store the
  app was reinstalled within minutes and **no `shop/redact` arrived in the three days that followed** (checked 2026-10-29). The
  documentation does not say whether a quick reinstall cancels it, so this is an observation, not a rule.
- A real `shop/redact` has therefore not been seen against the service; the handler is tested with signed test requests only.

## 7. Rotating the client secret
Rotate it if it is exposed ([Manage your app credentials](https://shopify.dev/docs/apps/build/authentication-authorization/manage-credentials)).
The service accepts **one** secret (`SHOPIFY_WEBHOOK_SECRET`), but Shopify signs webhooks with the *oldest active* secret until you
revoke it. So: create the new secret in the Dev Dashboard, then update the Railway variable and revoke the old secret one right after
the other. Expect a short window in which webhooks are refused with 401; Shopify retries failed deliveries. This sequence has **not**
been tried.

## 8. Troubleshooting
| Symptom | Likely cause and fix |
|---|---|
| The app cannot be installed | No version has been released (section 3), or the distribution method does not allow that store. |
| It installs but opens a blank page or "not set up" | `SHOPIFY_API_KEY` is missing on the service, the App URL is not `https://<your-service>/app`, or the store was not added on `/admin` (section 5). |
| Shopify shows webhook failures, the service answers 401 | `SHOPIFY_WEBHOOK_SECRET` is not the app's current client secret. |
| Orders arrive but every decision is `no_email` | Protected customer data is not available to the app on that store (section 4). |
| A test order does not appear at all | The store's storefront password was not entered, the order was not paid, or the webhook address is wrong. |
| After reinstalling, nothing is processed | The recipe was disabled and the Salesforce credentials deleted by the uninstall (section 6): reconnect and turn it on. |
| Every order is processed twice | Old store-level webhooks still exist; remove them. |

## What is verified, and what is not
**Seen on the maintainer's development store (2026-10-26 to 2026-10-29):** the app, created in the Dev Dashboard with Public
distribution, is installed and shows the single permission "read orders"; its released version carries the Railway address,
`embedded = true`, the scope, the two webhook topics and the three privacy URLs; real signed `app/uninstalled` and `orders/paid`
deliveries were accepted; the app opens inside the admin from the Apps list; the sections of this guide about adding the store,
the first-run checklist, uninstall behaviour (read in the code and seen in the Privacy requests records) and the missing
`shop/redact` are from those runs.

**Not verified:** installing through a Custom distribution link (documented by Shopify, not done here); installing on a real
(non-development) store; whether protected customer data access is needed or granted on a real store; rotating the client secret;
the exact labels of the Dev Dashboard (taken from Shopify's pages as read on 2026-10-29).
