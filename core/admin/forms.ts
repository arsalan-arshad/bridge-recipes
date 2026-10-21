// Strict parsing of application/x-www-form-urlencoded bodies. Duplicate keys, oversized bodies and absurd field counts are rejected.

export class FormError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FormError';
    this.status = status;
  }
}

export const MAX_FORM_BYTES = 64 * 1024;
const MAX_FIELDS = 60;

export function parseForm(body: string): Map<string, string> {
  const out = new Map<string, string>();
  if (body === '') return out;
  const pairs = body.split('&');
  if (pairs.length > MAX_FIELDS) throw new FormError('too many fields');
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    const rawK = i === -1 ? pair : pair.slice(0, i);
    const rawV = i === -1 ? '' : pair.slice(i + 1);
    let k: string;
    let v: string;
    try {
      k = decodeURIComponent(rawK.replace(/\+/g, ' '));
      v = decodeURIComponent(rawV.replace(/\+/g, ' '));
    } catch {
      throw new FormError('malformed encoding');
    }
    if (k === '') continue;
    if (out.has(k)) throw new FormError('duplicate field');
    out.set(k, v);
  }
  return out;
}
