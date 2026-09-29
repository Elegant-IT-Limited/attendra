// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createPhiCipher } from '@attendra/db';
import { createLogger } from '@attendra/observability';
import { loadEnv } from './config';
import { createBoss } from './queue';
import { startWorker, summariserFromEnv } from './runtime';

const env = loadEnv();
const log = createLogger({ name: 'worker', level: env.LOG_LEVEL });
const boss = createBoss({ connectionString: env.DATABASE_URL });
// pg-boss reports its own errors (a dropped connection, a failed maintenance run) here; ids only
boss.on('error', (err) => log.error({ err: { message: err.message } }, 'job queue error'));
await boss.start();
const summariser = summariserFromEnv(env);
if (summariser.model === 'local') log.warn('no OPENAI_API_KEY: calls are summarised from their facts, without a model');
await startWorker({ boss, db: connect(env.DATABASE_URL), cipher: createPhiCipher(env.ATTENDRA_DATA_KEY), summariser, log, smsStatus: env.ATTENDRA_SMS_STATUS === 'on' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // finish the jobs in hand, then stop taking new ones
  process.on(signal, () => { void boss.stop({ graceful: true, timeout: 20_000 }).then(() => process.exit(0)); });
}
