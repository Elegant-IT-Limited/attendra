import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Outbound, ResponsesPlanner } from '../src';

const commentary = (out: Outbound[]) => out.flatMap((o) => (o.type === 'commentary' ? [o.content] : [])).join(' ');
import { world } from './support';

// one database for the file, started once, with room for a busy machine: from the repo
// root and from this package's own folder alike
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); }, 60_000);
afterAll(() => w.t.close());

describe('the production planner', () => {
  it('sends store off, a timeout and an output ceiling on every round', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Done.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test');
    const c = await w.call();
    await c.delegate([], planner);
    const [body, options] = create.mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
    expect(body).toMatchObject({ model: 'gpt-test', store: false, max_output_tokens: 1000 });
    expect(options).toEqual({ timeout: 15_000, maxRetries: 1 });
  });

  it('after its last round, creates the callback it promises, or asks for a number when there is none', async () => {
    // a model that only ever calls a tool, so the rounds run out
    const create = vi.fn(async () => ({ output: [{ type: 'function_call', name: 'get_clinic_info', call_id: 'c1', arguments: '{"question":"hours"}' }], output_text: '' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test', 2);
    const withNumber = await w.call('+13035550147');
    const said = await withNumber.delegate([], planner);
    expect(commentary(said)).toContain('asked someone from the clinic to call you back');
    const tasks = (await w.t.db.execute(sql`select type from tasks where call_id = ${withNumber.callId}`)).rows;
    expect(tasks).toEqual([{ type: 'callback' }]);
    const noNumber = await w.call(null);
    const asked = await noNumber.delegate([], planner);
    expect(commentary(asked)).toContain('tell me the best number');
    expect((await w.t.db.execute(sql`select type from tasks where call_id = ${noNumber.callId}`)).rows).toEqual([]);
  });
});
