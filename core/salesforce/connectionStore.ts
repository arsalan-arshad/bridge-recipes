// One Salesforce connection per shop (docs/SPEC.md section 5). The client secret is encrypted at rest; the plaintext exists
// only in memory, only while a SalesforceClient is built from it.

export interface SalesforceConnection {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface ConnectionStore {
  get(shop: string): Promise<SalesforceConnection | null>;
  put(shop: string, conn: SalesforceConnection): Promise<void>;
  markVerified(shop: string, at: Date): Promise<void>;
}

export class MemoryConnectionStore implements ConnectionStore {
  private readonly m = new Map<string, SalesforceConnection & { verifiedAt?: Date }>();
  async get(shop: string) {
    const c = this.m.get(shop);
    return c ? { loginUrl: c.loginUrl, clientId: c.clientId, clientSecret: c.clientSecret } : null;
  }
  async put(shop: string, conn: SalesforceConnection) {
    this.m.set(shop, { ...conn });
  }
  async markVerified(shop: string, at: Date) {
    const c = this.m.get(shop);
    if (c) c.verifiedAt = at;
  }
  async info(shop: string): Promise<{ stored: boolean; loginUrl?: string; clientId?: string; lastVerifiedAt: string | null }> {
    const c = this.m.get(shop);
    return c ? { stored: true, loginUrl: c.loginUrl, clientId: c.clientId, lastVerifiedAt: c.verifiedAt ? c.verifiedAt.toISOString() : null } : { stored: false, lastVerifiedAt: null };
  }
}
