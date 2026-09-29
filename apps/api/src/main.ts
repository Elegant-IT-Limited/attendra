// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createPhiCipher } from '@attendra/db';
import { createLogger } from '@attendra/observability';
import { createApi } from './app';
import { createAuth } from './auth';
import { loadEnv } from './config';

const env = loadEnv();
const log = createLogger({ name: 'api', level: env.LOG_LEVEL });
if (env.ATTENDRA_DEMO_MODE) log.warn({}, 'demo mode: two-factor is not required. Do not use with real patient data.');

const db = connect(env.DATABASE_URL);
const app = await createApi({
  db,
  cipher: createPhiCipher(env.ATTENDRA_DATA_KEY),
  auth: createAuth(db, { publicUrl: env.PUBLIC_URL, secret: env.BETTER_AUTH_SECRET, log }),
  log,
  options: { publicUrl: env.PUBLIC_URL, demoMode: env.ATTENDRA_DEMO_MODE },
  trustProxy: env.TRUST_PROXY,
});

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
log.info({ port: env.API_PORT }, 'api listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
