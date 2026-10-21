// Shopify webhook gateway logic. Order of operations matters (CLAUDE.md safety rules):
//   1. verify the HMAC over the RAW body, before any parsing        -> 401
//   2. only then parse; missing headers or invalid JSON              -> 400
//   3. topics nobody listens to are acknowledged, not queued         -> 200
//   4. one atomic intake (dedupe + enqueue); infrastructure failure  -> 500 so Shopify retries
// Never logs or returns the payload.

import { verifyShopifyHmac } from '../shopify/verifyHmac.ts';
import { isLifecycleTopic, minimizeLifecyclePayload } from '../compliance/topics.ts';
import type { GatewayDeps, HeaderBag, Job, Outcome } from './types.ts';

const SHOP_HEADER = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export interface WebhookResult {
  status: number;
  outcome: Outcome;
}

function header(headers: HeaderBag, name: string): string {
  const v = headers[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return typeof v === 'string' ? v : '';
}

function objectId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.admin_graphql_api_id === 'string' && p.admin_graphql_api_id !== '') return p.admin_graphql_api_id;
  for (const key of ['id', 'shop_id']) {
    const v = p[key];
    if (typeof v === 'number' || (typeof v === 'string' && v !== '')) return String(v);
  }
  return null;
}

export async function handleWebhook(
  input: { rawBody: Buffer; headers: HeaderBag },
  deps: GatewayDeps,
): Promise<WebhookResult> {
  const { rawBody, headers } = input;
  const topic = header(headers, 'x-shopify-topic');
  const shop = header(headers, 'x-shopify-shop-domain');
  const webhookId = header(headers, 'x-shopify-webhook-id');
  // Until the signature is verified, header values are attacker-controlled: they are NOT logged (no log flooding or injection).
  let authenticated = false;
  const done = (status: number, outcome: Outcome, reason?: string): WebhookResult => {
    deps.log(authenticated ? { outcome, topic, shop, webhookId, ...(reason ? { reason } : {}) } : { outcome, topic: '', shop: '', webhookId: '' });
    return { status, outcome };
  };

  // 1. Signature over the raw bytes, before anything else touches the body.
  if (!verifyShopifyHmac(rawBody, header(headers, 'x-shopify-hmac-sha256'), deps.secret)) {
    return done(401, 'unauthorized');
  }

  authenticated = true;

  // 2. Verified, so now it is safe to parse. The shop header must look like a Shopify shop domain (it is used as a key and in logs).
  if (topic === '' || webhookId === '' || !SHOP_HEADER.test(shop)) return done(400, 'bad_request');
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return done(400, 'bad_request');
  }

  // 3. Nobody listens to this topic: acknowledge so Shopify stops retrying, queue nothing.
  if (!deps.topics.has(topic)) return done(200, 'ignored_topic');

  // Compliance and uninstall deliveries: dedupe on the DELIVERY id (two different requests for one shop must both be processed),
  // and queue only what we need (order ids + request id), never the customer's email, phone or id.
  if (isLifecycleTopic(topic)) {
    const min = minimizeLifecyclePayload(topic, payload, shop);
    if (!min.ok) return done(400, 'bad_request', min.reason);
    const lifecycleJob: Job = {
      webhookId, eventId: header(headers, 'x-shopify-event-id'), topic, shop: min.value.shopDomain, apiVersion: header(headers, 'x-shopify-api-version'),
      businessKey: webhookId, receivedAt: deps.now().toISOString(), payload: JSON.stringify(min.value),
    };
    try {
      return done(200, await deps.intake.accept(lifecycleJob));
    } catch {
      return done(500, 'intake_error');
    }
  }

  const id = objectId(payload);
  const job: Job = {
    webhookId,
    eventId: header(headers, 'x-shopify-event-id'),
    topic,
    shop,
    apiVersion: header(headers, 'x-shopify-api-version'),
    businessKey: id === null ? webhookId : `${topic}|${shop}|${id}`,
    receivedAt: deps.now().toISOString(),
    payload: rawBody.toString('utf8'),
  };

  // 4. Atomic dedupe + enqueue. If it throws, answer 500: nothing was recorded, so Shopify's retry is processed.
  try {
    const result = await deps.intake.accept(job);
    return done(200, result);
  } catch {
    return done(500, 'intake_error');
  }
}
