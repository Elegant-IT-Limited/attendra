// SPDX-License-Identifier: AGPL-3.0-only
import { ResponsesPlanner } from '@attendra/agent';
import {
  CallRepository, claimDelivery, clinicById, clinicForNumber, type Database, type PhiCipher,
  PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue,
} from '@attendra/db';
import type { Logger } from '@attendra/observability';
import { type JobQueue, noJobs } from '@attendra/worker/queue';
import { BuiltinScheduler } from '@attendra/scheduling';
import { type SmsSender, twilioSender, TwilioMessenger } from '@attendra/telephony';
import { GptLiveEngine, SimulatedEngine } from '@attendra/voice-engine';
import OpenAI from 'openai';
import twilio from 'twilio';
import { buildServer, type IncomingCall, type VoiceDeps } from './server';
import { simulatedCallFor } from './simulated-calls';

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
  /** Where a closed call is announced, so the worker summarises it. */
  jobs?: JobQueue;
  /** Scripted calls with no audio and no model, started from the dashboard. The local demo turns them on. */
  simulatedCalls?: boolean;
}

const noSms: SmsSender = { send: async () => { throw new Error('SMS is not configured'); } };

/** The voice service wired to Postgres, OpenAI and Twilio. main.ts and the local demo both use it. */
export function createVoiceApp(rt: VoiceRuntime) {
  const openai = new OpenAI({ apiKey: rt.openaiApiKey, webhookSecret: rt.webhookSecret ?? null });
  return buildServer(wire(rt, {
    verifyWebhook: async (raw, headers) => (await openai.webhooks.unwrap(raw, headers as Record<string, string>)) as unknown as IncomingCall,
    engine: new GptLiveEngine(openai, rt.liveModel),
    planner: new ResponsesPlanner(openai, rt.backendModel),
  }));
}

/**
 * The voice service with no OpenAI at all: only simulated calls, for the local demo
 * without a key and for the e2e suite. It takes no phone or browser calls.
 */
export function createSimulatedVoiceApp(rt: Omit<VoiceRuntime, 'openaiApiKey' | 'webhookSecret' | 'liveModel' | 'backendModel' | 'simulatedCalls'>) {
  const engine = new SimulatedEngine();
  return buildServer(wire({ ...rt, simulatedCalls: false }, {
    verifyWebhook: async () => { throw new Error('this voice service takes no phone calls'); },
    engine,
    planner: { plan: async () => ({ say: null }) },
  }, engine));
}

function wire(rt: Omit<VoiceRuntime, 'openaiApiKey' | 'liveModel' | 'backendModel'>, parts: Pick<VoiceDeps, 'verifyWebhook' | 'engine' | 'planner'>, simulated?: SimulatedEngine): VoiceDeps {
  const { db, cipher } = rt;
  const calls = new CallRepository(db, cipher);
  const clinicNumbers = new Map<string, string>();
  // texts go out from the clinic's main number, whichever line was dialled
  const remember = (config: unknown) => {
    if (config) clinicNumbers.set((config as { id: string }).id, (config as { phoneNumbers: string[] }).phoneNumbers[0]!);
    return config;
  };
  const sim = simulated ?? (rt.simulatedCalls ? new SimulatedEngine() : null);

  return {
    ...parts,
    claimDelivery: (id) => claimDelivery(db, id, 'openai'),
    clinicForNumber: async (e164) => remember(await clinicForNumber(db, e164)),
    clinicById: async (id) => remember(await clinicById(db, id)),
    openCall: (clinicId, sessionId, from, channel, startedBy) => calls.open(clinicId, sessionId, from, channel, startedBy),
    actionsFor: (clinicId, callId) => ({
      record: (a) => calls.recordAction(clinicId, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, idempotencyKey: null, taskRevision: a.revision, patientId: a.patientId }),
    }),
    recorderFor: (clinicId, callId) => ({
      appendSegment: (s) => calls.appendSegment(clinicId, callId, s),
      close: async (c) => {
        await calls.close(clinicId, callId, c);
        // the call record stands whatever happens to the queue; the summary can be redone
        await (rt.jobs ?? noJobs).callCompleted({ clinicId, callId }).catch((err: unknown) =>
          rt.log.warn({ call_id: callId, err: { message: (err as Error).message } }, 'could not queue the closed call for the worker'));
      },
    }),
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
    simulator: sim ? { engine: sim, callFor: simulatedCallFor } : undefined,
  };
}
