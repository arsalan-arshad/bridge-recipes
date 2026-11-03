---
title: "Privacy policy: Bridge Recipes"
layout: default
permalink: /legal/PRIVACY_POLICY.html
---

# Privacy policy: Bridge Recipes

Last updated: 2026-11-03. Not legal advice. Contact for everything in this policy: arsalanarshad.dev@gmail.com

## Who we are
Bridge Recipes ("the app") connects a Shopify store to the store owner's own Salesforce org. The service is operated by Arsalan Arshad, an individual (the "operator"). For the personal data of a store's customers we act as a **processor** for the store (the merchant), who is the
controller. For the merchant's own contact data (the store domain, the Shopify account user id) we are the controller.

## What we process, and why
| Data | Source | Why | Where it goes |
|---|---|---|---|
| Store domain (`example.myshopify.com`) | Shopify | To know which store a request belongs to | Our database |
| Shopify user id of the person using the app | Shopify session token | To record who changed a setting | Our audit log |
| Per paid order: order id and name, total and currency, product titles, the customer's **email address**, and the billing **company** and **name** | Shopify "order paid" webhook | To decide whether the order looks like a business buyer and, only when the store has turned the recipe LIVE, to create or update a Lead or Task in the store's Salesforce | The store's own Salesforce org (LIVE only). In dry-run nothing is sent. |
| Decision log: order id, outcome, reason, and the planned Salesforce operation **with the email masked** (`a***@domain`) | Computed by us | So the merchant can see what the app decided | Our database |
| Salesforce My Domain URL, consumer key, consumer secret | Entered by the merchant | To connect to the merchant's Salesforce | Our database, secret **encrypted** (AES-256-GCM) |

While an order waits to be processed, a **reduced copy of the order notification** (only the order id, name, total, currency, product titles, the customer's email and last name, the billing company, and the marketing-consent flag; addresses, phone numbers and payment details are dropped on arrival) is held in our job queue. Jobs queued before 2026-10-29 may hold the full notification until they expire. It is deleted **one hour after processing succeeds**. If processing keeps failing, the job is kept **up to 7 days** so it can be replayed, then deleted. After that we keep only the masked decision log. We do **not** sell personal data, we do **not** use it for
advertising, and we do not use it for any purpose other than the one in the table.

## Customer consent
By default the recipe processes only orders whose customer ticked the store's email-marketing consent box (the merchant can change
this in the recipe settings). An order without consent is skipped.

## Retention
Decision log 30 days, webhook receipts 14 days, record links to Salesforce 30 days, compliance records 365 days (defaults; the
operator can shorten them). Queued order notifications: 1 hour after success, up to 7 days if processing failed (see above). The Salesforce connection is deleted when the app is
uninstalled; everything else about the store is erased when Shopify sends the `shop/redact` request (48 hours after uninstall).
Customer requests (`customers/redact`, `customers/data_request`) are honoured as Shopify sends them.

## Data in Salesforce
Records the app writes to the merchant's Salesforce belong to the merchant. We cannot delete them (the integration user has no delete
permission); after an erasure request the app lists the records the merchant should review there.

## Sub-processors and location
Hosting and database: Railway (one service and one PostgreSQL database on the same provider), region US West (California, USA). Shopify and Salesforce are the merchant's own
platforms. No analytics, advertising, error-tracking or email services are used (the only outbound connection the service makes is to the merchant's own Salesforce domain).

## Security
Transport encryption (HTTPS); Shopify webhook signatures verified before any parsing; Shopify session tokens verified on every request
inside the app; Salesforce secrets encrypted at rest; access to the operator admin page protected by a password of at least 12
characters; stored data minimised and emails masked in logs. No system is perfectly secure; see the incident process in
`docs/legal/INCIDENT_RESPONSE.md`.

## Your rights
A store's customer should ask the store. The store can ask us (address above) and we will help it respond. Merchants can erase their
data by uninstalling the app. Depending on where they live, individuals may have rights to access, correct, delete or object to the use of their personal data, and to complain to their local data protection authority. We act on the store's instructions and will help the store answer such requests; we respond to the store's own requests within 30 days.

## Changes
We will update this page and the date above. For material changes we will email the Shopify store contact and show a notice in the app.
