import type { CallForSummary } from '@attendra/db';
import { describe, expect, it, vi } from 'vitest';
import { JobError, LocalSummariser, ModelSummariser, SUMMARY_INSTRUCTIONS } from '../src/summarise';

const CALL: CallForSummary = {
  callId: '00000000-0000-4000-8000-000000000001', clinicId: 'clinic_demo_maple', channel: 'phone', outcome: 'booked', emergency: false, closeReason: 'caller_hangup',
  transcript: [
    { speaker: 'agent', text: 'Thanks for calling. I\'m Maya, the clinic\'s AI assistant.' },
    { speaker: 'caller', text: 'Hi, this is Maria Delgado, born March 4th 1985. My knee hurts.' },
    { speaker: 'caller', text: 'Yes, please book it.' },
  ],
  actions: [{ tool: 'verify_caller', result: { ok: true, verified: true } }, { tool: 'commit_pending', result: { ok: true, booked: true } }],
  tasks: [],
};

const GOOD = { summary: 'The caller booked a sick visit for a sore knee. The assistant texted a confirmation.', intent: 'book', sentiment: 'calm', needsReview: false, reviewReason: null, followUp: null };

/** An OpenAI client that answers with a fixed output and remembers what it was asked. */
function fixed(output: unknown, extra: Record<string, unknown> = {}) {
  const create = vi.fn(async (..._args: unknown[]) => ({ status: 'completed', output_text: typeof output === 'string' ? output : JSON.stringify(output), ...extra }));
  return { client: { responses: { create } } as never, create };
}

describe('the model summariser', () => {
  it('asks for strict structured output, with store off, a timeout and ceilings on input and output', async () => {
    const { client, create } = fixed(GOOD);
    const s = new ModelSummariser(client, 'gpt-test-model');
    expect(await s.summarise(CALL)).toEqual(GOOD);
    const [body, options] = create.mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
    expect(body).toMatchObject({ model: 'gpt-test-model', store: false, max_output_tokens: 500, instructions: SUMMARY_INSTRUCTIONS });
    expect(body.text).toMatchObject({ format: { type: 'json_schema', strict: true, name: 'call_summary' } });
    expect(options).toEqual({ timeout: 30_000, maxRetries: 0 });
    expect(String(body.input)).toContain('Caller: Yes, please book it.');
  });

  it('tells the model to summarise only what was said, with no medical advice or diagnosis', () => {
    expect(SUMMARY_INSTRUCTIONS).toContain('Summarise only what was said and done on the call.');
    expect(SUMMARY_INSTRUCTIONS).toContain('Do not add medical advice, diagnoses');
  });

  it('keeps the start and the end of a very long call, and nothing past the ceiling', async () => {
    const { client, create } = fixed(GOOD);
    const long = { ...CALL, transcript: Array.from({ length: 2000 }, (_, i) => ({ speaker: 'caller' as const, text: `line ${i} of a long call` })) };
    await new ModelSummariser(client, 'm', { timeoutMs: 1000, maxOutputTokens: 100, maxTranscriptChars: 2000 }).summarise(long);
    const input = String((create.mock.calls[0]![0] as { input: string }).input);
    expect(input).toContain('line 0 of');
    expect(input).toContain('line 1999 of');
    expect(input).toContain('[...]');
    expect(input.length).toBeLessThan(3000);
  });

  it('refuses output that is not the agreed shape, with a code and no content', async () => {
    const cases: [unknown, string][] = [
      ['not json at all', 'summary_not_json'],
      [{ ...GOOD, intent: 'diagnosis' }, 'summary_invalid'],
      [{ ...GOOD, advice: 'take ibuprofen' }, 'summary_invalid'],
      [{ ...GOOD, needsReview: true, reviewReason: null }, 'summary_invalid'],
      [{ ...GOOD, summary: 'x'.repeat(601) }, 'summary_invalid'],
    ];
    for (const [output, code] of cases) {
      const err = await new ModelSummariser(fixed(output).client, 'm').summarise(CALL).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).message).toBe(code);
    }
    const cut = await new ModelSummariser(fixed(GOOD, { status: 'incomplete' }).client, 'm').summarise(CALL).catch((e: Error) => e.message);
    expect(cut).toBe('summary_model_incomplete');
  });

  it('reports a failed request by its status only, never the request', async () => {
    const client = { responses: { create: vi.fn(async () => { throw Object.assign(new Error('400 bad request: Hi, this is Maria Delgado, born March 4th 1985'), { status: 400 }); }) } } as never;
    const err = (await new ModelSummariser(client, 'm').summarise(CALL).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('summary_model_http_400');
    expect(String(err.stack)).not.toContain('Maria');
  });

  it('always flags an emergency call, whatever the model decided', async () => {
    const s = await new ModelSummariser(fixed({ ...GOOD, intent: 'question' }).client, 'm').summarise({ ...CALL, emergency: true, outcome: 'emergency' });
    expect(s).toMatchObject({ intent: 'emergency', needsReview: true, reviewReason: 'Emergency language on the call.' });
  });
});

describe('the local summariser', () => {
  const local = new LocalSummariser();

  it('describes a booking from the call\'s facts', async () => {
    expect(await local.summarise(CALL)).toEqual({
      summary: 'The caller was verified by name and date of birth. The assistant booked an appointment after the caller confirmed it.',
      intent: 'book', sentiment: 'calm', needsReview: false, reviewReason: null, followUp: null,
    });
  });

  it('flags an emergency, a caller it could not verify, and a shared identity', async () => {
    expect(await local.summarise({ ...CALL, outcome: 'emergency', emergency: true, actions: [{ tool: 'transfer_call', result: { ok: true, transferring: 'on_call' } }] }))
      .toMatchObject({ intent: 'emergency', sentiment: 'distressed', needsReview: true, reviewReason: 'Emergency language on the call.' });
    const unverified = await local.summarise({ ...CALL, outcome: 'abandoned', actions: [
      { tool: 'verify_caller', result: { ok: false, error: 'not_verified' } }, { tool: 'verify_caller', result: { ok: false, error: 'not_verified' } },
      { tool: 'verify_caller', result: { ok: false, error: 'not_verified' } }, { tool: 'verify_caller', result: { ok: false, error: 'too_many_attempts' } },
    ] });
    expect(unverified).toMatchObject({ sentiment: 'frustrated', needsReview: true, followUp: 'Call the caller back to confirm who they are.' });
    expect(await local.summarise({ ...CALL, outcome: 'abandoned', actions: [{ tool: 'verify_caller', result: { ok: false, error: 'needs_staff' } }] }))
      .toMatchObject({ needsReview: true, reviewReason: 'Two patient records share the caller\'s name and date of birth.' });
  });

  it('suggests a follow-up for a request the assistant created', async () => {
    const refill = await local.summarise({ ...CALL, outcome: 'task_created', tasks: [{ type: 'refill' }], actions: [{ tool: 'create_refill_request', result: { ok: true } }] });
    expect(refill).toMatchObject({ intent: 'refill', followUp: 'Review the refill request and call the patient if anything is unclear.' });
  });

  it('says which language the caller spoke, and never repeats what they said', async () => {
    const s = await local.summarise({ ...CALL, transcript: [{ speaker: 'caller', text: 'Hola, soy Maria Delgado, quiero una cita para mañana por favor' }] });
    expect(s.summary).toMatch(/^The caller spoke Spanish\./);
    expect(s.summary).not.toContain('Maria');
  });
});
