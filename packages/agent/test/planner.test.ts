import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClinicConfig, DEMO_CLINIC } from '@attendra/core';
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

  it('is told the one name on file to ask "Am I speaking with ...?", and never to offer a text to a number abroad', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Done.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test');
    const texting = ClinicConfig.parse({ ...DEMO_CLINIC, texting: { enabled: true } });
    const known = await w.call('+13035550147', { clinic: texting, history: 'Name on file for this number: Sam.' });
    await known.delegate([], planner);
    const input = JSON.stringify((create.mock.calls[0]![0] as { input: unknown }).input);
    expect(input).toContain('Name on file for this number: Sam.');
    expect(input).toContain('Am I speaking with <that name>?');
    expect(input).toContain('¿Hablo con <that name>?');
    expect(input).not.toContain('cannot get texts');
    const abroad = await w.call('+8801712345678', { clinic: texting });
    await abroad.delegate([], planner);
    expect(JSON.stringify((create.mock.calls.at(-1)![0] as { input: unknown }).input)).toContain('cannot get texts');
  });

  it('sends back, once, an answer that promises to take care of it while nothing waits for a yes (2026-11)', async () => {
    const replies = ['Okay, I\'ll take care of it.', 'I\'ll book that as soon as I\'ve found your pet. What\'s its name?'];
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: replies.shift() }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test');
    const c = await w.call();
    const out = await c.delegate([], planner);
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify((create.mock.calls[1]![0] as { input: unknown }).input)).toContain('nothing is waiting for the caller\'s yes and nothing was done');
    expect(commentary(out)).toBe('I\'ll book that as soon as I\'ve found your pet. What\'s its name?');
  });

  it('asks for the phone the right way: caller ID is confirmed, and with none the best number, once (2026-11)', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Done.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test');
    await (await w.call('+13035550147')).delegate([], planner);
    expect(JSON.stringify((create.mock.calls[0]![0] as { input: unknown }).input)).toContain('Is the number you\'re calling from the best one for you?');
    const browser = await w.call(null, { channel: 'web' });
    await browser.delegate([], planner);
    const input = JSON.stringify((create.mock.calls[1]![0] as { input: unknown }).input);
    expect(input).toContain('There is no caller ID on this call');
    expect(input).toContain('What\'s the best number to reach you?');
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
