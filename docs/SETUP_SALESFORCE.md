# Setting up Salesforce for Bridge Recipes

Bridge Recipes talks to **your own** Salesforce org through an **External Client App** with the OAuth 2.0 **client credentials**
flow. It never uses a Connected App (Salesforce disabled creating new ones by default in Spring '26) and never asks for a
Salesforce username or password. This guide sets up the three things the service needs: a dedicated integration user, a narrow
permission set, and the External Client App. Then you connect it from the Shopify app (or `/admin`).

**Status.** The permission list and the troubleshooting notes below come from hands-on runs against a Developer Edition org
(2026-10-19 to 2026-10-21; see `PROJECT_CONTEXT.md` sections 15 to 30). The menu labels in Setup are from Salesforce's
documentation and from those runs; Salesforce changes labels between releases, so treat them as a map, not a script. Sources and
the date they were read are in [What is verified](#what-is-verified-and-what-is-not).

## What the service does in Salesforce (and what it never does)
- **Reads:** Leads by email, Contacts by email, Accounts by website domain.
- **Writes (only when the recipe is LIVE):** creates a **Lead** (`Company`, `LastName`, `Email`, `LeadSource`, `Description`, and the
  owner if you set one), appends an order note to an existing Lead's `Description`, and creates a **Task** on an existing Account or
  Contact (`Subject`, `Description`, `WhatId`, `WhoId`, owner).
- **Never:** deletes anything, creates Accounts or Contacts, converts Leads, forces a duplicate through a duplicate rule, or changes
  any Salesforce setting. In dry-run it writes nothing at all.
- API calls are cheap: orders that can be skipped without Salesforce data (no email, free-mail domain, below the minimum, no
  consent) cost **zero** API calls, and a disabled recipe makes none.

## Before you start
- A Salesforce org where you are a system administrator. A free **Developer Edition** org worked for all of the project's tests.
- **One free *full* Salesforce user licence** for the integration user. The "Salesforce Integration" licence is not enough: with it,
  the Task object answered `404 NOT_FOUND` over the API even with permissions granted (found hands-on, 2026-10-20).
- Your **My Domain** is deployed (the address looks like `https://<yourdomain>.my.salesforce.com`).

## 1. Create the integration user
Setup, Users, New User:
- **Licence:** Salesforce (a full licence). **Profile:** `Minimum Access - Salesforce`.
- A username you will recognise, such as `bridgerecipes@<your-domain>.com`, and an email you can read (Salesforce sends the activation
  email there). Nobody ever logs in as this user; the app uses it only through the External Client App.
- On Enterprise Edition and above Salesforce recommends the **API Only User** permission for a client-credentials Run As user
  ([Salesforce Help](https://help.salesforce.com/s/articleView?language=en_US&id=sf.connected_app_client_credentials_setup.htm&type=5)).
  It was not needed in the project's runs.

## 2. Create the permission set and assign it
Setup, Permission Sets, New. Name it `Bridge_Recipes_Integration`. Grant exactly this, and assign it to the integration user:

| Area | Grant |
|---|---|
| System permissions | **API Enabled**, **Edit Tasks** |
| Lead | Read, Create, Edit. **No Delete, no View All.** Field access: `Email`, `LeadSource`, `Description` (read and edit). `Company` and `LastName` are writable without a grant in this org, so they cannot be restricted. |
| Account | Read. Field access: `Website`. |
| Contact | Read. Field access: `Email`, `AccountId`. |
| Task | Field access (read and edit) on **`Description`** (shown as Comments), **`WhatId`** (Related To) and **`WhoId`** (Name). Without these, a Task that carries a description or a related record fails with `INVALID_FIELD`. |

Do not add Delete, Modify All or View All on anything. The app is designed not to need them.

## 3. Create the External Client App
Setup, **External Client App Manager**, New External Client App.
1. Name it (for example `Bridge Recipes`), give a contact email, and choose **Local** distribution (right for your own org).
2. **OAuth settings:** enable OAuth. Select the scope **Manage user data via APIs (api)** and no others. Salesforce's form may ask
   for a callback URL even though the client-credentials flow does not use one; any HTTPS address you control will do (this step was
   done in the browser by the maintainer and the exact field was not recorded).
3. Open the app's **Policies** tab, **Edit**, **OAuth Policies**, and enable the **Client Credentials Flow**. Set **Run As** to
   your integration user. Save.
4. On the app's **Settings** tab open **OAuth Settings** and reveal the **Consumer Key and Secret** (Salesforce asks you to verify
   your identity first). Copy them into a password manager. Anyone who holds both can request tokens for the Run As user, so
   treat them like a password and rotate the secret if either is exposed
   ([Salesforce Help](https://help.salesforce.com/s/articleView?language=en_US&id=xcloud.remoteaccess_oauth_client_credentials_flow.htm&type=5)).

Salesforce's own pages for this flow:
[Configure an External Client App for the Client Credentials Flow](https://help.salesforce.com/s/articleView?id=sf.meta_configure_client_credentials_flow_for_external_client_apps.htm&language=en_US&type=5).

## 4. Check that Run As really took effect
**This is the step people miss.** In the project's own setup the first save of the Run As setting did *not* apply: the token still
belonged to the System Administrator, so every permission test would have run with far too much power. Saving it a second time fixed
it. Check it yourself before trusting anything else. In a terminal (the values are read from variables so nothing is printed):
```
export SF_LOGIN_URL='https://<yourdomain>.my.salesforce.com'
export SF_CLIENT_ID='<consumer key>'
export SF_CLIENT_SECRET='<consumer secret>'
TOKEN=$(curl -s -X POST "$SF_LOGIN_URL/services/oauth2/token" -d grant_type=client_credentials \
  -d client_id="$SF_CLIENT_ID" -d client_secret="$SF_CLIENT_SECRET" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $TOKEN" "$SF_LOGIN_URL/services/oauth2/userinfo" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("preferred_username"))'
unset TOKEN SF_CLIENT_SECRET
```
The last line must print **your integration user's username**. If it prints an administrator, go back to the Policies tab, set
Run As again, save, and re-run. (This exact check was run against the maintainer's org and printed the integration user.) Clear your
terminal history afterwards if it recorded the secret.

## 5. Connect it in the app
In the Shopify app open **Set up** (or `/admin`, the shop's page) and enter:
- **My Domain URL:** `https://<yourdomain>.my.salesforce.com`. Only HTTPS Salesforce domains with no port are accepted
  (`*.my.salesforce.com`, `*.salesforce.com`, `*.force.com` and the `*.salesforce-setup.com` equivalents); anything else is refused so the
  secret can never be sent to a look-alike host.
- **Consumer key** and **consumer secret** from step 3.

Press **Save connection**, then **Test connection**. It should say "The Salesforce connection works." The secret is stored
encrypted and is never shown again (the Set up page shows only the last four characters of the key). Then enable the recipe in
**dry-run**, place a test order, and read the decision before you ever go live (see `docs/DEPLOY_RAILWAY.md`).

## 6. Choices worth knowing about
- **Lead source.** The recipe sends `LeadSource` = the value in the recipe settings (default `Shopify Order`). If your org's Lead
  Source picklist is *restricted* and does not contain that value, Salesforce refuses the write; the service then retries once
  without it and notes the value in the Lead's description (this retry is covered by automated tests only: the maintainer's org has an
  unrestricted picklist). Easier: add the value to the picklist, or set the setting to a value that exists.
- **Lead owner.** A new Lead is owned by the user the token runs as, which is the integration user. To have Leads land with a person
  or a queue owner, set **Default Lead owner** (a Salesforce User id starting `005`) in the recipe settings. Setting a different
  owner works (tested).
- **Duplicates.** The service never overrides a duplicate rule. If a rule blocks the write, the decision is `duplicate_detected`
  and nothing is created. If the email is already a Lead, the order is added to that Lead's description instead (or skipped,
  your choice in the settings).
- **Deleting.** The integration user can delete only Tasks it owns, and never Leads. After a customer or shop erasure request, the
  **Privacy requests** page lists the Salesforce records to review; an administrator deletes them in Salesforce.

## 7. Troubleshooting
| Symptom | Cause and fix |
|---|---|
| Test connection fails with an auth error | Wrong key or secret, or the Client Credentials Flow is not enabled on the app's Policies. Use the My Domain URL, not `login.salesforce.com`. |
| It works, but permission checks pass too easily | Run As is still an administrator. Do step 4. |
| A Task fails with `INVALID_FIELD` | The permission set lacks field access on Task `Description`, `WhatId` or `WhoId` (step 2). |
| Task calls answer `404 NOT_FOUND` | The integration user is on the "Salesforce Integration" licence. Move to a full Salesforce licence. |
| Lead creation fails mentioning a restricted picklist | The Lead Source value is not in the picklist (section 6). |
| `duplicate_detected` | A duplicate rule blocked the write. Review the existing record in Salesforce. |
| `BAD_INSTANCE_URL` | The org returned an instance address that is not a Salesforce domain, which the service refuses by design. |
| `GET /limits` answers 403 | Seen for the first test user (the Integration licence); not re-checked for the full-licence user. The service does not call it: it reads the `Sforce-Limit-Info` header instead and needs no extra permission. |

## What is verified, and what is not
**Seen working** against a Developer Edition org (2026-10-19 to 2026-10-27, scripts and screenshots, secrets never printed): the
External Client App with the client-credentials flow and the `api` scope; the token response has no `expires_in` and no refresh
token (re-checked 2026-10-27), and the service fetches a token on demand; the integration user on a **full** licence with the
permission set above; denied as designed (Lead delete, Account create and update, Contact create); Lead create with a set owner;
Lead `Description` update; a Task on an existing Account and on an existing Contact, each assigned to another owner; a real Lead
written by the recipe in a short live window; `Test connection` from the Shopify app; and the `userinfo` check in step 4.

**Not verified:** the exact labels and the callback-URL field in the External Client App creation form (done in the browser,
not recorded); the API Only User permission on this licence; the restricted-picklist retry against a real restricted picklist; behaviour in Enterprise or Professional Edition orgs, in a sandbox, or
with a different duplicate rule (the org's standard Lead rule did not fire for R1's fields); how long a token lives (the response
carries no lifetime; the service simply re-authenticates once after a 401); a live Salesforce write from the Railway deployment.
Salesforce platform facts are from help.salesforce.com pages read on 2026-10-27 (search results; developer.salesforce.com refused
direct fetches) and from `docs/research/R1_PLATFORM_FACTS.md`. Re-check them before relying on them.
