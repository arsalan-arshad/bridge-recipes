// Parser for the Sforce-Limit-Info response header, e.g. "api-usage=10018/100000" or
// "api-usage=10018/100000; api-bursts=1/750". Tolerant: unknown keys and bad parts are ignored.
// Source: https://developer.salesforce.com/docs/platform/api-rest/guide/headers-api-usage.html

export interface LimitUsage {
  used: number;
  max: number;
}

export function parseLimitInfo(header: string | null | undefined): Record<string, LimitUsage> {
  const out: Record<string, LimitUsage> = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const m = /^\s*([A-Za-z][\w-]*)\s*=\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(part);
    if (m) out[m[1].toLowerCase()] = { used: Number(m[2]), max: Number(m[3]) };
  }
  return out;
}

// Fraction of the daily API allowance used, or null when the header has no api-usage part.
export function apiUsageRatio(header: string | null | undefined): number | null {
  const usage = parseLimitInfo(header)['api-usage'];
  if (!usage || usage.max === 0) return null;
  return usage.used / usage.max;
}
