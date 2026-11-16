import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResponsesPlanner } from '../src';
import { world } from './support';

// Foundation A, item 5: the planner path's facts come from core callFacts, built by the call itself at each turn, like
// the tools path's and Vapi's. Made-up caller; the demo clinic (Denver) is open 08:00 to 12:00 and 13:00 to 17:00 on
// a Tuesday.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); }, 60_000);
afterAll(() => w.t.close());

const sent = async (local: string, caller: string | null) => {
  const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Sure.' }));
  const c = await w.call(caller, { now: zonedInstant('2026-09-29', local, DEMO_CLINIC.timezone) });
  c.caller('Hi, are you open?');
  await c.delegate([], new ResponsesPlanner({ responses: { create } } as never, 'gpt-test'));
  const body = create.mock.calls[0]![0] as { instructions: string; input: { content: string }[] };
  return { instructions: body.instructions, input: body.input[0]!.content };
};

describe('the planner path sends the call facts', () => {
  it('today\'s date and hours in the rules, the clinic time with open or closed and the next opening at the end, and the caller ID', async () => {
    const open = await sent('10:14', '+13035550147');
    expect(open.instructions).toContain('Today is Tuesday, 2026-09-29. Today the clinic is open 08:00 to 12:00 and 13:00 to 17:00.');
    expect(open.input).toContain('The time now: 10:14 clinic time. The clinic is open now, until 12:00.');
    expect(open.input).toContain('Caller ID shows the number they are calling from: phone null uses it');
    // the lunch break: closed, and open again the same day
    const lunch = await sent('12:30', null);
    expect(lunch.input).toContain('The time now: 12:30 clinic time. The clinic is closed now; it next opens today at 13:00.');
    expect(lunch.input).toContain('There is no caller ID on this call');
    // the evening: the next opening is tomorrow's
    const evening = await sent('19:00', null);
    expect(evening.input).toContain('The time now: 19:00 clinic time. The clinic is closed now; it next opens Wednesday, 2026-09-30 at 08:00.');
  });
});
