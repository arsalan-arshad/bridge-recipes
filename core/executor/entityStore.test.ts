import { defineEntityStoreContract } from './entityStoreContract.ts';
import { MemoryEntityStore } from './entityStore.ts';

defineEntityStoreContract('MemoryEntityStore', async () => ({ store: new MemoryEntityStore() }));
