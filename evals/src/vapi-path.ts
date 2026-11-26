// SPDX-License-Identifier: AGPL-3.0-only
// The scripted scenarios on the Vapi path (batch 6, item 8), free: each call is played into the voice service's own Vapi
// route in-process (Fastify inject, no network), as Vapi would post it: the conversation as conversation-update messages,
// each scripted tool step as a tool-calls message, then the end-of-call report. What our rules send back to the call
// (a script to say, a transfer, the end of the call) goes to a stand-in for the call's control URL. The same outcomes as
// on our own engines are checked. Never a call to Vapi, never a model.
import { addDays, type ClinicConfig, forVapiVoice, localDateOf, type Messenger, weekdayOf, zonedInstant } from '@attendra/core';
import { CallRepository, createPhiCipher, KnowledgeRepository, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, schema, withClinic } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { HybridKnowledgeBase, LocalEmbedder, seedDemoKnowledge } from '@attendra/knowledge';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import { registerVapi, VAPI_EVENTS_PATH } from '@attendra/voice/vapi';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import type { Scenario } from './scenario';
import { clinicOf, defaultCaller, prepareScenario, SEEDS, SIM_NOW } from './simulator';

/** A scenario the Vapi path can play as written: one that needs no part of our own call runner or of the planner path. */
export function playableOnVapi(s: Scenario): boolean {
  if (s.silent_start || s.greeting_interrupted) return false; // the greeting is Vapi's, spoken before any of our code runs
  if (s.history) return false; // the earlier calls from the number are given to our own engines only
  if (s.channel === 'web' && s.caller_number) return false; // "call as" is a browser test call on our own engine
  return s.turns.every((t) => !('caller' in t) || !t.dropped); // our watchdog for a turn the voice let go
}

/**
 * The scenarios the Vapi path must pass (batch 6, item 8): booking, a move, a cancellation, emergencies in English and
 * Spanish, refusals, and requests, at the medical demo clinic and the veterinary one.
 */
export const VAPI_PATH_SCENARIOS = [
  'booking-happy-path', 'reschedule-existing', 'cancel-with-confirmation', 'hedge-is-not-yes', 'no-identity-no-records', 'wrong-dob-three-times', 'emergency-chest-pain',
  'not-an-emergency', 'es-booking', 'es-hedge', 'es-emergency', 'es-refill', 'es-wrong-dob',
  // a visit the clinic does not offer, and "what can I book?": the same answer as on the planner path (2026-11-16)
  'vet-visit-not-offered', 'vet-es-visit-not-offered', 'vet-what-visits', 'vet-es-what-visits', 'vet-not-offered-common-question-wins',
  // a demo clinic's emergency: the demo line, recorded as demo_line, never "sent to hospital" (V4, 2026-11-18)
  'demo-emergency-refer-setting', 'demo-emergency-refer-setting-es', 'demo-emergency-handle-open', 'demo-emergency-handle-open-es',
  // Vapi's voice: "Doctor Nkem Okafor" with no pause, and "8, 8:30 or 9 AM" (V3, 2026-11-18)
  'vapi-speech-times-and-title', 'vapi-es-speech-times-and-title',
  // the caller ID's last four are ours: given with an identity answer, and other digits said for it corrected (V2)
  'vapi-caller-id-digits', 'vapi-es-caller-id-digits',
  // the call quality batch (2026-11-18): each test call's failure as a scripted call, on both paths
  'vet-volunteered-last-four-one-step', 'vet-es-volunteered-last-four-one-step', 'vet-last-four-as-phone', 'vet-es-last-four-as-phone',
  'vet-misheard-number-asked-again', 'vet-es-misheard-number-asked-again',
  'vet-text-caller-asks-is-consent', 'vet-es-text-caller-asks-is-consent', 'vet-text-ya-is-yes', 'vet-es-text-ok-is-yes',
  'vet-text-unclear-asked-once', 'vet-es-text-unclear-asked-once', 'vet-time-named-is-yes', 'vet-es-time-named-is-yes',
  'vet-service-not-offered-no-weak-match', 'vet-es-service-not-offered-no-weak-match', 'vet-refill-follow-up-updates', 'vet-es-refill-follow-up-updates',
  'vet-slot-args-as-meant', 'vet-es-slot-args-as-meant',
  'vet-how-are-you-in-kind', 'vet-es-how-are-you-in-kind',
  // the demo emergency that closes on a goodbye (Q9): played once the harness plays demo calls (V4's fix)
  'demo-emergency-closes-on-goodbye', 'demo-emergency-closes-on-goodbye-es',
  // call quality round 2 (2026-11-19)
  'vet-yes-names-pet-on-number', 'vet-es-yes-names-pet-on-number', 'vet-emergency-policy-question', 'vet-es-emergency-policy-question',
  'vet-emergency-just-asking', 'vet-es-emergency-just-asking', 'vet-pending-cancel-settled', 'vet-es-pending-cancel-settled',
  'vet-any-other-vet', 'vet-es-any-other-vet', 'vet-new-puppy-registered', 'vet-es-new-puppy-registered',
  'vet-name-pet-then-last-four', 'vet-es-name-pet-then-last-four',
  'vet-ya-esta-bien-goodbye', 'vet-es-ya-esta-bien-goodbye', 'vet-found-then-no-request', 'vet-es-found-then-no-request',
  // a tester's call (2026-11-24): each item as a scripted call, and the whole call, on both paths
  'vet-T1-species-not-said', 'vet-es-T1-species-not-said', 'vet-T1-age-not-given', 'vet-es-T1-age-not-given',
  'vet-T1-second-pet-own-details', 'vet-es-T1-second-pet-own-details', 'vet-T2-stale-change-replaced-silently', 'vet-es-T2-stale-change-replaced-silently',
  'vet-T3-cancel-by-vet-name', 'vet-es-T3-cancel-by-vet-name', 'vet-T5-no-internal-state', 'vet-es-T5-no-internal-state',
  'vet-T9-said-once', 'vet-es-T9-said-once', 'vet-tester-call-whole', 'vet-es-tester-call-whole',
  'vet-T6-vets-answered-once', 'vet-es-T6-vets-answered-once', 'vet-T7-household-kept', 'vet-es-T7-household-kept',
  'vet-T8-visit-to-another-pet', 'vet-es-T8-visit-to-another-pet', 'vet-T10-one-question', 'vet-es-T10-one-question',
  'vet-T11-fragment-confirmed', 'vet-es-T11-fragment-confirmed', 'vet-T12-slot-args-shapes', 'vet-es-T12-slot-args-shapes', 'vet-T12-day-with-part', 'vet-es-T12-day-with-part',
  'vet-T13-verified-on-calling-number', 'vet-es-T13-verified-on-calling-number',
  'vet-T8-swap-wrong-vet', 'vet-es-T8-swap-wrong-vet',
  // a plain yes in either language at every clinic (owner decision, 26 Nov)
  'vet-YES-ANY-LANG-si-at-english-clinic', 'vet-es-YES-ANY-LANG-yes-at-spanish-clinic',
  // "move it" / "cancel it" right after a booking, and "move that one": played since the Vapi script reads $booked and
  // $put_forward from the call itself (CQ2-VAPI8)
  'vet-move-it-after-booking', 'vet-es-move-it-after-booking', 'vet-cancel-it-after-booking', 'vet-es-cancel-it-after-booking',
  'vet-move-cancel-move-two-visits', 'vet-es-move-cancel-move-two-visits', 'vet-same-visit-move-that-one', 'vet-es-same-visit-move-that-one',
  // the adversarial set (step 4, master prompt robustness): callers testing or trying to break it, EN and ES
  'adv-ignore-instructions', 'adv-es-ignore-instructions', 'adv-asks-for-prompt', 'adv-es-asks-for-prompt',
  'adv-role-play-vet', 'adv-es-role-play-vet', 'adv-abuse-warning-then-end', 'adv-es-abuse-warning-then-end',
  'adv-nonsense-joke', 'adv-es-nonsense-joke', 'adv-topic-switch-pending', 'adv-es-topic-switch-pending',
  'adv-contradiction-latest-day', 'adv-es-contradiction-latest-day', 'adv-can-you-hear-me', 'adv-es-can-you-hear-me',
  'adv-caller-breaks-silence', 'adv-es-caller-breaks-silence', 'adv-fragment-other-language', 'adv-es-fragment-other-language',
  'adv-medical-dose', 'adv-es-medical-dose', 'adv-price-not-on-file', 'adv-es-price-not-on-file',
  'adv-other-clinic', 'adv-es-other-clinic', 'adv-staff-personal', 'adv-es-staff-personal',
  'adv-are-you-ai', 'adv-es-are-you-ai', 'adv-privacy-other-client', 'adv-es-privacy-other-client',
  'adv-text-other-number', 'adv-es-text-other-number', 'adv-owner-claim', 'adv-es-owner-claim',
  'adv-never-call-the-clinic', 'adv-es-never-call-the-clinic', 'adv-no-internal-words', 'adv-es-no-internal-words',
] as const;

export interface VapiPathResult { id: string; passed: boolean; failures: string[]; outcome: string; ms: number }

const SECRET = 'scripted-eval-location-secret-0123456789abcdef';
const CONTROL = 'https://phone-call-websocket.eval.vapi.ai/eval-call/control';

/** Replaces "$offered[0]", "$appointments[0]" and "$next_week" as the planner path's script does, from the results heard so far. */
function resolve(args: Record<string, unknown>, offered: string[], results: Record<string, unknown>[], clinic: ClinicConfig, now: Date, ids: { booked: string | null; putForward: string | null } = { booked: null, putForward: null }) {
  const appointments = results.flatMap((d) => (Array.isArray(d.appointments) ? (d.appointments as { appointment_id: string }[]) : []));
  return Object.fromEntries(Object.entries(args).map(([k, v]) => {
    if (typeof v !== 'string') return [k, v];
    const o = /^\$offered\[(\d+)\]$/.exec(v);
    if (o) return [k, offered[Number(o[1])] ?? v];
    const a = /^\$appointments\[(\d+)\]$/.exec(v);
    if (a) return [k, appointments[Number(a[1])]?.appointment_id ?? v];
    // the Nth time of the latest search, as the planner path's script reads it
    const f = /^\$found\[(\d+)\]$/.exec(v);
    if (f) {
      const latest = [...results].reverse().find((d) => Array.isArray(d.slots) && (d.slots as unknown[]).length);
      return [k, (latest?.slots as { slot_id: string }[] | undefined)?.[Number(f[1])]?.slot_id ?? v];
    }
    if (v === '$next_week') { const today = localDateOf(now, clinic.timezone); return [k, addDays(today, 7 - ((weekdayOf(today) + 6) % 7))]; }
    // the visit booked or moved to on this call, and the one the backend put forward to move: the ids a Vapi model has
    // from the call itself (the visit it just booked, and the id the tool result gave with "move that one?"), as the
    // planner path's script reads them from the call state (CQ2-VAPI8: these 8 scenarios could not be played)
    if (v === '$booked') return [k, ids.booked ?? v];
    if (v === '$put_forward') return [k, ids.putForward ?? v];
    return [k, v];
  }));
}

/** One scenario through the Vapi route, in its own fresh in-process Postgres. */
export async function runScenarioOnVapi(scenario: Scenario): Promise<VapiPathResult> {
  const started = performance.now();
  const t = await openTestDatabase();
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  try {
    const cipher = createPhiCipher(TEST_DATA_KEY);
    const { patientIds } = await SEEDS[scenario.clinic](t.db, cipher);
    if (scenario.tags.includes('knowledge')) await seedDemoKnowledge(t.db, new LocalEmbedder());
    // the clinic as switched to Vapi
    const clinic: ClinicConfig = { ...clinicOf(scenario), voiceEngine: 'vapi' };
    const now = scenario.local_time ? zonedInstant('2026-09-28', scenario.local_time, clinic.timezone) : SIM_NOW;
    await prepareScenario(t.db, cipher, patientIds, scenario, clinic, now);
    const callerNumber = scenario.caller_number === undefined ? defaultCaller(scenario) : scenario.caller_number;
    const sms: string[] = [];
    const messenger: Messenger = { async sendTemplate(_c, m) { sms.push(m.template); return { status: 'sent', messageId: `sms-${sms.length}` }; } };
    const calls = new CallRepository(t.db, cipher);
    const controls: { type: string; body: Record<string, unknown>; onCallerWords: boolean }[] = [];
    let onCallerWords = false;
    registerVapi(app, {
      secretMatches: async (id, presented) => id === clinic.id && presented === SECRET,
      maxConcurrency: 4,
      fetch: (async (_url: string, init: { body: string }) => { const body = JSON.parse(init.body) as Record<string, unknown>; controls.push({ type: String(body.type), body, onCallerWords }); return new Response('{"status":"ok"}'); }) as unknown as typeof fetch,
      // a transfer or a hang-up after its line runs at once; a demo call's 14- and 15-minute limits never come in a
      // scripted call (run at once, they ended every demo call before its first turn)
      later: (ms, fn) => { if (ms < 60_000) fn(); },
      clinicById: async (id) => (id === clinic.id ? clinic : null),
      openCall: (clinicId, sessionId, from, channel, startedBy, last4, how) => calls.open(clinicId, sessionId, from, channel, startedBy, last4, how),
      recorderFor: (clinicId, callId) => ({ appendSegment: (s) => calls.appendSegment(clinicId, callId, s), close: (c) => calls.close(clinicId, callId, c) }),
      actionsFor: (clinicId, callId) => ({ record: (a) => calls.recordAction(clinicId, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }) }),
      backend: {
        patients: new PostgresPatientDirectory(t.db, cipher), scheduler: new BuiltinScheduler(t.db, 'voice-agent', cipher), tasks: new PostgresTaskQueue(t.db, cipher),
        audit: new PostgresAuditLog(t.db), messenger, knowledge: new HybridKnowledgeBase(new KnowledgeRepository(t.db), new LocalEmbedder()),
      },
      planner: { plan: async () => { throw new Error('the Vapi path never asks the planner'); } },
      log: createLogger({ name: 'eval-vapi', destination: new Writable({ write: (_c, _e, done) => done() }) }),
      now: () => now,
    });
    await app.ready();

    const vapiId = `eval-${scenario.id}`;
    const call = { id: vapiId, type: scenario.channel === 'web' ? 'webCall' : 'inboundPhoneCall', ...(callerNumber && scenario.channel !== 'web' ? { customer: { number: callerNumber } } : {}), monitor: { controlUrl: CONTROL } };
    const post = async (message: Record<string, unknown>) => {
      const res = await app.inject({ method: 'POST', url: `${VAPI_EVENTS_PATH}?clinic=${clinic.id}`, headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, payload: JSON.stringify({ message: { ...message, call } }) });
      if (res.statusCode !== 200) throw new Error(`the Vapi route answered ${res.statusCode}`);
      return res.json() as { results?: { toolCallId: string; result?: string; error?: string }[] };
    };
    // Vapi's conversation as it grows: lines in its units (secondsFromStart in seconds, duration in ms)
    const lines: { role: string; message: string; secondsFromStart: number; duration: number }[] = [];
    let clock = 0;
    const say = (role: 'bot' | 'user', message: string) => { clock += 1.5; lines.push({ role, message, secondsFromStart: clock, duration: 1000 }); clock += 1; };
    say('bot', clinic.greeting);
    await post({ type: 'status-update', status: 'in-progress' });

    const outputs: { ok: boolean; outcome: string; spoken?: string; say?: string; data: Record<string, unknown> }[] = [];
    const offered: string[] = [];
    const searches: unknown[] = [];
    let lastReadback: string | null = null;
    let n = 0;
    const over = () => controls.some((c) => c.type === 'transfer' || c.type === 'end-call');
    for (const turn of scenario.turns) {
      if (over()) break;
      if ('assistant' in turn) { say('bot', turn.assistant); continue; }
      say('user', turn.caller);
      onCallerWords = true;
      await post({ type: 'conversation-update', messages: [...lines] });
      onCallerWords = false;
      let proposed: string | null = null;
      for (const step of turn.delegate ?? []) {
        if (over()) break;
        const [tool, raw] = Object.entries(step)[0]! as [string, Record<string, unknown>];
        // the visit this call last booked (or moved to): the id its booking's own result gave, as the Vapi model saw it; and
        // the last visit a slot search put forward to move (CQ2-VAPI8, review 3: never from the call state or the database)
        const booked = ([...outputs].reverse().find((o) => o.data?.booked === true && typeof o.data.appointment_id === 'string')?.data.appointment_id as string | undefined) ?? null;
        const putForward = [...JSON.stringify(searches).matchAll(/replaces_appointment_id ([\w-]+)/g)].at(-1)?.[1] ?? null;
        const args = resolve(raw, offered, outputs.map((o) => o.data), clinic, now, { booked, putForward });
        const res = await post({ type: 'tool-calls', toolCallList: [{ id: `tc_${++n}`, function: { name: tool, arguments: JSON.stringify(args) } }], artifact: { messages: [...lines] } });
        const r = res.results?.[0];
        if (!r?.result) throw new Error(r?.error ?? 'no result');
        const out = JSON.parse(r.result) as (typeof outputs)[number];
        outputs.push(out);
        // the slot searches' own results: where a visit is put forward to move ("move that one, or book another?")
        if (tool === 'find_slots') searches.push(out);
        for (const slot of Array.isArray(out.data.slots) ? out.data.slots as { slot_id: string }[] : []) if (!offered.includes(slot.slot_id)) offered.push(slot.slot_id);
        if (out.ok && out.spoken && (tool.startsWith('propose_') || (out as { stage?: string }).stage === 'readback_pending')) proposed = lastReadback = out.spoken;
      }
      // a read-back given this turn is said word for word, as Vapi's model says a tool's spoken words (the script's own
      // reply paraphrases it for the planner path, whose voice is handed the words separately)
      if (proposed && !(turn.reply ?? '').includes('{readback}')) say('bot', proposed);
      if (turn.reply) {
        const offeredWords = outputs.flatMap((o) => (Array.isArray(o.data.slots) ? (o.data.slots as { when: string }[]).map((x) => x.when) : []));
        const text = turn.reply
          .replace(/\{offered\.(\d+)\}/g, (_, i: string) => offeredWords[Number(i)] ?? 'another time')
          .replace(/\{readback\}/g, () => lastReadback ?? 'that')
          .replace(/\{booked\}/g, () => lastReadback ?? 'that time');
        say('bot', text);
      }
    }
    await post({ type: 'end-of-call-report', endedReason: over() ? 'assistant-forwarded-call' : 'customer-ended-call', durationSeconds: Math.round(clock), cost: 0, artifact: { messages: [...lines] } });

    // what the call left, read back as the call list and the margin page read it
    const [row] = await withClinic(t.db, clinic.id, (tx) => tx.select().from(schema.calls).where(eq(schema.calls.engineSessionId, `vapi_${vapiId}`)));
    if (!row) throw new Error('no call row for the Vapi call');
    const created = await withClinic(t.db, clinic.id, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.createdByCallId, row.id)));
    const e = scenario.expect;
    const failures: string[] = [];
    const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };
    check(row.engine === 'vapi' && row.voiceFlow === 'tools', `recorded as ${row.engine}/${row.voiceFlow}, expected vapi/tools`);
    check(e.outcome_any ? e.outcome_any.includes(row.outcome as never) : row.outcome === e.outcome, `outcome ${row.outcome}, expected ${e.outcome_any ? e.outcome_any.join(' or ') : e.outcome}`);
    const refusals = outputs.filter((o) => !o.ok && typeof o.data === 'object' && o.outcome !== 'refused').map((o) => o.outcome);
    check(JSON.stringify(refusals) === JSON.stringify(e.refusals), `refusals ${JSON.stringify(refusals)}, expected ${JSON.stringify(e.refusals)}`);
    if (e.verified !== undefined) {
      const verified = outputs.some((o) => o.data.verified === true || o.data.registered === true);
      check(verified === e.verified, `verified ${verified}, expected ${e.verified}`);
    }
    check(created.length === e.bookings_created, `${created.length} bookings created, expected ${e.bookings_created}`);
    if (e.requests_created !== undefined) {
      const made = (await withClinic(t.db, clinic.id, (tx) => tx.select().from(schema.tasks).where(eq(schema.tasks.callId, row.id)))).length;
      check(made === e.requests_created, `${made} requests for the team, expected ${e.requests_created}`);
    }
    check(sms.length === e.sms_sent, `${sms.length} texts sent, expected ${e.sms_sent}`);
    const transfer = controls.find((c) => c.type === 'transfer')?.body.destination as { type: string; number?: string; sipUri?: string } | undefined;
    const transferTo = transfer ? (transfer.type === 'number' ? `tel:${transfer.number}` : transfer.sipUri ?? null) : null;
    check(transferTo === e.transfer_to, `transfer to ${transferTo ?? 'nobody'}, expected ${e.transfer_to ?? 'nobody'}`);
    // the emergency script, said on the call through its control URL the moment the caller's words call for it
    const script = controls.some((c) => c.type === 'say' && c.onCallerWords) && row.emergencyFlag;
    check(script === e.emergency_instruction, `emergency script said ${script}, expected ${e.emergency_instruction}`);
    if (e.language) check(row.language === e.language, `answered in ${row.language}, expected ${e.language}`);
    // how an animal's emergency ended, as the call page labels it ("Emergency · demo line" on a demo clinic)
    if (e.emergency_result !== undefined) check(row.emergencyResult === e.emergency_result, `emergency result ${row.emergencyResult ?? 'none'}, expected ${e.emergency_result}`);
    if (e.no_emergency_result) check(!row.emergencyResult, `emergency result ${row.emergencyResult}, expected none`);
    // what the tools handed the voice, as on the planner path: the same facts and words
    const handed = JSON.stringify(outputs).toLowerCase();
    // a phrase in the words Vapi's voice gets (forVapiVoice: "Dr. Vance" is "Doctor Vance" there), so a check means the same
    // (a phrase written in lower case, "dr. elena ruiz", is the title in full too)
    const vapiWords = (p: string) => forVapiVoice(p).toLowerCase().replace(/\bdra\. /g, 'doctora ').replace(/\bdr\. /g, 'doctor ');
    for (const phrase of e.returned) check(handed.includes(vapiWords(phrase)), `no tool result gave "${phrase}"`);
    for (const phrase of e.never_returned) check(!handed.includes(vapiWords(phrase)), `a tool result gave "${phrase}", which it must not`);
    for (const phrase of e.vapi_returned) check(handed.includes(phrase.toLowerCase()), `no tool result gave "${phrase}" on the Vapi path`);
    for (const phrase of e.vapi_never_returned) check(!handed.includes(phrase.toLowerCase()), `a tool result gave "${phrase}" on the Vapi path, which it must not`);
    const said = controls.filter((c) => c.type === 'say').map((c) => String(c.body.content));
    for (const line of e.vapi_said) check(said.includes(line), `the call never heard "${line}" on the Vapi path`);
    if (e.hung_up !== undefined) {
      const byRule = controls.some((c) => c.type === 'end-call' && c.onCallerWords);
      check(byRule === e.hung_up, `the assistant ${byRule ? 'ended the call itself' : 'did not end the call itself'}, expected ${e.hung_up ? 'it to' : 'not to'}`);
    }
    return { id: scenario.id, passed: failures.length === 0, failures, outcome: row.outcome ?? 'none', ms: Math.round(performance.now() - started) };
  } finally {
    await app.close();
    await t.close();
  }
}
