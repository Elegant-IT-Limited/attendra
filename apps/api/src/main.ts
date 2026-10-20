// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createPhiCipher, KnowledgeRepository, pgChangeFeed } from '@attendra/db';
import { HybridKnowledgeBase, LocalAnswerer, ModelAnswerer } from '@attendra/knowledge';
import { createLogger } from '@attendra/observability';
import { bossQueue, createBoss } from '@attendra/worker/queue';
import { embedderFromEnv } from '@attendra/worker/runtime';
import OpenAI from 'openai';
import { createApi } from './app';
import { createAuth } from './auth';
import { mailHook } from './mail-hook';
import { loadEnv } from './config';
import { httpVoiceClient } from './voice';
import { openAiVoiceSampler } from './voice-samples/samplers';

const env = loadEnv();
const log = createLogger({ name: 'api', level: env.LOG_LEVEL });
if (env.ATTENDRA_DEMO_MODE) log.warn({}, 'demo mode: two-factor is not required. Do not use with real patient data.');

const db = connect(env.DATABASE_URL, { onError: (code) => log.error({ code }, 'database connection error') });
// sends jobs only (document indexing); the worker runs them
const boss = createBoss({ connectionString: env.DATABASE_URL }, { producer: true });
boss.on('error', (err) => log.error({ err: { message: err.message } }, 'job queue error'));
await boss.start();
const embedder = embedderFromEnv(env);
const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;
const answerer = openai ? new ModelAnswerer(openai, env.ATTENDRA_BACKEND_MODEL) : new LocalAnswerer();
// the greeting in a voice, for Settings' Listen button
const voiceSamples = openai ? openAiVoiceSampler(openai, env.ATTENDRA_TTS_MODEL) : null;
// "forgot password" emails go out through the hosting layer, which holds the mailer
const mail = env.ATTENDRA_MAIL_HOOK_URL && env.ATTENDRA_PROVISIONING_TOKEN ? mailHook(env.ATTENDRA_MAIL_HOOK_URL, env.ATTENDRA_PROVISIONING_TOKEN, log) : null;
const app = await createApi({
  db,
  cipher: createPhiCipher(env.ATTENDRA_DATA_KEY),
  auth: createAuth(db, { publicUrl: env.PUBLIC_URL, secret: env.BETTER_AUTH_SECRET, log, passwordReset: mail ?? undefined }),
  log,
  options: { publicUrl: env.PUBLIC_URL, demoMode: env.ATTENDRA_DEMO_MODE, accountLinks: env.ATTENDRA_ACCOUNT_LINKS, twoFactor: env.ATTENDRA_TWO_FACTOR, provisioningToken: env.ATTENDRA_PROVISIONING_TOKEN, passwordReset: !!mail },
  trustProxy: env.TRUST_PROXY,
  voice: env.VOICE_URL && env.VOICE_INTERNAL_TOKEN ? httpVoiceClient(env.VOICE_URL, env.VOICE_INTERNAL_TOKEN) : null,
  jobs: bossQueue(boss),
  changes: pgChangeFeed(env.DATABASE_URL, (code) => log.warn({ code }, 'change notices: connection error')),
  knowledge: { base: new HybridKnowledgeBase(new KnowledgeRepository(db), embedder), answerer, embeddingModel: embedder.model },
  voiceSamples,
});

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
log.info({ port: env.API_PORT }, 'api listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void app.close().then(() => boss.stop({ graceful: true })).then(() => process.exit(0)); });
}
