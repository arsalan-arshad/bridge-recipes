// Keeps only the fields mapOrderPaid reads, before the order notification is queued. Shopify sends the whole order (addresses, phone,
// payment details); R1 needs a handful of fields, so everything else is dropped at the door. mapOrderPaid(minimize(p)) must equal
// mapOrderPaid(p) for every payload (tested against the real deliveries). Unknown shapes are passed through unchanged: failing closed
// here would hide a problem that mapOrderPaid reports properly.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));

export function minimizeOrderPaid(payload: unknown): unknown {
  if (!isObj(payload)) return payload;
  const out = pick(payload, ['admin_graphql_api_id', 'id', 'name', 'currency', 'total_price', 'buyer_accepts_marketing', 'contact_email', 'email']);
  if (Array.isArray(payload.line_items)) out.line_items = payload.line_items.map((i) => (isObj(i) ? pick(i, ['title']) : i));
  if (isObj(payload.customer)) out.customer = pick(payload.customer, ['admin_graphql_api_id', 'id', 'email', 'last_name']);
  else if (Object.hasOwn(payload, 'customer')) out.customer = payload.customer;
  if (isObj(payload.billing_address)) out.billing_address = pick(payload.billing_address, ['company']);
  else if (Object.hasOwn(payload, 'billing_address')) out.billing_address = payload.billing_address;
  return out;
}
