import { CallAgent, CallState, type Planner, ScriptedPlanner, PROGRESS_NOTE } from '@attendra/agent';
import { DEMO_CLINIC, INDUSTRY_PACKS, RIVERBEND_CLINIC, Texting, zonedInstant } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CallRunner, conversationPrompt, type Sideband, type SidebandEvent, type VoiceEngine } from '../src';

const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);

function harness(planner: Planner) {
  const sent: unknown[] = [];
  const engine = { name: 'fake', accept: vi.fn(), startBrowserCall: vi.fn(), reject: vi.fn(), attach: vi.fn(), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } satisfies VoiceEngine;
  const sideband: Sideband = { send: (e) => sent.push(e), onEvent: () => {}, onError: () => {}, onClose: () => {}, close: vi.fn() };
  const segments: { speaker: string; text: string }[] = [];
  const closes: unknown[] = [];
  const backend = {
    patients: { findByNameAndDob: vi.fn() }, scheduler: { busy: vi.fn(), book: vi.fn(), cancel: vi.fn(), upcoming: vi.fn() },
    tasks: { create: vi.fn() }, audit: { record: vi.fn(async () => {}) }, messenger: { sendTemplate: vi.fn() },
  };
  const agent = new CallAgent(new CallState(), { clinic: DEMO_CLINIC, callId: 'call_1', callerNumber: null, now: () => NOW }, backend as never, planner, log);
  const runner = new CallRunner('live_1', engine, sideband, agent, {
    appendSegment: async (s) => { segments.push({ speaker: s.speaker, text: s.text }); },
    close: async (c) => { closes.push(c); },
  }, log);
  return { runner, sent, engine, segments, closes, sideband };
}

const delta = (type: 'in' | 'out', id: string, text: string, at: number): SidebandEvent => ({
  type: type === 'in' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', event_id: id, delta: text, start_ms: at, end_ms: at + 400,
});

describe('the GPT-Live call runner', () => {
  it('answers a delegation with thinking then commentary on the same delegation id', async () => {
    const h = harness(new ScriptedPlanner([{ tool: 'get_clinic_info', args: { question: 'do you take my insurance' } }], (r) => String(r[0]!.data.answer)));
    await h.runner.handle(delta('in', 'e1', 'Do you take Aetna?', 100));
    await h.runner.handle({ type: 'session.delegation.created', event_id: 'e2', delegation: { id: 'item_9', target: 'client' } });
    expect(h.sent).toEqual([
      { type: 'session.thinking.append', event_id: expect.any(String), delegation_id: 'item_9', content: PROGRESS_NOTE },
      { type: 'session.commentary.append', event_id: expect.any(String), delegation_id: 'item_9', content: expect.stringContaining('Aetna') },
    ]);
  });

  it('ignores a replayed event instead of running the delegation twice', async () => {
    const plan = vi.fn(async () => ({ say: 'ok' }));
    const h = harness({ plan });
    const created: SidebandEvent = { type: 'session.delegation.created', event_id: 'e7', delegation: { id: 'item_1', target: 'client' } };
    await h.runner.handle(created);
    await h.runner.handle(created);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('sends the emergency instruction with a null delegation id and transfers after the script', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('in', 'e1', 'my wife is not breathing', 100));
    expect(h.sent[0]).toMatchObject({ type: 'session.instructions.append', delegation_id: null });
    expect(h.engine.transfer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.engine.transfer).toHaveBeenCalledWith('live_1', 'tel:+13035550199');
    vi.useRealTimers();
  });

  it('offers a callback when a transfer fails, and says the emergency number again during an emergency', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    h.engine.transfer.mockRejectedValueOnce(new Error('sip 503'));
    await h.runner.handle(delta('in', 'e1', 'my wife is not breathing', 100));
    await h.runner.handle(delta('out', 'e2', 'If this is a medical emergency, please hang up and call 911 right away.', 600));
    await vi.advanceTimersByTimeAsync(8000);
    const said = h.sent.map((e) => (e as { content: string }).content);
    expect(said).toHaveLength(3);
    expect(said[1]).toContain('transfer did not go through');
    expect(said[1]).toContain('create_callback');
    expect(said[2]).toBe(said[0]); // the emergency script, again
    vi.useRealTimers();
  });

  it('hangs up only once the assistant has finished its goodbye', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.act([{ type: 'hangup', afterMs: 3500 }]);
    // the goodbye is still being spoken when the 3.5 seconds are up
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await h.runner.handle(delta('out', `o${i}`, 'goodbye ', 1000 * i));
    }
    expect(h.engine.hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.engine.hangup).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('waits for a goodbye that arrived as text all at once to be heard, and drops a second hang-up', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    // about 6 s of speech arrives in one piece, long before its audio has played
    await h.runner.handle(delta('out', 'o1', 'Thank you for calling Riverbend Animal Hospital. Take good care of Biscuit, goodbye.', 0));
    await h.runner.act([{ type: 'hangup', afterMs: 3500 }]);
    await h.runner.act([{ type: 'hangup', afterMs: 3500 }]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.engine.hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.engine.hangup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.engine.hangup).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('transfers a VIP caller only once the assistant has finished speaking', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.act([{ type: 'transfer', uri: 'tel:+13035550101', afterMs: 6000, quiet: true }]);
    // the greeting and the line run past the 6 seconds
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await h.runner.handle(delta('out', `v${i}`, 'connecting you ', 1000 * i));
    }
    expect(h.engine.transfer).not.toHaveBeenCalled();
    // and once its audio has played (the words arrived a little faster than they are spoken)
    await vi.advanceTimersByTimeAsync(3500);
    expect(h.engine.transfer).toHaveBeenCalledWith('live_1', 'tel:+13035550101');
    vi.useRealTimers();
  });

  it('records a call staff ended as ended_by_staff, not as the assistant hanging up', async () => {
    const h = harness(new ScriptedPlanner([]));
    await h.runner.act((h.runner as unknown as { agent: CallAgent }).agent.endByStaff());
    await h.runner.handle({ type: 'session.closed', event_id: 'e9', reason: 'agent_hangup', usage: { seconds: 30 } } as SidebandEvent);
    expect(h.closes.at(-1)).toMatchObject({ reason: 'ended_by_staff' });
  });

  it('keeps agent_hangup for a call the assistant ended itself', async () => {
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle({ type: 'session.closed', event_id: 'e9', reason: 'agent_hangup', usage: { seconds: 30 } } as SidebandEvent);
    expect(h.closes.at(-1)).toMatchObject({ reason: 'agent_hangup' });
  });

  it('stores whole turns and closes the call with final usage and outcome', async () => {
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('out', 'o1', 'Thanks for calling Maple Street.', 0));
    await h.runner.handle(delta('in', 'i1', 'What are', 1000));
    await h.runner.handle(delta('in', 'i2', 'your hours?', 1500));
    await h.runner.handle({ type: 'session.closed', event_id: 'c1', reason: 'remote_hangup', usage: { seconds: 42.5 } });
    expect(h.segments).toEqual([
      { speaker: 'agent', text: 'Thanks for calling Maple Street.' },
      { speaker: 'caller', text: 'What are your hours?' },
    ]);
    expect(h.closes).toEqual([{ reason: 'remote_hangup', voiceSeconds: 42.5, outcome: 'abandoned', emergency: false, language: 'en' }]);
    expect(h.sideband.close).toHaveBeenCalled();
  });
});

it('counts the call as over when the socket drops and the final write fails', async () => {
  const engine = { name: 'fake', accept: vi.fn(), startBrowserCall: vi.fn(), reject: vi.fn(), attach: vi.fn(), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } satisfies VoiceEngine;
  let drop: (code: number) => void = () => {};
  const sideband: Sideband = { send: vi.fn(), onEvent: () => {}, onError: () => {}, onClose: (h) => { drop = h; }, close: vi.fn() };
  const agent = new CallAgent(new CallState(), { clinic: DEMO_CLINIC, callId: 'call_1', callerNumber: null, now: () => NOW }, {} as never, new ScriptedPlanner([]), log);
  const runner = new CallRunner('live_1', engine, sideband, agent, { appendSegment: async () => {}, close: async () => { throw new Error('db down'); } }, log);
  const done = runner.start();
  drop(1006);
  await expect(done).resolves.toBeUndefined();
});

describe('the conversation prompt', () => {
  it('sounds like a front desk by default, and follows the clinic\'s pace, style and acknowledgements', () => {
    const plain = conversationPrompt(DEMO_CLINIC, NOW);
    expect(plain).toContain('short turns of one or two sentences');
    expect(plain).toContain('Speak at a natural, conversational pace.');
    expect(plain).toContain('one moment while I check');
    const set = conversationPrompt({ ...DEMO_CLINIC, talk: { pace: 'relaxed', style: 'professional', acknowledgements: false } }, NOW);
    expect(set).toContain('relaxed, unhurried pace');
    expect(set).toContain('calm and professional');
    expect(set).toContain('without filler acknowledgements');
    expect(set).not.toContain('one moment while I check');
  });

  it('switches to another language with that language\'s greeting, and mentions texts only when the clinic texts', () => {
    const own = 'Gracias por llamar. Soy Maya, la asistente virtual. ¿En qué le puedo ayudar?';
    expect(conversationPrompt({ ...DEMO_CLINIC, greetings: { es: own } }, NOW)).toContain(`If the caller speaks Spanish, switch to it and introduce yourself once with exactly: "${own}"`);
    expect(conversationPrompt(DEMO_CLINIC, NOW)).not.toMatch(/text the caller/i);
    expect(conversationPrompt({ ...DEMO_CLINIC, texting: Texting.parse({ enabled: true }) }, NOW)).toMatch(/You can text the caller/);
  });

  it('carries the greeting, the AI disclosure and today\'s hours, and nothing about any patient', () => {
    const prompt = conversationPrompt(DEMO_CLINIC, NOW);
    expect(prompt).toContain("I'm Maya, the clinic's AI assistant");
    expect(prompt).toContain('The clinic is closed right now.');
    expect(prompt).toMatch(/never give medical advice/i);
  });

  it('names the assistant, says it is an AI, and lists only the clinic\'s languages', () => {
    const prompt = conversationPrompt(DEMO_CLINIC, NOW);
    expect(prompt).toContain("You are Maya, the clinic's AI assistant.");
    expect(prompt).toContain('Never claim to be a person.');
    expect(prompt).toContain('Speak English. You may also speak Spanish if the caller does');
    expect(prompt).toContain('usted');
    expect(prompt).not.toMatch(/attendra/i);
  });

  it('falls back to a plain name when none is set, and speaks only English at an English-only clinic', () => {
    const prompt = conversationPrompt({ ...DEMO_CLINIC, assistantName: undefined, languages: ['en'], primaryLanguage: 'en' }, NOW);
    expect(prompt).toContain("You are the clinic's AI assistant.");
    expect(prompt).not.toMatch(/Spanish|attendra/i);
  });

  it('at a veterinary clinic, asks which pet, finds it by owner and name, and gives no advice about animals', () => {
    const prompt = conversationPrompt(RIVERBEND_CLINIC, NOW);
    expect(prompt).toContain("I'm Juniper, the clinic's AI assistant");
    expect(prompt).toContain('ask which pet the visit is for');
    expect(prompt).toContain("the owner's full name, the pet's name and the phone number on file");
    expect(prompt).toContain('Never give medical or first-aid advice for an animal');
    expect(prompt).toContain('the veterinarians or clinic facts');
    expect(prompt).not.toMatch(/date of birth|female or a male doctor/);
  });

  it('takes the words and the trade-specific lines from the account\'s industry pack', () => {
    const pack = INDUSTRY_PACKS.clinic;
    const saved = { terms: pack.terms, prompt: pack.prompt };
    try {
      pack.terms = { business: 'shop', patient: 'customer', patients: 'customers', provider: 'stylist', providers: 'stylists' };
      pack.prompt = { identify: ['IDENTIFY LINE'], preferences: ['PREFERENCE LINE'], limits: ['LIMIT LINE'] };
      const prompt = conversationPrompt(DEMO_CLINIC, NOW);
      expect(prompt).toContain("the shop's AI assistant");
      expect(prompt).toContain('the stylists or shop facts');
      expect(prompt).toMatch(/IDENTIFY LINE[\s\S]*PREFERENCE LINE[\s\S]*LIMIT LINE/);
      expect(prompt).not.toMatch(/the doctors or clinic facts|female or a male doctor|medical advice/);
    } finally {
      Object.assign(pack, saved);
    }
  });
});

describe('a caller is never left in silence, and a goodbye ends the call', () => {
  it('tells the assistant to answer when the caller finished and nothing came back, twice at most', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('in', 'e1', 'Hi, I would like to book a visit.', 100));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sent).toEqual([{ type: 'session.instructions.append', event_id: expect.any(String), delegation_id: null, content: expect.stringContaining('waiting for you. Answer them now') }]);
    await vi.advanceTimersByTimeAsync(8000);
    expect((h.sent[1] as { content: string }).content).toContain('Apologise briefly for the wait');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sent).toHaveLength(2);
    vi.useRealTimers();
  });

  it('is not fooled by the caller\'s words arriving while the reply is still being spoken', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    // the reply's words arrive at once, its audio plays for several seconds, and the caller's
    // words before it are transcribed late: the caller is listening, not waiting
    await h.runner.handle(delta('out', 'e1', 'Sure. I can add Biscuit as a new patient. First, I need the owner\'s full name. What is it?', 100));
    await vi.advanceTimersByTimeAsync(1500);
    await h.runner.handle(delta('in', 'e2', 'He is a new patient.', 1600));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.sent.filter((e) => (e as { type: string }).type === 'session.instructions.append')).toEqual([]);
    vi.useRealTimers();
  });

  it('says nothing while the assistant is answering, or while a tool is at work', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const h = harness({ plan: () => new Promise((resolve) => { release = () => resolve({ say: 'done' }); }) });
    await h.runner.handle(delta('in', 'e1', 'What time do you close?', 100));
    await h.runner.handle(delta('out', 'e2', 'We close at five.', 900));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sent).toHaveLength(0);
    await h.runner.handle(delta('in', 'e3', 'And can I book Tuesday?', 2000));
    const running = h.runner.handle({ type: 'session.delegation.created', event_id: 'e4', delegation: { id: 'item_1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(10_000);
    // only the agent's own notes for the delegation, never a silence nudge
    expect(h.sent.every((e) => (e as { type: string }).type !== 'session.instructions.append')).toBe(true);
    release();
    await running;
    vi.useRealTimers();
  });

  it('ends the call when the assistant said goodbye and the line stayed quiet, but not if the caller speaks', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('out', 'e0', 'You are booked for Tuesday at nine. Is there anything else I can help you with?', 50));
    await vi.advanceTimersByTimeAsync(7000); // the question is spoken
    await h.runner.handle(delta('in', 'e1', 'No, that is all, thanks.', 100));
    await h.runner.handle(delta('out', 'e2', 'You are welcome. Have a great day!', 800));
    // 6 seconds after the goodbye has been spoken, not after its words arrived
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.engine.hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.engine.hangup).toHaveBeenCalledTimes(1);

    const other = harness(new ScriptedPlanner([]));
    await other.runner.handle(delta('out', 'e0', 'Is there anything else I can help you with?', 50));
    await vi.advanceTimersByTimeAsync(4000);
    await other.runner.handle(delta('in', 'e1', 'Thanks.', 100));
    await other.runner.handle(delta('out', 'e2', 'Goodbye.', 800));
    await vi.advanceTimersByTimeAsync(2000);
    await other.runner.handle(delta('in', 'e3', 'Oh wait, one more thing.', 3000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(other.engine.hangup).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps the first version\'s rule: no hang-up after a goodbye unless "anything else?" was asked and the caller said no', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    // the assistant wrapped up on its own, without asking: the caller may still have something
    await h.runner.handle(delta('in', 'e1', 'Okay, Tuesday at nine works.', 100));
    await h.runner.handle(delta('out', 'e2', 'Great, see you Tuesday. Have a great day!', 800));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.engine.hangup).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
