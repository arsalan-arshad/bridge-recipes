// AES-256-GCM for secrets at rest (docs/SPEC.md section 8). Format: "v1:<iv>:<tag>:<ciphertext>" (base64url parts).
// - key: 32 bytes, given as 64 hex chars (generate with: openssl rand -hex 32), held only in the environment
// - fresh random 12-byte IV per encryption
// - `context` is authenticated (GCM AAD): a ciphertext copied to another shop/row/purpose fails to decrypt
// - errors never contain the plaintext, the key or the ciphertext
// Not done yet: key rotation (the "v1" prefix is where a key id would go).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export function parseKey(hex: string | undefined): Buffer {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CryptoError('ENCRYPTION_KEY must be 64 hex characters (32 bytes); generate one with: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

const b64 = (b: Buffer) => b.toString('base64url');

export function encrypt(plaintext: string, key: Buffer, context: string): string {
  if (key.length !== 32) throw new CryptoError('key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
}

export function decrypt(sealed: string, key: Buffer, context: string): string {
  if (key.length !== 32) throw new CryptoError('key must be 32 bytes');
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new CryptoError('unrecognised ciphertext format');
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('bad lengths');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong context, or tampered data all look the same on purpose.
    throw new CryptoError('decryption failed (wrong key, wrong context, or the data was altered)');
  }
}
