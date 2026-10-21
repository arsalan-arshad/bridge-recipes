// Maps a parsed Shopify orders/paid webhook body to R1's minimal OrderPaidEvent.
// Field names verified against two real signed deliveries (API 2026-10, admin-created paid draft orders,
// 2026-10-19; payloads/SHOPIFY_real_*). Verified ONLY for admin-created orders: re-check on the first real
// storefront order, in dry-run.
// Consent: the order-level buyer_accepts_marketing boolean (owner ruling 2026-10-19). The real payload's
// customer object has NO email_marketing_consent, so that is deliberately not read. Anything but a boolean
// true (missing, null, string, number) means no consent.
// Everything unknown fails closed: no consent, no email, or ok:false.
// Logging rule: log only the boolean outcome, never the raw payload.

import type { OrderPaidEvent } from './types.ts';

export type MapResult = { ok: true; event: OrderPaidEvent } | { ok: false; reason: string };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export function mapOrderPaid(payload: unknown): MapResult {
  if (!isObj(payload)) return { ok: false, reason: 'payload_not_object' };

  const orderId = str(payload.admin_graphql_api_id) ?? (typeof payload.id === 'number' ? `gid://shopify/Order/${payload.id}` : null);
  if (orderId === null) return { ok: false, reason: 'missing_order_id' };

  const orderName = str(payload.name);
  if (orderName === null) return { ok: false, reason: 'missing_order_name' };

  const currency = str(payload.currency);
  if (currency === null) return { ok: false, reason: 'missing_currency' };

  const rawTotal = payload.total_price;
  const total = typeof rawTotal === 'string' ? Number(rawTotal) : typeof rawTotal === 'number' ? rawTotal : NaN;
  if (!Number.isFinite(total) || total < 0) return { ok: false, reason: 'invalid_total' };

  const productTitles: string[] = [];
  if (Array.isArray(payload.line_items)) {
    for (const item of payload.line_items) {
      if (isObj(item)) {
        const title = str(item.title);
        if (title !== null) productTitles.push(title);
      }
    }
  }

  const customer = isObj(payload.customer) ? payload.customer : null;
  const marketingConsent = payload.buyer_accepts_marketing === true;

  const customerId =
    customer === null ? null : str(customer.admin_graphql_api_id) ?? (typeof customer.id === 'number' ? `gid://shopify/Customer/${customer.id}` : null);

  const email = (customer !== null ? str(customer.email) : null) ?? str(payload.contact_email) ?? str(payload.email);
  const lastName = customer !== null ? str(customer.last_name) : null;

  const billing = isObj(payload.billing_address) ? payload.billing_address : null;
  const billingCompany = billing !== null ? str(billing.company) : null;

  return {
    ok: true,
    event: {
      orderId,
      orderName,
      currency,
      total,
      productTitles,
      customer: { id: customerId, email, lastName, marketingConsent },
      billingCompany,
    },
  };
}
