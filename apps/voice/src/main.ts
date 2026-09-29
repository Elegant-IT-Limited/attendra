// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createPhiCipher } from '@attendra/db';
import { createLogger } from '@attendra/observability';
import { loadEnv } from './config';
import { createVoiceApp } from './runtime';

const env = loadEnv();
const log = createLogger({ name: 'voice', level: env.LOG_LEVEL });
const app = createVoiceApp({
  db: connect(env.DATABASE_URL),
  cipher: createPhiCipher(env.ATTENDRA_DATA_KEY),
  openaiApiKey: env.OPENAI_API_KEY,
  webhookSecret: env.OPENAI_WEBHOOK_SECRET,
  log,
  liveModel: env.GPT_LIVE_MODEL,
  backendModel: env.ATTENDRA_BACKEND_MODEL,
  twilio: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN } : undefined,
  internalToken: env.VOICE_INTERNAL_TOKEN,
  browserCallMaxSeconds: env.BROWSER_CALL_MAX_SECONDS,
});

await app.listen({ port: env.PORT, host: '0.0.0.0' });
log.info({ port: env.PORT, phone: !!env.OPENAI_WEBHOOK_SECRET, sms: !!env.TWILIO_ACCOUNT_SID, browser: !!env.VOICE_INTERNAL_TOKEN }, 'voice service listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // let in-progress calls finish writing before the process exits
  process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
