// Operator commands until the admin UI exists (M3). Never prints a secret.
//
//   node --env-file=.env scripts/admin.ts connect <shop>        store the Salesforce connection (reads SF_LOGIN_URL, SF_CLIENT_ID,
//                                                               SF_CLIENT_SECRET from the environment; the secret is stored ENCRYPTED)
//   node --env-file=.env scripts/admin.ts verify <shop>         prove the stored connection works (one read-only query)
//   node --env-file=.env scripts/admin.ts enable <shop> [--live] [--config file.json]
//                                                               enable R1 for the shop: DRY-RUN unless --live is given
//   node --env-file=.env scripts/admin.ts disable <shop>        the kill switch: zero Salesforce calls from the next job on
//   node --env-file=.env scripts/admin.ts status <shop>         connection, recipe mode and outcome counts
// Needs DATABASE_URL and ENCRYPTION_KEY (and optionally BRIDGE_SCHEMA) in the environment.

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { AdminError, connectShop, loadStoreEnv, setRecipe, shopStatus, verifyShop } from '../core/app/admin.ts';
import { PostgresConnectionStore } from '../core/queue/postgresConnectionStore.ts';
import { PostgresConfigStore } from '../core/queue/postgresConfigStore.ts';
import { PostgresSyncLog } from '../core/queue/postgresSyncLog.ts';
import { migrate } from '../core/queue/migrate.ts';
import { R1_DEFAULT_CONFIG, R1_ID } from '../recipes/retail-b2b-lead-spotter/recipe.ts';
import { validateR1Config } from '../recipes/retail-b2b-lead-spotter/validateConfig.ts';

const [cmd, shop, ...rest] = process.argv.slice(2);
if (!cmd || !shop || !['connect', 'verify', 'enable', 'disable', 'status'].includes(cmd)) {
  console.log('usage: admin.ts connect|verify|enable|disable|status <shop.myshopify.com> [--live] [--config file.json]');
  process.exit(1);
}

let pool: pg.Pool | undefined;
try {
  const env = loadStoreEnv();
  pool = new pg.Pool({ connectionString: env.databaseUrl, max: 2 });
  await migrate(pool, env.schema);
  const connections = new PostgresConnectionStore(pool, env.schema, env.encryptionKey);
  const configs = new PostgresConfigStore(pool, env.schema, { [R1_ID]: validateR1Config });
  const syncLog = new PostgresSyncLog(pool, env.schema);

  if (cmd === 'connect') {
    await connectShop(connections, shop, { loginUrl: process.env.SF_LOGIN_URL ?? '', clientId: process.env.SF_CLIENT_ID ?? '', clientSecret: process.env.SF_CLIENT_SECRET ?? '' });
    console.log(`stored the Salesforce connection for ${shop} (secret encrypted). Next: verify ${shop}`);
  } else if (cmd === 'verify') {
    const r = await verifyShop(connections, shop);
    console.log(r.ok ? `connection for ${shop} works` : `connection check failed: ${r.reason}`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'enable') {
    const i = rest.indexOf('--config');
    const config = i === -1 ? R1_DEFAULT_CONFIG : JSON.parse(readFileSync(rest[i + 1], 'utf8'));
    const live = rest.includes('--live');
    await setRecipe(configs, shop, R1_ID, { enable: true, live, config });
    console.log(`R1 enabled for ${shop} in ${live ? 'LIVE mode (writes to Salesforce)' : 'DRY-RUN mode (nothing is written)'}`);
  } else if (cmd === 'disable') {
    await setRecipe(configs, shop, R1_ID, { enable: false, config: null });
    console.log(`R1 disabled for ${shop} (kill switch): no Salesforce calls from the next job on`);
  } else {
    console.log(JSON.stringify(await shopStatus({ connections, configs, syncLog, pool, schema: env.schema }, shop, R1_ID), null, 2));
  }
} catch (e) {
  console.log(e instanceof AdminError ? e.message : `failed: ${e instanceof Error ? e.constructor.name : 'error'}`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
