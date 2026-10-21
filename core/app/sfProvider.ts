// Builds a SalesforceClient per shop from the ENCRYPTED connection store. Clients are cached briefly so token and limit state
// are reused, while a changed connection takes effect within the TTL. No stored connection = a retryable, logged error
// (the owner can add one), never a crash and never a guess.

import { SalesforceClient, SalesforceError } from '../salesforce/client.ts';
import type { ConnectionStore } from '../salesforce/connectionStore.ts';
import type { FetchLike } from '../salesforce/client.ts';

export function createSalesforceProvider(opts: {
  connections: ConnectionStore;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  maxUsageRatio?: number;
}): (shop: string) => Promise<SalesforceClient> {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? 60_000;
  const cache = new Map<string, { client: SalesforceClient; at: number }>();
  return async (shop) => {
    const hit = cache.get(shop);
    if (hit && now() - hit.at < ttl) return hit.client;
    const conn = await opts.connections.get(shop);
    if (!conn) throw new SalesforceError('auth', 0, 'NO_CONNECTION', 'no Salesforce connection is stored for this shop');
    const client = new SalesforceClient({
      loginUrl: conn.loginUrl, clientId: conn.clientId, clientSecret: conn.clientSecret,
      fetch: opts.fetch, maxUsageRatio: opts.maxUsageRatio ?? 0.9,
    });
    cache.set(shop, { client, at: now() });
    return client;
  };
}
