// SPDX-License-Identifier: AGPL-3.0-only
import { CallAgent, CallState, type Outbound, type Planner, type PlannerInput, ScriptedPlanner, type ScriptedStep, type ToolResult } from '@attendra/agent';
import { DEMO_CLINIC, type Messenger, type ToolName, zonedInstant } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, schema, seedDemo, withClinic } from '@attendra/db';
import { eq } from 'drizzle-orm';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import { Writable } from 'node:stream';
import type { Scenario } from './scenario';

// Every scenario is a call on Monday 28 September 2026 at 8 pm in Denver: after hours.
export const SIM_NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);

export interface ScenarioResult {
  id: string;
  passed: boolean;
  failures: string[];
  refusals: string[];
  outcome: string;
  spoken: string[];
  tools: string[];
  ms: number;
}

/** Records every tool result the planner saw, so refusals can be checked whichever planner ran. */
class Observed implements Planner {
  readonly tools: string[] = [];
  readonly refusals: string[] = [];
  constructor(private readonly inner: Planner) {}
  plan(input: PlannerInput, execute: (name: ToolName, args: unknown) => Promise<ToolResult>) {
    return this.inner.plan(input, async (name, args) => {
      const r = await execute(name, args);
      this.tools.push(name);
      if (typeof r.data.error === 'string') this.refusals.push(r.data.error);
      return r;
    });
  }
}

/** Replaces "$offered[0]" and "$appointments[0]" with ids the call actually produced. */
function resolve(args: Record<string, unknown>, state: CallState, results: ToolResult[]): Record<string, unknown> {
  const appointments = results.flatMap((r) => (Array.isArray(r.data.appointments) ? (r.data.appointments as { appointment_id: string }[]) : []));
  return Object.fromEntries(Object.entries(args).map(([k, v]) => {
    if (typeof v !== 'string') return [k, v];
    const offered = v.match(/^\$offered\[(\d+)\]$/);
    if (offered) return [k, [...state.offered.keys()][Number(offered[1])] ?? v];
    const appt = v.match(/^\$appointments\[(\d+)\]$/);
    if (appt) return [k, appointments[Number(appt[1])]?.appointment_id ?? v];
    return [k, v];
  }));
}

export async function runScenario(scenario: Scenario, livePlanner?: Planner): Promise<ScenarioResult> {
  const started = performance.now();
  const t = await openTestDatabase();
  try {
    const cipher = createPhiCipher(TEST_DATA_KEY);
    const { patientIds } = await seedDemo(t.db, cipher);
    const scheduler = new BuiltinScheduler(t.db);
    const sms: string[] = [];
    const messenger: Messenger = { async sendTemplate(_c, m) { sms.push(m.template); } };
    const backend = { patients: new PostgresPatientDirectory(t.db, cipher), scheduler, tasks: new PostgresTaskQueue(t.db, cipher), audit: new PostgresAuditLog(t.db), messenger };

    // an existing appointment for Maria, for the reschedule and cancel scenarios
    const setupCall = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'live_setup', null);
    const existing = zonedInstant('2026-10-01', '09:00', DEMO_CLINIC.timezone);
    if (scenario.tags.includes('has-appointment')) {
      await scheduler.book(DEMO_CLINIC.id, { patientId: patientIds.maria!, callId: setupCall, idempotencyKey: 'setup',
        slot: { id: 'setup', providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: existing, end: new Date(existing.getTime() + 20 * 60_000) } });
    }
    const callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, `live_${scenario.id}`, scenario.caller_number);
    const state = new CallState();
    const results: ToolResult[] = [];
    const queue: Planner[] = [];
    const observed = new Observed({ plan: (input, execute) => queue.shift()!.plan(input, execute) });
    const log = createLogger({ name: 'eval', destination: new Writable({ write: (_c, _e, done) => done() }) });
    const agent = new CallAgent(state, { clinic: DEMO_CLINIC, callId, callerNumber: scenario.caller_number, now: () => SIM_NOW }, backend, observed, log);

    const outbound: Outbound[] = [];
    let clock = 0;
    let delegations = 0;
    for (const turn of scenario.turns) {
      clock += 1500;
      if ('assistant' in turn) { agent.onAgentTranscript(turn.assistant, clock, clock + 1000); continue; }
      outbound.push(...agent.onCallerTranscript(turn.caller, clock, clock + 1000));
      if (!turn.delegate && !livePlanner) continue;
      if (state.emergency) break; // the script takes over; nothing else runs on this call
      if (livePlanner) queue.push(livePlanner);
      else {
        const steps: ScriptedStep[] = turn.delegate!.map((step) => {
          const [tool, args] = Object.entries(step)[0]! as [ToolName, Record<string, unknown>];
          return { tool, args: (sofar: ToolResult[]) => resolve(args, state, [...results, ...sofar]) };
        });
        const scripted = new ScriptedPlanner(steps, (r) => { results.push(...r); const last = r.at(-1); return last ? JSON.stringify(last.data) : null; });
        queue.push(scripted);
      }
      const out = await agent.onDelegation(`item_${++delegations}`);
      outbound.push(...out);
      for (const o of out) if (o.type === 'commentary') { clock += 1500; agent.onAgentTranscript(o.content, clock, clock + 1000); }
    }

    const created = (await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.createdByCallId, callId)))).length;
    const spoken = outbound.flatMap((o) => (o.type === 'commentary' || o.type === 'instructions' ? [o.content] : []));
    const transfer = outbound.find((o) => o.type === 'transfer');
    const e = scenario.expect;
    const failures: string[] = [];
    const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };

    check(state.outcome === e.outcome, `outcome ${state.outcome}, expected ${e.outcome}`);
    if (!livePlanner) check(JSON.stringify(observed.refusals) === JSON.stringify(e.refusals), `refusals ${JSON.stringify(observed.refusals)}, expected ${JSON.stringify(e.refusals)}`);
    if (e.verified !== undefined) check(!!state.verifiedPatient === e.verified, `verified ${!!state.verifiedPatient}, expected ${e.verified}`);
    check(created === e.bookings_created, `${created} bookings created, expected ${e.bookings_created}`);
    check(sms.length === e.sms_sent, `${sms.length} texts sent, expected ${e.sms_sent}`);
    check((transfer && transfer.type === 'transfer' ? transfer.uri : null) === e.transfer_to, `transfer to ${transfer && transfer.type === 'transfer' ? transfer.uri : 'nobody'}, expected ${e.transfer_to ?? 'nobody'}`);
    check(outbound.some((o) => o.type === 'instructions') === e.emergency_instruction, `emergency instruction ${outbound.some((o) => o.type === 'instructions')}, expected ${e.emergency_instruction}`);
    for (const phrase of scenario.forbid_spoken) {
      check(!spoken.some((s) => s.toLowerCase().includes(phrase.toLowerCase())), `said the forbidden phrase "${phrase}"`);
    }
    return { id: scenario.id, passed: failures.length === 0, failures, refusals: observed.refusals, outcome: state.outcome, spoken, tools: observed.tools, ms: Math.round(performance.now() - started) };
  } finally {
    await t.close();
  }
}
