// SPDX-License-Identifier: AGPL-3.0-only
import { ResponsesPlanner } from '@attendra/agent';
import {
  CallRepository, claimDelivery, clinicById, clinicForNumber, type Database, type PhiCipher,
  PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue,
} from '@attendra/db';
import { type KnowledgeBase, PACKS, speakSlot } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { eventSink, type JobQueue, noJobs, SMS_STATUSES } from '@attendra/worker/queue';
import { BuiltinScheduler } from '@attendra/scheduling';
import { confirmByReply, recordSmsStanding, smsKeyword, smsStatusUrl, twilioSender, TwilioMessenger } from '@attendra/telephony';
import { EngineRouter, GptLiveEngine, RealtimeEngine, SimulatedEngine } from '@attendra/voice-engine';
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
  /** OpenAI's Realtime model, the second engine; and which engine answers a clinic that has not been given one. */
  realtimeModel?: string;
  defaultEngine?: 'gpt-live' | 'gpt-realtime';
  backendModel: string;
  /** Without it, texts are recorded as not sent and the call carries on. */
  twilio?: { accountSid: string; authToken: string };
  /** This service's public address, which Twilio calls with replies and delivery reports. Without it they are not taken. */
  publicUrl?: string;
  /** Texts one clinic may send in 24 hours. */
  smsDailyCap?: number;
  internalToken?: string;
  browserCallMaxSeconds?: number;
  /** Where a closed call is announced, so the worker summarises it. */
  jobs?: JobQueue;
  /** Scripted calls with no audio and no model, started from the dashboard. The local demo turns them on. */
  simulatedCalls?: boolean;
  /** The clinic's own documents, searched by the assistant. */
  knowledge?: KnowledgeBase;
}

/** The voice service wired to Postgres, OpenAI and Twilio. main.ts and the local demo both use it. */
export function createVoiceApp(rt: VoiceRuntime) {
  const openai = new OpenAI({ apiKey: rt.openaiApiKey, webhookSecret: rt.webhookSecret ?? null });
  return buildServer(wire(rt, {
    verifyWebhook: async (raw, headers) => (await openai.webhooks.unwrap(raw, headers as Record<string, string>)) as unknown as IncomingCall,
    engine: new EngineRouter({ 'gpt-live': new GptLiveEngine(openai, rt.liveModel), 'gpt-realtime': new RealtimeEngine(openai, rt.realtimeModel) }, rt.defaultEngine ?? 'gpt-live'),
    planner: new ResponsesPlanner(openai, rt.backendModel),
  }));
}

/**
 * The voice service with no OpenAI at all: only simulated calls, for the local demo
 * without a key and for the e2e suite. It takes no phone or browser calls.
 */
export function createSimulatedVoiceApp(rt: Omit<VoiceRuntime, 'openaiApiKey' | 'webhookSecret' | 'liveModel' | 'realtimeModel' | 'defaultEngine' | 'backendModel' | 'simulatedCalls'>) {
  const engine = new SimulatedEngine();
  return buildServer(wire({ ...rt, simulatedCalls: false }, {
    verifyWebhook: async () => { throw new Error('this voice service takes no phone calls'); },
    engine,
    planner: { plan: async () => ({ say: null }) },
  }, engine));
}

function wire(rt: Omit<VoiceRuntime, 'openaiApiKey' | 'liveModel' | 'realtimeModel' | 'defaultEngine' | 'backendModel'>, parts: Pick<VoiceDeps, 'verifyWebhook' | 'engine' | 'planner'>, simulated?: SimulatedEngine): VoiceDeps {
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
      record: (a) => calls.recordAction(clinicId, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }),
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
      knowledge: rt.knowledge,
      events: rt.jobs ? eventSink(rt.jobs, (err) => rt.log.warn({ err: { message: (err as Error).message } }, 'could not queue an event')) : undefined,
      messenger: new TwilioMessenger(db, cipher, rt.twilio ? twilioSender(twilio(rt.twilio.accountSid, rt.twilio.authToken, { timeout: 5000 })) : null, (clinicId) => {
        const from = clinicNumbers.get(clinicId);
        if (!from) throw new Error(`no sending number known for clinic ${clinicId}`);
        return from;
      }, { dailyCap: rt.smsDailyCap, log: rt.log, statusCallback: rt.publicUrl ? (clinicId) => smsStatusUrl(rt.publicUrl!, clinicId) : undefined }),
    },
    sms: rt.twilio && rt.publicUrl ? {
      authToken: rt.twilio.authToken,
      publicUrl: rt.publicUrl,
      inbound: async ({ to, from, body }) => {
        const clinic = (await clinicForNumber(db, to)) as { id: string; name: string; timezone: string; phoneNumbers: string[]; primaryLanguage: keyof typeof PACKS } | null;
        if (!clinic) return undefined;
        const word = smsKeyword(body);
        // Twilio answers STOP and START itself on these numbers: one reply is enough
        if (word === 'stop' || word === 'start') { await recordSmsStanding(db, cipher, clinic.id, from, word === 'stop' ? 'opted_out' : 'opted_in', 'keyword'); return undefined; }
        if (word === 'confirm') {
          // C to a reminder: the next visit it was about is confirmed, and the clinic's webhooks hear of it
          const visit = await confirmByReply(db, cipher, clinic.id, from);
          if (!visit) return PACKS[clinic.primaryLanguage].smsNoReplies({ clinicPhone: clinic.phoneNumbers[0]! });
          if (rt.jobs) {
            await eventSink(rt.jobs, (err) => rt.log.warn({ err: { message: (err as Error).message } }, 'could not queue an event'))
              .emit(clinic.id, { type: 'appointment.confirmed', key: visit.id, data: { appointmentId: visit.id, patientId: visit.patientId, via: 'text' } });
          }
          return PACKS[clinic.primaryLanguage].smsConfirmed({ clinic: clinic.name, when: speakSlot(visit.startsAt, clinic.timezone, clinic.primaryLanguage) });
        }
        return PACKS[clinic.primaryLanguage].smsNoReplies({ clinicPhone: clinic.phoneNumbers[0]! });
      },
      status: async (job) => {
        if (!(SMS_STATUSES as readonly string[]).includes(job.status)) return;
        await (rt.jobs ?? noJobs).smsStatus({ ...job, status: job.status as (typeof SMS_STATUSES)[number] });
      },
    } : undefined,
    log: rt.log,
    internalToken: rt.internalToken,
    browserCallMaxSeconds: rt.browserCallMaxSeconds,
    simulator: sim ? { engine: sim, callFor: simulatedCallFor } : undefined,
  };
}
