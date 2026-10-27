// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, CallAgent, CallState, type Outbound, type Planner, type PlannerInput, type PlannerTiming, ScriptedPlanner, type ScriptedStep, type ToolResult } from '@attendra/agent';
import { addDays, awayOn, textingOf, awayWindows, ClinicConfig, DEMO_CLINIC, DEMO_CLINICS, localDateOf, localParts, type Messenger, speakSlot, toMinutes, type ToolName, weekdayOf, windowsOn, windowsOnDate, zonedInstant } from '@attendra/core';
import { CallRepository, CEDAR_PARK_PATIENTS, createPhiCipher, type Database, DEMO_PATIENTS, KnowledgeRepository, PatientRecords, type PhiCipher, phoneKey, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, RIVERBEND_PETS, schema, seedCedarPark, seedDemo, seedRiverbend, withClinic } from '@attendra/db';
import { and, eq } from 'drizzle-orm';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { HybridKnowledgeBase, LocalEmbedder, seedDemoKnowledge } from '@attendra/knowledge';
import { BuiltinScheduler } from '@attendra/scheduling';
import { CallRunner, OPENING_NUDGE_MS, type SidebandEvent, type VoiceEngine } from '@attendra/voice-engine';
import { Writable } from 'node:stream';
import type { Scenario } from './scenario';

// Every scenario is a call on Monday 28 September 2026 at 8 pm in Denver, after hours.
export const SIM_NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);

/**
 * The demo clinic, with the scenario's settings changed and checked the way Settings checks a save.
 * Texting is on, as for a clinic whose texting registration is approved (confirmations go out only
 * then), unless the scenario sets texting itself.
 */
export const clinicOf = (scenario: Scenario): ClinicConfig => {
  const base = DEMO_CLINICS[scenario.clinic];
  const approved = { ...base, texting: { ...textingOf(base), enabled: true } };
  return ClinicConfig.parse({ ...approved, ...scenario.settings });
};
const defaultCaller = (scenario: Scenario) => ({ maple: DEMO_PATIENTS[0].phone, cedar_park: CEDAR_PARK_PATIENTS[0].phone, riverbend: RIVERBEND_PETS[0].phone })[scenario.clinic];
/** Each demo clinic's seed: the clinic and its patients. */
export const SEEDS = { maple: seedDemo, cedar_park: seedCedarPark, riverbend: seedRiverbend } as const;

export interface ScenarioResult {
  id: string;
  passed: boolean;
  failures: string[];
  refusals: string[];
  outcome: string;
  spoken: string[];
  /** The call as a judge reads it: the greeting, each caller line, what the assistant said, and any instruction the backend sent the voice. */
  transcript: { speaker: 'caller' | 'assistant' | 'instruction'; text: string }[];
  tools: string[];
  /** Each tool call with its arguments and result, for the report. */
  calls: ToolCall[];
  /** Live only: each planner request's own model time and setting, to compare speed settings. */
  timings: PlannerTiming[];
  callId: string;
  ms: number;
}

/** Plays the caller after the opening line, live: the next line given the call so far, and whether they hang up after it. */
export type FollowUp = (scenario: Scenario, transcript: ScenarioResult['transcript']) => Promise<{ text: string; hangup: boolean }>;

/** One tool call as the report shows it: the name, the arguments and what came back. Synthetic data only. */
export interface ToolCall { tool: string; args: unknown; data: Record<string, unknown> }

/** Records every tool result the planner saw, so refusals can be checked whichever planner ran. */
class Observed implements Planner {
  readonly calls: ToolCall[] = [];
  readonly tools: string[] = [];
  readonly refusals: string[] = [];
  readonly sources: string[] = [];
  readonly cited: string[] = [];
  readonly timings: PlannerTiming[] = [];
  constructor(private readonly inner: Planner) {}
  async plan(input: PlannerInput, execute: (name: ToolName, args: unknown) => Promise<ToolResult>) {
    const out = await this.inner.plan(input, async (name, args) => {
      const r = await execute(name, args);
      this.calls.push({ tool: name, args, data: r.data });
      this.tools.push(name);
      if (typeof r.data.error === 'string') this.refusals.push(r.data.error);
      if (typeof r.data.source === 'string') this.sources.push(r.data.source);
      if (Array.isArray(r.data.passages)) this.cited.push(...(r.data.passages as { title: string }[]).map((p) => p.title));
      return r;
    });
    if (out.timing) this.timings.push(out.timing);
    return out;
  }
}

/**
 * Replaces "$offered[0]" and "$appointments[0]" with ids the call actually produced, and
 * "$next_week" with the Monday after the call's day, for a caller who asks for next week.
 */
function resolve(args: Record<string, unknown>, state: CallState, results: ToolResult[], clinic: ClinicConfig, now: Date): Record<string, unknown> {
  const appointments = results.flatMap((r) => (Array.isArray(r.data.appointments) ? (r.data.appointments as { appointment_id: string }[]) : []));
  return Object.fromEntries(Object.entries(args).map(([k, v]) => {
    if (typeof v !== 'string') return [k, v];
    const offered = v.match(/^\$offered\[(\d+)\]$/);
    if (offered) return [k, [...state.offered.keys()][Number(offered[1])] ?? v];
    const appt = v.match(/^\$appointments\[(\d+)\]$/);
    if (appt) return [k, appointments[Number(appt[1])]?.appointment_id ?? v];
    if (v === '$next_week') {
      const today = localDateOf(now, clinic.timezone);
      return [k, addDays(today, 7 - ((weekdayOf(today) + 6) % 7))];
    }
    return [k, v];
  }));
}

/**
 * What the voice says of a backend instruction: its quoted lines ("Say: \"...\""), or all of it when
 * nothing is quoted. A note about the caller ("The caller used insulting language...") is for the
 * voice alone: nothing of it is said.
 */
function scriptLines(instruction: string): string {
  const quoted = [...instruction.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim());
  if (quoted.length) return quoted.join(' ');
  return /^The caller /.test(instruction) ? '' : instruction;
}

/** Live, the voice speaks the planner's own words: a line says a phrase when it has most of the phrase's words. */
function saysMostOf(line: string, phrase: string): boolean {
  const words = (t: string) => t.toLowerCase().replace(/[’']/g, '\'').split(/[^\p{L}\p{N}']+/u).filter((w) => w.length >= 4);
  const said = new Set(words(line));
  const wanted = words(phrase);
  return wanted.length > 0 && wanted.filter((w) => said.has(w)).length / wanted.length >= 0.75;
}

/** The questions in a line: each sentence that ends with a question mark. */
function questionsIn(line: string): string[] {
  return line.split(/(?<=[.!?])\s+/).map((q) => q.trim()).filter((q) => q.endsWith('?'));
}

/** Two questions are the same question when they are the same words (case, punctuation and accents aside); a confirmation asked once per change is not. */
function sameQuestion(a: string, b: string): boolean {
  const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '\'').split(/[^\p{L}\p{N}']+/u).filter(Boolean).join(' ');
  // the closing and confirming questions, and "how can I help?" once at the greeting and once after finding the caller, are no repeat
  if (/anything else|is that right|shall i book|is that correct|book (it|that)\?|how can i help|en qu[eé] (le )?puedo ayudar/i.test(a) && /anything else|is that right|shall i book|is that correct|book (it|that)\?|how can i help|en qu[eé] (le )?puedo ayudar/i.test(b)) return false;
  const [x, y] = [norm(a), norm(b)];
  return x.length >= 12 && x === y;
}

/**
 * Every time the assistant offered must be one the clinic can take: inside the clinic's hours
 * that day (a special day's own, none on a holiday), inside the provider's own hours and outside
 * their time off, with a provider who gives that visit. Anything else is a time the front desk
 * would have to apologise for.
 */
function offeredOutsideHours(clinic: ClinicConfig, offered: { start: Date; end: Date; providerId: string; visitTypeId: string }[]): string[] {
  const out: string[] = [];
  for (const slot of offered) {
    const local = localParts(slot.start, clinic.timezone);
    const endMin = local.minutes + Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000);
    const inside = (windows: { open: string; close: string }[]) => windows.some((w) => local.minutes >= toMinutes(w.open) && endMin <= toMinutes(w.close));
    const when = `${local.date} ${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;
    if (!inside(windowsOnDate(clinic, local.date))) { out.push(`${when} is outside the clinic's hours that day`); continue; }
    const provider = clinic.providers.find((p) => p.id === slot.providerId);
    if (!provider) { out.push(`${when} is with an unknown provider ${slot.providerId}`); continue; }
    if (!provider.visitTypeIds.includes(slot.visitTypeId)) out.push(`${when} is with ${provider.name}, who does not give that visit`);
    if (awayOn(provider, local.date)) out.push(`${when} is with ${provider.name}, who is away that day`);
    if (awayWindows(provider, local.date).some((w) => local.minutes < w.end && endMin > w.start)) out.push(`${when} is with ${provider.name} during their time off`);
    if (provider.hours && !inside(windowsOn(provider.hours, weekdayOf(local.date)))) out.push(`${when} is outside ${provider.name}'s own hours`);
  }
  return out;
}

/** Fills {offered.N}, {readback} and {booked} in a scripted reply from the call as it happened. */
function render(reply: string, state: CallState, lastReadback: string | null, clinic: ClinicConfig): string {
  const offered = [...state.offered.values()];
  return reply
    .replace(/\{offered\.(\d+)\}/g, (_, i: string) => { const slot = offered[Number(i)]; return slot ? speakSlot(slot.start, clinic.timezone, state.language) : 'another time'; })
    .replace(/\{readback\}/g, () => state.pending?.readback ?? lastReadback ?? 'that')
    .replace(/\{booked\}/g, () => lastReadback ?? 'that time');
}

export interface PlayOptions {
  livePlanner?: Planner;
  /** Live only, and only for a scenario with `facts`: plays the caller after the opening line, answering the planner's questions. */
  followUp?: FollowUp;
  /** Writes the transcript, tool actions and close-out into the database, as the voice service does. Used for demo data. */
  record?: boolean;
  sessionId?: string;
  /** The call's own clock. The eval runs every scenario at SIM_NOW; the demo runs each call at the time it is dated. */
  now?: Date;
}

/** The first Thursday after `now` in the clinic's calendar that is not a holiday, at 9:00: the "appointment on Thursday" the reschedule and cancel scenarios start from. */
function nextThursday(clinic: ClinicConfig, now: Date): Date {
  let date = addDays(localDateOf(now, clinic.timezone), 1);
  while (weekdayOf(date) !== 4 || clinic.holidays.includes(date)) date = addDays(date, 1);
  return zonedInstant(date, '09:00', clinic.timezone);
}

/**
 * Plays one scenario against a database that already holds the demo clinic and its
 * patients. The eval gives each scenario a fresh in-process database; the demo seed
 * plays them all into one.
 */
export async function playScenario(db: Database, cipher: PhiCipher, patientIds: Record<string, string>, scenario: Scenario, opts: PlayOptions = {}): Promise<ScenarioResult> {
  const started = performance.now();
  const clinic = clinicOf(scenario);
  const now = opts.now ?? (scenario.local_time ? zonedInstant('2026-09-28', scenario.local_time, clinic.timezone) : SIM_NOW);
  const callerNumber = scenario.caller_number === undefined ? defaultCaller(scenario) : scenario.caller_number;
  const { livePlanner } = opts;
  const scheduler = new BuiltinScheduler(db);
  const sms: string[] = [];
  const messenger: Messenger = { async sendTemplate(_c, m) { sms.push(m.template); return { status: 'sent', messageId: `sms-${sms.length}` }; } };
  // the demo clinic's documents, with local embeddings: fixed, so every run finds the same passages
  const knowledge = new HybridKnowledgeBase(new KnowledgeRepository(db), new LocalEmbedder());
  const backend = { patients: new PostgresPatientDirectory(db, cipher), scheduler, tasks: new PostgresTaskQueue(db, cipher), audit: new PostgresAuditLog(db), messenger, knowledge };
  const calls = new CallRepository(db, cipher);

  // an existing appointment on Thursday (Maria's sick visit, or Biscuit's wellness exam at the vet), for the reschedule and cancel scenarios
  if (scenario.tags.includes('has-appointment')) {
    const setupCall = await calls.open(clinic.id, `setup_${scenario.id}`, null);
    const existing = nextThursday(clinic, now);
    const [patientId, providerId, visitTypeId, minutes] = scenario.clinic === 'riverbend' ? [patientIds.biscuit!, 'prov_ruiz', 'vt_wellness', 30] : [patientIds.maria!, 'prov_okafor', 'vt_sick', 20];
    await scheduler.book(clinic.id, { patientId, callId: setupCall, idempotencyKey: `setup-${scenario.id}`,
      slot: { id: 'setup', providerId, visitTypeId, start: existing, end: new Date(existing.getTime() + minutes * 60_000) } });
  }
  // Biscuit's past visits at the vet (Dr. Ruiz twice, the last on 14 September), for the visit questions
  if (scenario.tags.includes('visit-history') && scenario.clinic === 'riverbend') {
    const setupCall = await calls.open(clinic.id, `history_${scenario.id}`, null);
    for (const [date, key] of [['2026-08-10', 'a'], ['2026-09-14', 'b']] as const) {
      const start = zonedInstant(date, '09:00', clinic.timezone);
      await scheduler.book(clinic.id, { patientId: patientIds.biscuit!, callId: setupCall, idempotencyKey: `history-${scenario.id}-${key}`,
        slot: { id: `history-${key}`, providerId: 'prov_ruiz', visitTypeId: 'vt_wellness', start, end: new Date(start.getTime() + 30 * 60_000) } });
    }
  }
  // a second owner on Linh's number, as a family shares a phone: Grace Hale's cat Juniper
  // (once: the demo plays every scenario into one database)
  const seeded = new PostgresPatientDirectory(db, cipher, 'seed');
  if (scenario.tags.includes('family-number') && scenario.clinic === 'riverbend' && (await seeded.findPet(clinic.id, 'Grace Hale', 'Juniper', RIVERBEND_PETS[0].phone)).status === 'not_found') {
    await seeded.create(clinic.id, { firstName: 'Juniper', lastName: 'Hale', dob: '2022-04-01', phone: RIVERBEND_PETS[0].phone, guardianName: 'Grace Hale', gender: 'female', species: 'cat' });
  }
  const callId = await calls.open(clinic.id, opts.sessionId ?? `live_${scenario.id}`, callerNumber);
  // a name on file in the scenario's history is the one the records give for the number when the call starts, as the voice service reads it
  const historyName = /^Name on file for this number: (.+)\.$/m.exec(scenario.history ?? '')?.[1] ?? null;
  const recordsName = historyName && callerNumber && !opts.now ? await backend.patients.nameOnFile(clinic.id, callerNumber, callId) : historyName;
  const state = new CallState();
  const results: ToolResult[] = [];
  const queue: Planner[] = [];
  const observed = new Observed({ plan: (input, execute) => queue.shift()!.plan(input, execute) });
  // errors the call logs (a planner request that failed, so the caller heard the apology) are kept for the checks
  const errors: string[] = [];
  const log = createLogger({ name: 'eval', destination: new Writable({ write: (chunk, _e, done) => { loggedError(String(chunk), errors); done(); } }) });
  const actions: ActionRecorder | undefined = opts.record
    ? { record: (a) => calls.recordAction(clinic.id, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }) }
    : undefined;
  const agent = new CallAgent(state, { clinic, callId, callerNumber: callerNumber, now: () => now, channel: scenario.channel, history: scenario.history ?? null }, backend, observed, log, actions);
  const segment = async (speaker: 'caller' | 'agent', text: string, startMs: number) => {
    if (opts.record) await calls.appendSegment(clinic.id, callId, { speaker, text, startMs, endMs: startMs + 1200 });
  };

  const outbound: Outbound[] = [];
  const replies: string[] = [];
  let clock = 0;
  let delegations = 0;
  let lastReadback: string | null = null;
  // what the voice was told after each turn it let go
  const dropNudges: string[] = [];
  // a caller who speaks over the greeting has heard only its first words, and the call has them too
  const opening = scenario.greeting_interrupted ? `${clinic.greeting.split(' ').slice(0, 6).join(' ')}…` : clinic.greeting;
  if (scenario.greeting_interrupted) agent.onAgentTranscript(opening, clock, clock + 800);
  // a silent start: the real call runner, over a voice that says nothing until told to greet; it must be told in time
  const greetedAfter = scenario.silent_start ? await silentStart(agent, opening, log) : null;
  const transcript: ScenarioResult['transcript'] = [{ speaker: 'assistant', text: opening }];
  await segment('agent', opening, clock);
  // live, a scenario with facts keeps only its opening line: a model playing the caller answers
  // whatever the real planner asks next, in the order it asks, up to ten caller lines
  const followUp = livePlanner && scenario.facts ? opts.followUp : undefined;
  const lines: Scenario['turns'] = followUp ? scenario.turns.slice(0, 1) : [...scenario.turns];
  const over = () => state.emergency !== null || outbound.some((o) => o.type === 'transfer' || o.type === 'hangup');
  let hungUp = false;
  let callerSilent = false;
  // the call was ended by a rule of the code (the abusive caller), not by end_call after a goodbye
  let endedByRule = false;
  for (let i = 0; i < lines.length; i++) {
    const turn = lines[i]!;
    // a line the scenario gives the voice (the exact question a tool handed it) is said on the call: live, it counts as spoken (scripted, the reply before it says it)
    if ('assistant' in turn) { agent.onAgentTranscript(turn.assistant, clock, clock + 1000); transcript.push({ speaker: 'assistant', text: turn.assistant }); if (livePlanner) replies.push(turn.assistant); await segment('agent', turn.assistant, clock); continue; }
    // live, the caller speaks after the assistant has finished, as on a real call: a yes said
    // at the same moment as the read-back would not count as an answer to it
    if (livePlanner) clock += 1500;
    const heard = agent.onCallerTranscript(turn.caller, clock, clock + 1000);
    outbound.push(...heard);
    if (heard.some((o) => o.type === 'hangup')) endedByRule = true;
    transcript.push({ speaker: 'caller', text: turn.caller });
    // the voice let this turn go: after 5 s the watchdog gives it the caller's own words to answer, and it hands them on
    if (turn.dropped) {
      const nudge = agent.onSilence(1);
      outbound.push(...nudge);
      for (const o of nudge) if (o.type === 'instructions') { transcript.push({ speaker: 'instruction', text: o.content }); dropNudges.push(o.content); }
    }
    for (const o of heard) if (o.type === 'instructions') {
      transcript.push({ speaker: 'instruction', text: o.content });
      // live, the voice model says the script it was handed (the quoted lines), as it does on a call
      if (livePlanner) { const said = scriptLines(o.content); if (said) { clock += 1500; agent.onAgentTranscript(said, clock, clock + 1000); transcript.push({ speaker: 'assistant', text: said }); } }
    }
    await segment('caller', turn.caller, clock);
    const say = async () => {
      // live, the assistant's words are the model's, not the script's
      if (!turn.reply || livePlanner) return;
      const text = render(turn.reply, state, lastReadback, clinic);
      replies.push(text);
      transcript.push({ speaker: 'assistant', text });
      clock += 2500;
      await segment('agent', text, clock);
    };
    if (!turn.delegate && !livePlanner) { await say(); continue; }
    if (state.emergency) { await say(); break; } // the script takes over; nothing else runs on this call
    if (endedByRule) { await say(); break; } // the assistant ended the call on this line (an abusive caller): nothing is planned after a goodbye
    if (livePlanner) queue.push(livePlanner);
    else {
      const steps: ScriptedStep[] = turn.delegate!.map((step) => {
        const [tool, args] = Object.entries(step)[0]! as [ToolName, Record<string, unknown>];
        return { tool, args: (sofar: ToolResult[]) => resolve(args, state, [...results, ...sofar], clinic, now) };
      });
      const scripted = new ScriptedPlanner(steps, (r) => { results.push(...r); const last = r.at(-1); return last ? JSON.stringify(last.data) : null; });
      queue.push(scripted);
    }
    const out = await agent.onDelegation(`item_${++delegations}`);
    outbound.push(...out);
    for (const o of out) if (o.type === 'commentary') {
      clock += 1500;
      agent.onAgentTranscript(o.content, clock, clock + 1000);
      if (livePlanner) transcript.push({ speaker: 'assistant', text: o.content });
    }
    if (state.pending) lastReadback = state.pending.readback;
    await say();
    // live, after the last line so far: the model caller answers the planner's question from
    // the scenario's facts, until the call is over or it has said ten lines
    // a caller who says goodbye still has that last line heard ("Yes, that's right, thanks, bye")
    if (i === lines.length - 1 && followUp && !hungUp && lines.length < 10 && !over()) {
      const next = await followUp(scenario, transcript);
      if (next.text) lines.push({ caller: next.text });
      hungUp = next.hangup;
      callerSilent = !next.text && !next.hangup;
    }
  }

  if (opts.record) {
    const transfer = outbound.find((o) => o.type === 'transfer');
    await calls.close(clinic.id, callId, {
      // the simulator's clock counts turns, not speech; scale it to a believable call length
      reason: transfer ? 'transferred' : 'caller_hangup', voiceSeconds: Math.round(8 + clock * 0.0032),
      outcome: state.outcome, emergency: state.emergency !== null,
    });
  }

  const createdRows = await withClinic(db, clinic.id, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.createdByCallId, callId)));
  const created = createdRows.length;
  // live, the voice speaks the planner's words, which paraphrase the backend's: a line the
  // backend gave in a tool result (the read-back, the no-medical-advice line) counts as given
  const given = livePlanner ? observed.calls.flatMap((c) => ['say', 'readback'].flatMap((k) => (typeof c.data[k] === 'string' ? [c.data[k] as string] : []))) : [];
  const spoken = [...outbound.flatMap((o) => (o.type === 'commentary' ? [o.content] : o.type === 'instructions' && scriptLines(o.content) ? [scriptLines(o.content)] : [])), ...replies, ...given];
  const transfer = outbound.find((o) => o.type === 'transfer');
  const e = scenario.expect;
  const failures: string[] = [];
  const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };

  // a turn the voice let go comes back to it with the caller's own words, and never as a request to say it again
  for (const [i, turn] of scenario.turns.entries()) {
    if (!('caller' in turn) || !turn.dropped) continue;
    const nudge = dropNudges.shift() ?? '';
    check(nudge.includes(turn.caller.replace(/["“”]/g, '\'')), `turn ${i + 1} was let go, and the voice was not given the caller's words back`);
    check(!/ask (them|the caller) to (say it again|repeat)(?! it)|repeat what|say that again/i.test(nudge), `turn ${i + 1} was let go, and the voice was told to ask the caller to repeat it`);
  }
  if (scenario.silent_start) {
    check(greetedAfter !== null, 'a silent start was never told to greet');
    if (greetedAfter !== null) check(greetedAfter <= OPENING_NUDGE_MS + 600, `a silent start was told to greet after ${greetedAfter} ms, more than ${OPENING_NUDGE_MS + 600}`);
  }
  // live, a call cut short by the test itself, or one where the backend failed, says so first
  if (livePlanner) {
    check(!callerSilent, 'the model playing the caller gave no line, so the call stopped early (the test, not the assistant)');
    for (const err of errors) check(false, `backend error: ${err}`);
  }
  // live, a call that answered a question and changed nothing is as good as one that changed nothing
  const sameOutcome = state.outcome === e.outcome || (!!livePlanner && e.outcome === 'abandoned' && state.outcome === 'info');
  check(sameOutcome, `outcome ${state.outcome}, expected ${e.outcome}`);
  if (!livePlanner) check(JSON.stringify(observed.refusals) === JSON.stringify(e.refusals), `refusals ${JSON.stringify(observed.refusals)}, expected ${JSON.stringify(e.refusals)}`);
  if (e.verified !== undefined) check(!!state.verifiedPatient === e.verified, `verified ${!!state.verifiedPatient}, expected ${e.verified}`);
  check(created === e.bookings_created, `${created} bookings created, expected ${e.bookings_created}`);
  check(sms.length === e.sms_sent, `${sms.length} texts sent, expected ${e.sms_sent}`);
  if (e.sms_templates.length) check(JSON.stringify(sms) === JSON.stringify(e.sms_templates), `texts ${JSON.stringify(sms)}, expected ${JSON.stringify(e.sms_templates)}`);
  check((transfer && transfer.type === 'transfer' ? transfer.uri : null) === e.transfer_to, `transfer to ${transfer && transfer.type === 'transfer' ? transfer.uri : 'nobody'}, expected ${e.transfer_to ?? 'nobody'}`);
  // the emergency script is an instruction the backend hands the voice; the abuse lines are instructions too, but not emergencies
  const emergencyScript = outbound.some((o) => o.type === 'instructions' && state.emergency !== null);
  check(emergencyScript === e.emergency_instruction, `emergency instruction ${emergencyScript}, expected ${e.emergency_instruction}`);
  if (e.cites) {
    const cited = [...new Set(observed.cited)];
    // live, the planner may answer from the clinic's own common questions, which come before any document
    const fromFaq = !!livePlanner && e.cites.length > 0 && observed.sources.length > 0;
    const ok = e.cites.length === 0 ? cited.length === 0 : fromFaq || (cited[0] === e.cites[0] && e.cites.every((t) => cited.includes(t)));
    check(ok, `cited ${JSON.stringify(cited)}, expected ${e.cites.length ? `${JSON.stringify(e.cites)}, the first leading` : 'nothing'}`);
  }
  // what the tools handed the planner, whichever planner ran: the facts it answers from
  const handed = JSON.stringify(observed.calls.map((c) => c.data)).toLowerCase();
  for (const phrase of e.returned) check(handed.includes(phrase.toLowerCase()), `no tool result gave "${phrase}"`);
  for (const phrase of e.never_returned) check(!handed.includes(phrase.toLowerCase()), `a tool result gave "${phrase}", which it must not`);
  if (e.answered_from) check(observed.sources.includes(e.answered_from), `answered from ${JSON.stringify(observed.sources)}, expected ${e.answered_from}`);
  if (e.language) check(state.language === e.language, `answered in ${state.language}, expected ${e.language}`);
  if (e.booked_with) check(createdRows.every((a) => a.providerId === e.booked_with), `booked with ${JSON.stringify(createdRows.map((a) => a.providerId))}, expected ${e.booked_with}`);
  if (e.offered_from_time) {
    const early = [...state.offered.values()].filter((s) => localParts(s.start, clinic.timezone).minutes < toMinutes(e.offered_from_time!));
    check(early.length === 0, `offered ${early.length} time(s) before ${e.offered_from_time}`);
  }
  // the demo plays each call on its own day, so a date that follows from "today" is checked only on the eval's day
  if (e.booked_on && !opts.now) check(createdRows.every((a) => localDateOf(a.startsAt, clinic.timezone) === e.booked_on), `booked on ${JSON.stringify(createdRows.map((a) => localDateOf(a.startsAt, clinic.timezone)))}, expected ${e.booked_on}`);
  for (const date of e.not_offered_on) {
    const on = [...state.offered.values()].filter((s) => localDateOf(s.start, clinic.timezone) === date);
    check(on.length === 0, `offered ${on.length} time(s) on ${date}, a day it must not offer`);
  }
  for (const phrase of e.spoken_contains) {
    check(spoken.some((s) => s.toLowerCase().includes(phrase.toLowerCase()) || (!!livePlanner && saysMostOf(s, phrase))), `never said "${phrase}"`);
  }
  // a forbidden phrase is one the assistant said: live, the tools' own notes to it ("Do not ask which vet") are not speech
  // the opening greeting is the clinic's own words, not the call's: a forbidden greeting is one said again
  const said = livePlanner ? transcript.slice(1).filter((l) => l.speaker === 'assistant').map((l) => l.text) : spoken;
  for (const phrase of scenario.forbid_spoken) {
    check(!said.some((s) => s.toLowerCase().includes(phrase.toLowerCase())), `said the forbidden phrase "${phrase}"`);
  }
  // a time the clinic cannot take is never offered, whichever planner ran
  for (const problem of offeredOutsideHours(clinic, [...state.offered.values()])) check(false, `offered a time it must not: ${problem}`);
  check(recordsName === historyName, `the history says the name on file is ${historyName}, the records give ${recordsName ?? 'none'}`);
  // the household on the pet page: a record on that number, and everyone else on the same phone (the demo plays every call into one database, so only the eval checks it)
  if (e.household && !opts.now) {
    const names = await householdOf(db, cipher, clinic.id, e.household.phone);
    const want = e.household.names.map((n) => n.toLowerCase()).sort();
    check(JSON.stringify(names.map((n) => n.toLowerCase()).sort()) === JSON.stringify(want), `on ${e.household.phone}: ${JSON.stringify(names)}, expected ${JSON.stringify(e.household.names)}`);
  }
  if (e.hung_up !== undefined) check(endedByRule === e.hung_up, `the assistant ${endedByRule ? 'ended the call itself' : 'did not end the call itself'}, expected ${e.hung_up ? 'it to' : 'not to'} (a goodbye after the caller said goodbye is not that)`);
  // live, the planner's own lines: one question at a time, and never the same question twice (asking again when the caller asks is fine)
  if (livePlanner) {
    // a read-back followed by its own "shall I book it?" is one question, not two
    const confirming = (q: string) => /shall i|is that right|is that correct|would you like me to|book (it|that)\?|sounds (good|right)\?/i.test(q);
    if (e.one_question_per_reply) for (const line of said) { const qs = questionsIn(line); check(qs.length <= 1 || (qs.length === 2 && confirming(qs[1]!)), `asked ${qs.length} questions in one reply: "${line}"`); }
    if (e.no_repeated_questions) {
      const asked: { q: string; at: number }[] = [];
      transcript.forEach((l, at) => { if (l.speaker === 'assistant') for (const q of questionsIn(l.text)) asked.push({ q, at }); });
      for (let i = 0; i < asked.length; i++) for (let j = i + 1; j < asked.length; j++) {
        const between = transcript.slice(asked[i]!.at + 1, asked[j]!.at).filter((l) => l.speaker === 'caller').map((l) => l.text.toLowerCase());
        // asked again on request ("say that again", "what?", "sorry?") is not a repeat
        const askedToRepeat = between.some((t) => /\b(again|repeat|what\?|sorry\?|pardon|didn't catch|did not catch|say that)\b/.test(t));
        // "Which time works for you?" after a new set of times (the caller changed the day: Wednesday, not Tuesday) is a new
        // question: the reply around it differs, not only the question
        const around = (at: number, q: string) => transcript[at]!.text.replace(q, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const newOffer = around(asked[i]!.at, asked[i]!.q) !== around(asked[j]!.at, asked[j]!.q) && around(asked[j]!.at, asked[j]!.q).length > 12;
        if (between.length && !askedToRepeat && !newOffer && sameQuestion(asked[i]!.q, asked[j]!.q)) { check(false, `asked the same question twice: "${asked[i]!.q}" and later "${asked[j]!.q}"`); i = asked.length; break; }
      }
    }
  }
  return { id: scenario.id, passed: failures.length === 0, failures, refusals: observed.refusals, outcome: state.outcome, spoken, transcript, tools: observed.tools, calls: observed.calls, timings: observed.timings, callId, ms: Math.round(performance.now() - started) };
}

/**
 * The first seconds of a call whose voice says nothing until it is told to greet, run through the real call runner on
 * real timers: how long until the greeting was asked for (null: never, within 4 s). The voice then greets, once, and the
 * runner is stopped so the scripted turns run on their own.
 */
async function silentStart(agent: CallAgent, greeting: string, log: ReturnType<typeof createLogger>): Promise<number | null> {
  let deliver: (e: SidebandEvent) => void = () => {};
  let closed: (code: number) => void = () => {};
  let started = 0;
  let greeted: number | null = null;
  let told = 0;
  const done = new Promise<void>((resolve) => {
    const engine = { name: 'eval', accept: async () => {}, startBrowserCall: async () => ({ sessionId: '', sdpAnswer: '' }), reject: async () => {}, attach: () => { throw new Error('unused'); }, transfer: async () => {}, hangup: async () => {} } satisfies VoiceEngine;
    const runner = new CallRunner('eval_silent_start', engine, {
      send: (e) => {
        const c = e as { type: string; content?: string };
        if (c.type !== 'session.instructions.append' || !/greet them now/i.test(c.content ?? '')) return;
        told++;
        if (greeted !== null) return;
        greeted = Math.round(performance.now() - started);
        deliver({ type: 'session.output_transcript.delta', event_id: 'eval_greeting', delta: greeting, start_ms: 0, end_ms: 800 });
        // a moment later, to see that it is asked for once only
        setTimeout(() => { closed(1000); resolve(); }, 1500);
      },
      onEvent: (h) => { deliver = h; },
      onError: () => {},
      onClose: (h) => { closed = h; },
      close: () => {},
    }, agent, { appendSegment: async () => {}, close: async () => {} }, log);
    started = performance.now();
    void runner.start();
    setTimeout(() => { if (greeted === null) { closed(1000); resolve(); } }, 4000);
  });
  await done;
  return told > 1 ? Number.POSITIVE_INFINITY : greeted;
}

/** The first names in a number's household, as the pet page shows it: one record on the number, then its household. */
async function householdOf(db: Database, cipher: PhiCipher, clinicId: string, phone: string): Promise<string[]> {
  const [one] = await withClinic(db, clinicId, (tx) => tx.select({ id: schema.patients.id }).from(schema.patients)
    .where(and(eq(schema.patients.clinicId, clinicId), eq(schema.patients.phoneHash, cipher.hash(phoneKey(clinicId, phone))))).limit(1));
  if (!one) return [];
  const profile = await new PatientRecords(db, cipher).profile(clinicId, one.id, 'eval');
  return profile ? [profile.firstName, ...profile.household.map((h) => h.firstName)] : [];
}

/** A log line at error level or above, as "message: the error's message". */
function loggedError(line: string, into: string[]) {
  try {
    const entry = JSON.parse(line) as { level?: number; msg?: string; err?: { message?: string } };
    if ((entry.level ?? 0) >= 50) into.push([entry.msg, entry.err?.message].filter(Boolean).join(': '));
  } catch { /* not a JSON line */ }
}

/** One scenario in its own fresh in-process Postgres, so no scenario can affect another. */
export async function runScenario(scenario: Scenario, livePlanner?: Planner, followUp?: FollowUp): Promise<ScenarioResult> {
  const t = await openTestDatabase();
  try {
    const cipher = createPhiCipher(TEST_DATA_KEY);
    const { patientIds } = await SEEDS[scenario.clinic](t.db, cipher);
    if (scenario.tags.includes('knowledge')) await seedDemoKnowledge(t.db, new LocalEmbedder());
    return await playScenario(t.db, cipher, patientIds, scenario, { livePlanner, followUp });
  } finally {
    await t.close();
  }
}
