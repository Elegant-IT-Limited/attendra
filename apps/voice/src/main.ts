// SPDX-License-Identifier: AGPL-3.0-only
import { ResponsesPlanner } from '@attendra/agent';
import {
  CallRepository, claimDelivery, clinicForNumber, connect, createPhiCipher,
  PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue,
} from '@attendra/db';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import { twilioSender, TwilioMessenger } from '@attendra/telephony';
import { GptLiveEngine } from '@attendra/voice-engine';
import OpenAI from 'openai';
import twilio from 'twilio';
import { loadEnv } from './config';
import { buildServer, type IncomingCall } from './server';

const env = loadEnv();
const log = createLogger({ name: 'voice', level: env.LOG_LEVEL });
const db = connect(env.DATABASE_URL);
const cipher = createPhiCipher(env.ATTENDRA_DATA_KEY);
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, webhookSecret: env.OPENAI_WEBHOOK_SECRET });
const calls = new CallRepository(db, cipher);
const clinicNumbers = new Map<string, string>();

const app = buildServer({
  verifyWebhook: async (raw, headers) => (await openai.webhooks.unwrap(raw, headers as Record<string, string>)) as unknown as IncomingCall,
  claimDelivery: (id) => claimDelivery(db, id, 'openai'),
  clinicForNumber: async (e164) => {
    const config = await clinicForNumber(db, e164);
    // texts go out from the clinic's main number, whichever line was dialled
    if (config) clinicNumbers.set((config as { id: string }).id, (config as { phoneNumbers: string[] }).phoneNumbers[0]!);
    return config;
  },
  openCall: (clinicId, sessionId, from) => calls.open(clinicId, sessionId, from),
  actionsFor: (clinicId, callId) => ({
    record: (a) => calls.recordAction(clinicId, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, idempotencyKey: null, taskRevision: a.revision }),
  }),
  recorderFor: (clinicId, callId) => ({
    appendSegment: (s) => calls.appendSegment(clinicId, callId, s),
    close: (c) => calls.close(clinicId, callId, c),
  }),
  engine: new GptLiveEngine(openai, env.GPT_LIVE_MODEL),
  planner: new ResponsesPlanner(openai, env.ATTENDRA_BACKEND_MODEL),
  backend: {
    patients: new PostgresPatientDirectory(db, cipher),
    scheduler: new BuiltinScheduler(db),
    tasks: new PostgresTaskQueue(db, cipher),
    audit: new PostgresAuditLog(db),
        messenger: new TwilioMessenger(db, cipher, twilioSender(twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)), (clinicId) => {
      const from = clinicNumbers.get(clinicId);
      if (!from) throw new Error(`no sending number known for clinic ${clinicId}`);
      return from;
    }),
  },
  log,
});

await app.listen({ port: env.PORT, host: '0.0.0.0' });
log.info({ port: env.PORT }, 'voice service listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // let in-progress calls finish writing before the process exits
  process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
