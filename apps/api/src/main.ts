// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createPhiCipher, KnowledgeRepository, LISTEN_DOWN_ALERT_MS, logConnectionRole, pgChangeFeed, serviceDatabaseUrl } from '@attendra/db';
import { HybridKnowledgeBase, LocalAnswerer, ModelAnswerer } from '@attendra/knowledge';
import { createAlerter, createLogger } from '@attendra/observability';
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
const alerts = createAlerter({ webhookUrl: env.ATTENDRA_SLACK_WEBHOOK_URL, service: 'api', log });
if (env.ATTENDRA_DEMO_MODE) log.warn({}, 'demo mode: two-factor is not required. Do not use with real patient data.');

// queries (and sign-in) on the services' role when given (migration 0051); pg-boss on the owner's URL
const db = connect(serviceDatabaseUrl(env), { onError: (code) => log.error({ code }, 'database connection error') });
await logConnectionRole(db, log, !!env.ATTENDRA_SERVICE_DATABASE_URL);
// sends jobs only (document indexing); the worker runs them
const boss = createBoss({ connectionString: env.DATABASE_URL }, { producer: true });
boss.on('error', (err) => log.error({ err: { message: err.message } }, 'job queue error'));
await boss.start();
const embedder = embedderFromEnv(env);
const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;
const answerer = openai ? new ModelAnswerer(openai, env.ATTENDRA_BACKEND_MODEL) : new LocalAnswerer();
// the greeting in a voice, for Settings' Listen button
const voiceSamples = openai ? openAiVoiceSampler(openai, env.ATTENDRA_TTS_MODEL) : null;
// "forgot password" and Team invitation emails go out through the hosting layer, which holds the mailer
const mail = env.ATTENDRA_MAIL_HOOK_URL && env.ATTENDRA_PROVISIONING_TOKEN ? mailHook(env.ATTENDRA_MAIL_HOOK_URL, env.ATTENDRA_PROVISIONING_TOKEN, log) : null;
const app = await createApi({
  db,
  cipher: createPhiCipher(env.ATTENDRA_DATA_KEY),
  auth: createAuth(db, { publicUrl: env.PUBLIC_URL, secret: env.BETTER_AUTH_SECRET, log, passwordReset: mail ?? undefined }),
  log,
  options: { publicUrl: env.PUBLIC_URL, demoMode: env.ATTENDRA_DEMO_MODE, accountLinks: env.ATTENDRA_ACCOUNT_LINKS, mcpUrl: env.ATTENDRA_MCP_URL, twoFactor: env.ATTENDRA_TWO_FACTOR, idleMinutes: env.ATTENDRA_IDLE_MINUTES, searchScan: env.ATTENDRA_SEARCH_SCAN, provisioningToken: env.ATTENDRA_PROVISIONING_TOKEN, passwordReset: !!mail },
  trustProxy: env.TRUST_PROXY,
  voice: env.VOICE_URL && env.VOICE_INTERNAL_TOKEN ? httpVoiceClient(env.VOICE_URL, env.VOICE_INTERNAL_TOKEN) : null,
  jobs: bossQueue(boss),
  changes: pgChangeFeed(serviceDatabaseUrl(env), {
    onError: (code) => log.warn({ code }, 'change notices: connection error'),
    // no screen hears of a change until it is back; then every open screen reads again
    onDown: () => alerts.alert('change_notices_down', `the API has not heard database change notices for over ${LISTEN_DOWN_ALERT_MS / 1000} s; open screens refresh only on their slow safety check until it is back.`),
    onUp: (ms) => alerts.note(`change notices back after ${Math.round(ms / 1000)} s; every open screen was told to read again.`),
  }),
  knowledge: { base: new HybridKnowledgeBase(new KnowledgeRepository(db), embedder), answerer, embeddingModel: embedder.model },
  voiceSamples,
  mail,
});

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
log.info({ port: env.API_PORT }, 'api listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void app.close().then(() => boss.stop({ graceful: true })).then(() => process.exit(0)); });
}
