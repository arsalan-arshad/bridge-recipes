// Structured one-line JSON logger for the running service. Nothing sensitive can be logged by accident:
// values under keys that look like secrets or payloads are replaced, and email addresses in strings are masked.

import { scrubEmails } from '../queue/postgresSyncLog.ts';

export type Level = 'info' | 'warn' | 'error';
export type Fields = Record<string, string | number | boolean | null | undefined>;
export type Logger = (level: Level, event: string, fields?: Fields) => void;

const SENSITIVE_KEY = /secret|token|password|passwd|authorization|credential|payload|body|email|encryption|api_?key|private/i;

export function sanitizeFields(fields: Fields = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SENSITIVE_KEY.test(k)) out[k] = '[redacted]';
    else out[k] = typeof v === 'string' ? scrubEmails(v).slice(0, 500) : v;
  }
  return out;
}

export function makeLogger(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`), now: () => Date = () => new Date()): Logger {
  return (level, event, fields) => write(JSON.stringify({ t: now().toISOString(), level, event, ...sanitizeFields(fields) }));
}
