// SPDX-License-Identifier: AGPL-3.0-only
import { ResponsesPlanner } from '@attendra/agent';
import {
  CallRepository, claimDelivery, clinicById, clinicForNumber, type Database, type PhiCipher,
  PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue,
} from '@attendra/db';
import type { Logger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import { type SmsSender, twilioSender, TwilioMessenger } from '@attendra/telephony';
import { GptLiveEngine } from '@attendra/voice-engine';
import OpenAI from 'openai';
import twilio from 'twilio';
import { buildServer, type IncomingCall } from './server';

export interface VoiceRuntime {
  db: Database;
  cipher: PhiCipher;
  openaiApiKey: string;
  /** Phone calls arrive as signed webhooks; without the secret every delivery is refused. */
  webhookSecret?: string;
  log: Logger;
  liveModel: string;
  backendModel: string;
  /** Without it, texts are recorded as not sent and the call carries on. */
  twilio?: { accountSid: string; authToken: string };
  internalToken?: string;
  browserCallMaxSeconds?: number;
}

const noSms: SmsSender = { send: async () => { throw new Error('SMS is not configured'); } };

/** The voice service wired to Postgres, OpenAI and Twilio. main.ts and the local demo both use it. */
export function createVoiceApp(rt: VoiceRuntime) {
  const { db, cipher } = rt;
  const openai = new OpenAI({ apiKey: rt.openaiApiKey, webhookSecret: rt.webhookSecret ?? null });
  const calls = new CallRepository(db, cipher);
  const clinicNumbers = new Map<string, string>();
  // texts go out from the clinic's main number, whichever line was dialled
  const remember = (config: unknown) => {
    if (config) clinicNumbers.set((config as { id: string }).id, (config as { phoneNumbers: string[] }).phoneNumbers[0]!);
    return config;
  };

  return buildServer({
    verifyWebhook: async (raw, headers) => (await openai.webhooks.unwrap(raw, headers as Record<string, string>)) as unknown as IncomingCall,
    claimDelivery: (id) => claimDelivery(db, id, 'openai'),
    clinicForNumber: async (e164) => remember(await clinicForNumber(db, e164)),
    clinicById: async (id) => remember(await clinicById(db, id)),
    openCall: (clinicId, sessionId, from, channel, startedBy) => calls.open(clinicId, sessionId, from, channel, startedBy),
    actionsFor: (clinicId, callId) => ({
      record: (a) => calls.recordAction(clinicId, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, idempotencyKey: null, taskRevision: a.revision }),
    }),
    recorderFor: (clinicId, callId) => ({
      appendSegment: (s) => calls.appendSegment(clinicId, callId, s),
      close: (c) => calls.close(clinicId, callId, c),
    }),
    engine: new GptLiveEngine(openai, rt.liveModel),
    planner: new ResponsesPlanner(openai, rt.backendModel),
    backend: {
      patients: new PostgresPatientDirectory(db, cipher),
      scheduler: new BuiltinScheduler(db),
      tasks: new PostgresTaskQueue(db, cipher),
      audit: new PostgresAuditLog(db),
      messenger: new TwilioMessenger(db, cipher, rt.twilio ? twilioSender(twilio(rt.twilio.accountSid, rt.twilio.authToken)) : noSms, (clinicId) => {
        const from = clinicNumbers.get(clinicId);
        if (!from) throw new Error(`no sending number known for clinic ${clinicId}`);
        return from;
      }),
    },
    log: rt.log,
    internalToken: rt.internalToken,
    browserCallMaxSeconds: rt.browserCallMaxSeconds,
  });
}
