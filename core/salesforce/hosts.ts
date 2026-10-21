// Which hosts this app will send Salesforce credentials and API calls to. Anything else is refused (no SSRF through an
// operator-supplied login URL, no client secret sent to a look-alike host). Loopback over http is allowed for local tests only.
const SALESFORCE_HOST = /^([a-z0-9-]+\.)+(my\.salesforce\.com|my\.salesforce-setup\.com|salesforce\.com|force\.com|salesforce-setup\.com)$/i;

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function isAllowedSalesforceUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password) return false;
  if (isLoopback(u.hostname)) return u.protocol === 'http:' || u.protocol === 'https:';
  return u.protocol === 'https:' && u.port === '' && SALESFORCE_HOST.test(u.hostname);
}
