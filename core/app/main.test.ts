// The real entrypoint (`node core/app/main.ts`) as a separate OS process. Skipped without DATABASE_URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';

const URL = process.env.DATABASE_URL ?? '';
const skip = URL === '' ? 'DATABASE_URL not set' : false;
const ROOT = join(import.meta.dirname, '..', '..');
const SIGNING = 'main-test-signing-secret';

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, ['core/app/main.ts'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env } });
  const lines: string[] = [];
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const waitFor = async (event: string, ms = 20_000) => {
    for (let t = 0; t < ms; t += 100) {
      const hit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.event === event);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${event}`);
  };
  return { child, lines, exited, waitFor };
}

test('a missing or invalid environment fails fast (exit 1): variable NAMES are reported, values never are', async () => {
  const secretish = 'SECRET-LOOKING-GARBAGE-VALUE';
  const p = run({ DATABASE_URL: secretish, ENCRYPTION_KEY: secretish });
  const code = await p.exited;
  assert.equal(code, 1);
  const text = p.lines.join('\n');
  const evt = JSON.parse(p.lines[0]);
  assert.equal(evt.event, 'config_invalid');
  for (const name of ['DATABASE_URL', 'ENCRYPTION_KEY', 'SHOPIFY_WEBHOOK_SECRET']) assert.ok(text.includes(name), name);
  assert.ok(!text.includes(secretish));
});

test('starts, serves health, and exits 0 on SIGTERM after a graceful stop', { skip, timeout: 60_000 }, async () => {
  const schema = `bridge_t_${randomBytes(4).toString('hex')}`;
  const p = run({ DATABASE_URL: URL, SHOPIFY_WEBHOOK_SECRET: SIGNING, ENCRYPTION_KEY: randomBytes(32).toString('hex'), BRIDGE_SCHEMA: schema, HOST: '127.0.0.1', PORT: '0' });
  try {
    const started = await p.waitFor('started');
    const base = `http://127.0.0.1:${started.port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    assert.equal((await fetch(`${base}/webhooks/shopify`, { method: 'POST', body: '{}' })).status, 401, 'unsigned webhook refused');
    p.child.kill('SIGTERM');
    assert.equal(await p.exited, 0);
    const events = p.lines.map((l) => JSON.parse(l).event);
    assert.deepEqual(events.filter((e) => ['started', 'signal', 'stopping', 'stopped'].includes(e)), ['started', 'signal', 'stopping', 'stopped']);
    await assert.rejects(() => fetch(`${base}/healthz`), 'port closed after exit');
    const text = p.lines.join('\n');
    for (const leak of [SIGNING, URL]) assert.ok(!text.includes(leak), 'no secret or connection string in the logs');
  } finally {
    p.child.kill('SIGKILL');
    const db = new pg.Pool({ connectionString: URL, max: 1 });
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  }
});

test('a database that cannot be reached exits 1 with start_failed and without echoing the connection string', { timeout: 60_000 }, async () => {
  const bad = 'postgresql://nobody:hunter2-password@127.0.0.1:1/nope';
  const p = run({ DATABASE_URL: bad, SHOPIFY_WEBHOOK_SECRET: SIGNING, ENCRYPTION_KEY: randomBytes(32).toString('hex'), PORT: '0', HOST: '127.0.0.1' });
  assert.equal(await p.exited, 1);
  const text = p.lines.join('\n');
  assert.ok(text.includes('start_failed'));
  for (const leak of ['hunter2', 'nobody', '127.0.0.1:1']) assert.ok(!text.includes(leak), leak);
});
