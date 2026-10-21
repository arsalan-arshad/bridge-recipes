// Shopify webhook HMAC check. Run on the RAW body before any parsing.
// Header: X-Shopify-Hmac-SHA256 = base64(HMAC-SHA256(rawBody, appClientSecret)).
// Source: https://shopify.dev/docs/apps/build/webhooks/subscribe/https (see docs/research/R1_PLATFORM_FACTS.md).

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyShopifyHmac(
  rawBody: Buffer | string,
  headerValue: string | undefined | null,
  secret: string,
): boolean {
  if (typeof headerValue !== 'string' || headerValue === '' || secret === '') return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(headerValue, 'base64');
  // timingSafeEqual throws on unequal lengths, so compare lengths first.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
