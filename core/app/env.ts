// Environment loading for the running service. Names only in errors: a value is never echoed (it may be a secret).

import { parseKey, CryptoError } from '../crypto/secretBox.ts';
import { assertSchemaName } from '../queue/migrate.ts';
import { DEFAULT_RETENTION } from '../queue/retention.ts';
import type { RetentionPolicy } from '../queue/retention.ts';

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface AppConfig {
  databaseUrl: string;
  schema: string;
  webhookSecret: string;
  encryptionKey: Buffer;
  host: string;
  port: number;
  retention: RetentionPolicy;
  purgeEveryMinutes: number;
  pollingSeconds: number;
  shutdownTimeoutMs: number;
  trustProxy: boolean; // TRUSTED_PROXY=true: a reverse proxy we control sets X-Forwarded-For/Proto
  adminPassword: string | null; // null = the admin UI is switched off (its routes do not exist)
}

function int(env: Record<string, string | undefined>, name: string, def: number, min: number, max: number, problems: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return def;
  }
  return n;
}

export function loadEnv(env: Record<string, string | undefined> = process.env): AppConfig {
  const problems: string[] = [];
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL must be a postgres:// connection string');

  const webhookSecret = env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_API_SECRET || '';
  if (webhookSecret === '') problems.push('SHOPIFY_WEBHOOK_SECRET (or SHOPIFY_API_SECRET) is required');

  let encryptionKey = Buffer.alloc(0);
  try {
    encryptionKey = parseKey(env.ENCRYPTION_KEY);
  } catch (e) {
    problems.push(e instanceof CryptoError ? 'ENCRYPTION_KEY must be 64 hex characters (generate: openssl rand -hex 32)' : 'ENCRYPTION_KEY is invalid');
  }

  let schema = env.BRIDGE_SCHEMA || 'bridge';
  try {
    assertSchemaName(schema);
  } catch {
    problems.push('BRIDGE_SCHEMA must be lower-case letters, digits and underscores');
    schema = 'bridge';
  }

  const retention: RetentionPolicy = {
    syncLogDays: int(env, 'RETENTION_SYNC_LOG_DAYS', DEFAULT_RETENTION.syncLogDays, 1, 3650, problems),
    intakeDays: int(env, 'RETENTION_INTAKE_DAYS', DEFAULT_RETENTION.intakeDays, 1, 3650, problems),
    entityMapDays: int(env, 'RETENTION_ENTITY_MAP_DAYS', DEFAULT_RETENTION.entityMapDays, 1, 3650, problems),
    complianceDays: int(env, 'RETENTION_COMPLIANCE_DAYS', DEFAULT_RETENTION.complianceDays, 1, 3650, problems),
  };
  const adminPassword = env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD : null;
  if (adminPassword !== null && adminPassword.length < 12) problems.push('ADMIN_PASSWORD must be at least 12 characters (or unset it to switch the admin UI off)');
  const config: AppConfig = {
    databaseUrl, schema, webhookSecret, encryptionKey,
    host: env.HOST || '0.0.0.0',
    port: int(env, 'PORT', 8787, 0, 65535, problems),
    retention,
    purgeEveryMinutes: int(env, 'PURGE_EVERY_MINUTES', 360, 1, 10080, problems),
    pollingSeconds: int(env, 'WORKER_POLL_SECONDS', 2, 1, 60, problems),
    shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_SECONDS', 20, 1, 300, problems) * 1000,
    adminPassword,
    trustProxy: /^(1|true|yes)$/i.test(env.TRUSTED_PROXY ?? ''),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
