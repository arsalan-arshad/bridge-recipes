// Mandatory privacy webhooks and the uninstall lifecycle topic.
// Source (read 2026-10-21): https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
//   customers/data_request  { shop_id, shop_domain, orders_requested[], customer{id,email,phone}, data_request{id} }
//   customers/redact        { shop_id, shop_domain, customer{id,email,phone}, orders_to_redact[] }
//   shop/redact             { shop_id, shop_domain }   (sent 48 hours after uninstall)
// Respond 2xx, complete within 30 days, 401 on an invalid HMAC. app/uninstalled is an ordinary topic (not on that page).

export const COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;
export const UNINSTALL_TOPIC = 'app/uninstalled';
export const LIFECYCLE_TOPICS: readonly string[] = [...COMPLIANCE_TOPICS, UNINSTALL_TOPIC];

export const isLifecycleTopic = (topic: string): boolean => LIFECYCLE_TOPICS.includes(topic);

// What we keep from a compliance delivery: order ids and the request id ONLY. The customer's email, phone and id in the
// payload are deliberately dropped before anything is queued or stored (we do not need them: our tables hold order ids).
export interface MinimizedRequest {
  topic: string;
  shopDomain: string;
  orders: string[]; // numeric Shopify order ids as strings
  requestId: string | null; // data_request.id
}

const MAX_ORDERS = 10_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function orderIds(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_ORDERS) return null;
  const out: string[] = [];
  for (const x of v) {
    const n = typeof x === 'string' && /^[0-9]{1,16}$/.test(x) ? Number(x) : x;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return null;
    out.push(String(n));
  }
  return [...new Set(out)];
}

export function minimizeLifecyclePayload(topic: string, payload: unknown, headerShop: string): { ok: true; value: MinimizedRequest } | { ok: false; reason: string } {
  if (!isLifecycleTopic(topic)) return { ok: false, reason: 'not_a_lifecycle_topic' };
  if (!isObj(payload)) return { ok: false, reason: 'payload_not_object' };
  const shopDomain = headerShop.trim().toLowerCase();
  if (shopDomain === '') return { ok: false, reason: 'missing_shop' };
  // The header is authenticated (HMAC), the body field is not trusted on its own: a mismatch is rejected.
  if (typeof payload.shop_domain === 'string' && payload.shop_domain.trim().toLowerCase() !== shopDomain) return { ok: false, reason: 'shop_mismatch' };
  let orders: string[] | null = [];
  if (topic === 'customers/data_request') orders = orderIds(payload.orders_requested);
  if (topic === 'customers/redact') orders = orderIds(payload.orders_to_redact);
  if (orders === null) return { ok: false, reason: 'invalid_order_ids' };
  let requestId: string | null = null;
  if (topic === 'customers/data_request' && isObj(payload.data_request) && (typeof payload.data_request.id === 'number' || typeof payload.data_request.id === 'string')) {
    requestId = String(payload.data_request.id).slice(0, 64);
  }
  return { ok: true, value: { topic, shopDomain, orders, requestId } };
}
