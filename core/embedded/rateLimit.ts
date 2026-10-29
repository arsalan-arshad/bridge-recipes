// A fixed-window counter per key (a shop). In memory, so each process counts alone; that is enough to stop one store from hammering
// Salesforce or the database through the embedded page. The clock is passed in so it is testable.

export interface WindowLimiter {
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
}

export function createWindowLimiter(o: { limit: number; windowMs: number; now: () => number; maxKeys?: number }): WindowLimiter {
  const hits = new Map<string, { start: number; n: number }>();
  const maxKeys = o.maxKeys ?? 5000;
  return {
    take(key) {
      const t = o.now();
      const cur = hits.get(key);
      if (!cur || t - cur.start >= o.windowMs) {
        if (hits.size >= maxKeys) for (const [k, v] of hits) if (t - v.start >= o.windowMs) hits.delete(k); // forget expired windows
        if (hits.size >= maxKeys) return { ok: false, retryAfterSeconds: Math.ceil(o.windowMs / 1000) }; // a full table refuses rather than grows
        hits.set(key, { start: t, n: 1 });
        return { ok: true };
      }
      if (cur.n >= o.limit) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cur.start + o.windowMs - t) / 1000)) };
      cur.n += 1;
      return { ok: true };
    },
  };
}
