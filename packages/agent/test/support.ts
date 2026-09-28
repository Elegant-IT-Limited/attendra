import { DEMO_CLINIC, type Messenger, zonedInstant } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import { Writable } from 'node:stream';
import { CallAgent, CallState, type Planner, type PlannerInput, ScriptedPlanner, type ScriptedStep } from '../src';

// Monday 28 September 2026, 8 pm in Denver: after hours, the case the product is for.
export const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
export const quietLogger = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });

/** Hands each delegation the next scripted plan, like a model deciding turn by turn. */
class PlanQueue implements Planner {
  readonly queue: Planner[] = [];
  plan(input: PlannerInput, execute: Parameters<Planner['plan']>[1]) {
    const next = this.queue.shift();
    if (!next) throw new Error('test forgot to queue a plan');
    return next.plan(input, execute);
  }
}

export async function world() {
  const t = await openTestDatabase();
  const cipher = createPhiCipher(TEST_DATA_KEY);
  const { patientIds } = await seedDemo(t.db, cipher);
  const sms: { to: string; template: string }[] = [];
  const messenger: Messenger = { async sendTemplate(_clinic, m) { sms.push({ to: m.to, template: m.template }); } };
  const backend = {
    patients: new PostgresPatientDirectory(t.db, cipher),
    scheduler: new BuiltinScheduler(t.db),
    tasks: new PostgresTaskQueue(t.db, cipher),
    audit: new PostgresAuditLog(t.db),
    messenger,
  };
  const calls = new CallRepository(t.db, cipher);
  let n = 0;

  async function call(callerNumber: string | null = '+13035550147') {
    const callId = await calls.open(DEMO_CLINIC.id, `live_test_${++n}`, callerNumber);
    const state = new CallState();
    const plans = new PlanQueue();
    const agent = new CallAgent(state, { clinic: DEMO_CLINIC, callId, callerNumber, now: () => NOW }, backend, plans, quietLogger);
    let clock = 0;
    let delegations = 0;
    return {
      state, agent, callId,
      /** A whole caller turn, with timestamps that move forward like a real call. */
      caller: (text: string) => { clock += 1000; return agent.onCallerTranscript(text, clock, clock + 900); },
      assistant: (text: string) => { clock += 1000; agent.onAgentTranscript(text, clock, clock + 900); },
      /** GPT-Live delegates; the next scripted plan answers. */
      delegate: async (steps: ScriptedStep[], planner?: Planner) => {
        const scripted = new ScriptedPlanner(steps);
        plans.queue.push(planner ?? scripted);
        const out = await agent.onDelegation(`item_${++delegations}`);
        // errors are the refusal codes runTool returned, in call order
        return Object.assign(out, { errors: scripted.results.map((r) => r.data.error ?? null) });
      },
    };
  }
  return { t, backend, patientIds, call, sms };
}
