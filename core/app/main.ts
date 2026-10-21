// Process entrypoint: `npm start`. Reads the environment (names only in errors), starts the app, handles SIGTERM/SIGINT.
// A second signal during shutdown forces an immediate exit.

import { ConfigError, loadEnv } from './env.ts';
import { createApp } from './app.ts';
import { makeLogger } from './logger.ts';

const log = makeLogger();

let config;
try {
  config = loadEnv();
} catch (e) {
  if (e instanceof ConfigError) log('error', 'config_invalid', { problems: e.problems.join('; ') });
  else log('error', 'config_failed');
  process.exit(1);
}

let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp(config, { log });
} catch {
  // The cause is not printed: connection errors can echo the database URL.
  log('error', 'start_failed');
  process.exit(1);
}

let signals = 0;
const shutdown = (signal: string) => {
  signals++;
  if (signals > 1) {
    log('warn', 'forced_exit', { signal });
    process.exit(1);
  }
  log('info', 'signal', { signal });
  app.stop().then(() => process.exit(0), () => process.exit(1));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
