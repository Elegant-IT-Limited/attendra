// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createPhiCipher, KnowledgeRepository } from '@attendra/db';
import { HybridKnowledgeBase } from '@attendra/knowledge';
import { createLogger } from '@attendra/observability';
import { bossQueue, createBoss } from '@attendra/worker/queue';
import { embedderFromEnv } from '@attendra/worker/runtime';
import { loadEnv } from './config';
import { createVoiceApp } from './runtime';

const env = loadEnv();
const log = createLogger({ name: 'voice', level: env.LOG_LEVEL });
// sends jobs only; the worker service runs them
const boss = createBoss({ connectionString: env.DATABASE_URL }, { producer: true });
boss.on('error', (err) => log.error({ err: { message: err.message } }, 'job queue error'));
await boss.start();
const db = connect(env.DATABASE_URL);
const app = createVoiceApp({
  db,
  cipher: createPhiCipher(env.ATTENDRA_DATA_KEY),
  openaiApiKey: env.OPENAI_API_KEY,
  webhookSecret: env.OPENAI_WEBHOOK_SECRET,
  log,
  liveModel: env.GPT_LIVE_MODEL,
  backendModel: env.ATTENDRA_BACKEND_MODEL,
  twilio: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN } : undefined,
  internalToken: env.VOICE_INTERNAL_TOKEN,
  browserCallMaxSeconds: env.BROWSER_CALL_MAX_SECONDS,
  jobs: bossQueue(boss),
  // the same embedding model as the worker indexed with (ATTENDRA_EMBEDDING_MODEL)
  knowledge: new HybridKnowledgeBase(new KnowledgeRepository(db), embedderFromEnv(env)),
});

await app.listen({ port: env.PORT, host: '0.0.0.0' });
log.info({ port: env.PORT, phone: !!env.OPENAI_WEBHOOK_SECRET, sms: !!env.TWILIO_ACCOUNT_SID, browser: !!env.VOICE_INTERNAL_TOKEN }, 'voice service listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // let in-progress calls finish writing before the process exits
  process.on(signal, () => { void app.close().then(() => boss.stop({ graceful: true })).then(() => process.exit(0)); });
}
