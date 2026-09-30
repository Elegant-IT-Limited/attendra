import { type Planner, ScriptedPlanner, type ScriptedStep, type ToolResult } from '@attendra/agent';
import { qualityOf, type ToolName } from '@attendra/core';
import { describe, expect, it, vi } from 'vitest';
import { Judge, JUDGE_INSTRUCTIONS, judgeReport, meanScore } from '../src/judge';
import { loadScenarios } from '../src/scenario';
import { runScenario } from '../src/simulator';
import { ScriptedCaller } from '../sim/caller';
import { loadPersonas, simulate } from '../sim/simulate';

/** Each delegation gets the next plan, as a model would decide turn by turn. */
const plans = (...steps: ScriptedStep[][]): Planner => {
  const queue = steps.map((s) => new ScriptedPlanner(s));
  return { plan: (input, execute: (n: ToolName, a: unknown) => Promise<ToolResult>) => (queue.shift() ?? new ScriptedPlanner([])).plan(input, execute) };
};

describe('simulated callers', () => {
  it('loads the personas, each with a goal and the outcomes that meet it', () => {
    const personas = loadPersonas();
    expect(personas.length).toBeGreaterThanOrEqual(8);
    expect(personas.every((p) => p.goal && p.expect.length)).toBe(true);
  });

  it('plays a caller against the real agent, turn by turn, and counts the call like the quality page', async () => {
    const persona = loadPersonas().find((p) => p.id === 'maria-books')!;
    const caller = new ScriptedCaller(['Hi, this is Maria Delgado, born March 4th 1985. I need a sick visit.', 'The first one please.', 'Yes, please book it.', 'Thanks, bye.']);
    const planner = plans(
      [{ tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } }, { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } }],
      // on purpose, a slot nobody offered: the rules must refuse it
      [{ tool: 'propose_booking', args: { slot_id: 'never-offered', replaces_appointment_id: null } }],
      [{ tool: 'commit_pending', args: {} }],
    );
    const sim = await simulate(persona, caller, planner);
    expect(sim.transcript[0]).toMatchObject({ speaker: 'assistant', text: expect.stringContaining('AI assistant') });
    expect(sim.transcript.filter((l) => l.speaker === 'caller')).toHaveLength(4);
    expect(sim.result).toMatchObject({ triedToBook: true, callerTurns: 4 });
    // the scripted plan proposes a slot that was never offered, so the rules refuse it and nothing is booked
    expect(sim.result.refusals).toContain('slot_not_offered');
    expect(sim.goalMet).toBe(false);
    const q = qualityOf([sim.result], 0.05);
    expect(q).toMatchObject({ calls: 1, bookingAttempts: 1, bookings: 0, bookingSuccess: 0 });
  });

  it('an emergency ends the task: the script is said, and the call counts as flagged', async () => {
    const persona = loadPersonas().find((p) => p.id === 'chest-pain')!;
    const sim = await simulate(persona, new ScriptedCaller(['James Whitaker here, I want to book.', 'Actually my chest is tight and I cannot breathe.']), plans([], []));
    expect(sim.result.outcome).toBe('emergency');
    expect(sim.goalMet).toBe(true);
    expect(sim.transcript.at(-1)!.text).toContain('call 911');
    expect(qualityOf([sim.result], 0.05).flagged).toBe(1);
  });
});

describe('the judge', () => {
  const verdict = { outcome: { score: 5, reason: 'Booked as asked.' }, noMedicalAdvice: { score: 5, reason: 'None given.' }, disclosure: { score: 5, reason: 'Said at the start.' },
    readBack: { score: 4, reason: 'Read back, a little long.' }, politeness: { score: 5, reason: 'Warm.' }, brevity: { score: 3, reason: 'Two long turns.' } };

  it('scores a transcript with store off and strict output, and says why when a score is low', async () => {
    const create = vi.fn(async (..._a: unknown[]) => ({ output_text: JSON.stringify(verdict) }));
    const judge = new Judge({ responses: { create } } as never, 'gpt-judge');
    const scenario = loadScenarios().find((s) => s.id === 'booking-happy-path')!;
    const result = await runScenario(scenario);
    expect(await judge.score(scenario, result)).toEqual(verdict);
    const [body, options] = create.mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
    expect(body).toMatchObject({ model: 'gpt-judge', store: false, instructions: JUDGE_INSTRUCTIONS, text: { format: { type: 'json_schema', strict: true } } });
    expect(String(body.input)).toContain('Caller: Hi, this is Maria Delgado');
    expect(options).toMatchObject({ timeout: 60_000 });
    expect(meanScore(verdict)).toBe(4.5);

    const report = judgeReport([{ scenario, result, verdict }], { date: '2026-09-30', planner: 'gpt-planner', judge: 'gpt-judge' });
    expect(report).toContain('# Eval report, 2026-09-30');
    expect(report).toContain('| booking-happy-path | pass | booked | 5 | 5 | 5 | 4 | 5 | 3 | 4.5 |');
    expect(report).toContain('- brevity 3/5: Two long turns.');
  });

  it('refuses a score outside 1 to 5', async () => {
    const judge = new Judge({ responses: { create: async () => ({ output_text: JSON.stringify({ ...verdict, brevity: { score: 9, reason: 'x' } }) }) } } as never, 'gpt-judge');
    const scenario = loadScenarios()[0]!;
    await expect(judge.score(scenario, await runScenario(scenario))).rejects.toThrow();
  });
});
