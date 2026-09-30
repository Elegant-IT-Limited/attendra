import { describe, expect, it, vi } from 'vitest';
import { ResponsesPlanner } from '../src';
import { world } from './support';

describe('the production planner', () => {
  it('sends store off, a timeout and an output ceiling on every round', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Done.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test');
    const w = await world();
    const c = await w.call();
    await c.delegate([], planner);
    const [body, options] = create.mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
    expect(body).toMatchObject({ model: 'gpt-test', store: false, max_output_tokens: 1000 });
    expect(options).toEqual({ timeout: 15_000, maxRetries: 1 });
    await w.t.close();
  });
});
