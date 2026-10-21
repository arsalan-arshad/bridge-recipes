// The EntityStore contract every implementation must satisfy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EntityStore } from './entityStore.ts';

export function defineEntityStoreContract(label: string, make: () => Promise<{ store: EntityStore; close?: () => Promise<void> }>) {
  const run = (name: string, fn: (s: EntityStore) => Promise<void>) =>
    test(`${label}: ${name}`, async () => {
      const f = await make();
      try {
        await fn(f.store);
      } finally {
        await f.close?.();
      }
    });
  run('unknown key -> null', async (s) => assert.equal(await s.get('r1:nope'), null));
  run('put then get returns the record', async (s) => {
    await s.put('r1:1', { type: 'Lead', id: '00Qaaaaaaaaaaaa1' }, 's.myshopify.com');
    assert.deepEqual(await s.get('r1:1'), { type: 'Lead', id: '00Qaaaaaaaaaaaa1' });
  });
  run('first write wins; a second put for the same key does not overwrite or throw', async (s) => {
    await s.put('r1:1', { type: 'Lead', id: '00Qaaaaaaaaaaaa1' }, 's.myshopify.com');
    await s.put('r1:1', { type: 'Task', id: '00Taaaaaaaaaaaa2' }, 's.myshopify.com');
    assert.deepEqual(await s.get('r1:1'), { type: 'Lead', id: '00Qaaaaaaaaaaaa1' });
  });
  run('keys are independent', async (s) => {
    await s.put('r1:1', { type: 'Lead', id: '00Qaaaaaaaaaaaa1' }, 's.myshopify.com');
    assert.equal(await s.get('r1:2'), null);
  });
  run('concurrent puts for one key leave exactly one value', async (s) => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => s.put('r1:9', { type: 'Lead', id: `00Q${String(i).padStart(12, '0')}` }, 's.myshopify.com')));
    const v = await s.get('r1:9');
    assert.ok(v && v.type === 'Lead' && /^00Q\d{12}$/.test(v.id));
  });
}
