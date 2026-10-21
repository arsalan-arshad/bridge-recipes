// Log redaction: alice@acme.com -> a***@acme.com. Anything that is not a plain address -> ***.

export function redactEmail(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '***';
  const parts = raw.trim().split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return '***';
  const [local, domain] = parts;
  return `${local[0]}***@${domain.toLowerCase()}`;
}
