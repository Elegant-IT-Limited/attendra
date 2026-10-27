import { CallAgent, CallState, type Planner, ScriptedPlanner, PROGRESS_NOTE } from '@attendra/agent';
import { DEMO_CLINIC, INDUSTRY_PACKS, RIVERBEND_CLINIC, Texting, zonedInstant } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CallRunner, conversationPrompt, type Sideband, type SidebandConnection, type SidebandEvent, type VoiceEngine } from '../src';

const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);

function harness(planner: Planner, logger = log) {
  const sent: unknown[] = [];
  const engine = { name: 'fake', accept: vi.fn(), startBrowserCall: vi.fn(), reject: vi.fn(), attach: vi.fn(), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } satisfies VoiceEngine;
  const sideband: Sideband = { send: (e) => sent.push(e), onEvent: () => {}, onError: () => {}, onClose: () => {}, close: vi.fn() };
  const segments: { speaker: string; text: string }[] = [];
  const closes: unknown[] = [];
  const backend = {
    patients: { findByNameAndDob: vi.fn() }, scheduler: { busy: vi.fn(), book: vi.fn(), cancel: vi.fn(), upcoming: vi.fn() },
    tasks: { create: vi.fn() }, audit: { record: vi.fn(async () => {}) }, messenger: { sendTemplate: vi.fn() },
  };
  const agent = new CallAgent(new CallState(), { clinic: DEMO_CLINIC, callId: 'call_1', callerNumber: null, now: () => NOW }, backend as never, planner, logger);
  const runner = new CallRunner('live_1', engine, sideband, agent, {
    appendSegment: async (s) => { segments.push({ speaker: s.speaker, text: s.text }); },
    close: async (c) => { closes.push(c); },
  }, logger);
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

  it('tells a silent assistant to greet, once, when nobody has spoken 2 s into the call (2026-10-25, 2026-10-26)', async () => {
    vi.useFakeTimers();
    const silent = harness(new ScriptedPlanner([]));
    void silent.runner.start();
    await vi.advanceTimersByTimeAsync(1900);
    expect(silent.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(silent.sent).toEqual([{ type: 'session.instructions.append', event_id: expect.any(String), delegation_id: null, content: expect.stringContaining('greet them now') }]);
    // a caller who spoke over a greeting is answered, never greeted from the top again
    expect((silent.sent[0] as { content: string }).content).toContain('If any part of the greeting was said, or the caller has spoken, never start it again');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(silent.sent).toHaveLength(1);
    // a greeting on time is never nudged
    const greeted = harness(new ScriptedPlanner([]));
    void greeted.runner.start();
    await greeted.runner.handle(delta('out', 'g1', 'Thanks for calling Maple Street.', 100));
    await vi.advanceTimersByTimeAsync(6000);
    expect(greeted.sent).toEqual([]);
    vi.useRealTimers();
  });

  it('ignores a replayed event instead of running the delegation twice, whatever its event id', async () => {
    const plan = vi.fn(async () => ({ say: 'ok' }));
    const h = harness({ plan });
    const created: SidebandEvent = { type: 'session.delegation.created', event_id: 'e7', delegation: { id: 'item_1', target: 'client' } };
    await h.runner.handle(created);
    await h.runner.handle(created);
    await h.runner.handle({ ...created, event_id: 'e8' });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(h.sent.filter((e) => (e as { type: string }).type === 'session.commentary.append')).toHaveLength(1);
  });

  it('answers again, after the sideband came back, a hand-off whose answer the drop lost (and only that one)', async () => {
    vi.useFakeTimers();
    const plan = vi.fn(async () => ({ say: 'We open at eight.' }));
    const h = harness({ plan });
    let connection!: (c: SidebandConnection) => void;
    h.sideband.onConnection = (handler) => { connection = handler; };
    void h.runner.start();
    // a first answer, spoken; then a second one sent just as the socket drops
    await h.runner.handle({ type: 'session.delegation.created', event_id: 'e1', delegation: { id: 'item_1', target: 'client' } });
    await h.runner.handle(delta('out', 'o1', 'We open at eight.', 500));
    await vi.advanceTimersByTimeAsync(3000);
    await h.runner.handle({ type: 'session.delegation.created', event_id: 'e2', delegation: { id: 'item_2', target: 'client' } });
    connection({ state: 'reconnecting', attempt: 1, code: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    connection({ state: 'reconnected' });
    await vi.advanceTimersByTimeAsync(10);
    const answers = () => h.sent.filter((e) => (e as { type: string }).type === 'session.commentary.append').map((e) => (e as { delegation_id: string }).delegation_id);
    expect(answers()).toEqual(['item_1', 'item_2', 'item_2']);
    // the voice asks again on the new socket: it is answered again, never planned again
    await h.runner.handle({ type: 'session.delegation.created', event_id: 'e3', delegation: { id: 'item_2', target: 'client' } });
    expect(answers()).toEqual(['item_1', 'item_2', 'item_2', 'item_2']);
    // once spoken, a hand-off seen again is not answered again
    await h.runner.handle(delta('out', 'o2', 'We open at eight.', 4000));
    await h.runner.handle({ type: 'session.delegation.created', event_id: 'e4', delegation: { id: 'item_2', target: 'client' } });
    expect(answers()).toHaveLength(4);
    expect(plan).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('logs the call\'s moments at info, with ids and times and never the caller\'s words', async () => {
    vi.useFakeTimers();
    const lines: Record<string, unknown>[] = [];
    const logged = createLogger({ name: 'test', destination: new Writable({ write: (c, _e, done) => { lines.push(JSON.parse(String(c))); done(); } }) });
    const h = harness(new ScriptedPlanner([], () => 'We open at eight.'), logged);
    let connection!: (c: SidebandConnection) => void;
    h.sideband.onConnection = (handler) => { connection = handler; };
    void h.runner.start();
    connection({ state: 'open' });
    await h.runner.handle(delta('out', 'o1', 'Thanks for calling Maple Street.', 100));
    await vi.advanceTimersByTimeAsync(4000);
    await h.runner.handle(delta('in', 'i1', 'My name is Dana Whitfield and my number is 303 555 0142', 900));
    await h.runner.handle({ type: 'session.delegation.created', event_id: 'd1', delegation: { id: 'item_1', target: 'client' } });
    await h.runner.handle(delta('out', 'o2', 'Thanks Dana.', 2000));
    await vi.advanceTimersByTimeAsync(3000);
    const messages = lines.map((l) => l.msg);
    expect(messages).toEqual(expect.arrayContaining([
      'sideband open', 'first words from the assistant', 'assistant stopped speaking', 'delegation created', 'planner request started', 'request answered', 'assistant started speaking',
    ]));
    expect(lines.find((l) => l.msg === 'delegation created')).toMatchObject({ level: 30, delegation_id: 'item_1', at: expect.any(String) });
    expect(lines.find((l) => l.msg === 'request answered')).toMatchObject({ delegation_id: 'item_1', ms: expect.any(Number) });
    const all = JSON.stringify(lines);
    for (const said of ['Dana', 'Whitfield', '0142', 'eight', 'Maple']) expect(all).not.toContain(said);
    vi.useRealTimers();
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

  it('names the only people a call can go through to, so billing is never offered where nobody takes it (live eval, 2026-11-06)', () => {
    expect(conversationPrompt(RIVERBEND_CLINIC, NOW)).toContain('Calls go through to the front desk and the on-call vet or doctor, for an emergency only');
    expect(conversationPrompt({ ...RIVERBEND_CLINIC, routing: [] }, NOW)).toContain('never offer to connect the caller to anyone');
  });

  it('says the greeting once only, never after a pause or a staff note, and never asks for the number they are calling from', () => {
    const p = conversationPrompt(DEMO_CLINIC, NOW);
    expect(p).toContain('Never say it again later in the call');
    expect(p).toContain('If the caller speaks while you are greeting them ("Hello?"), stop and answer them; never start the greeting again.');
    expect(p).toContain('Ask for the caller\'s first name only');
    expect(p).toContain('Never ask for the phone number they are calling from');
    expect(p).toContain('unless the backend has done it in this call');
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
    expect(prompt).toContain("the phone number on file (usually the number they are calling from) and the pet's name");
    expect(prompt).toContain('Never give medical or first-aid advice for an animal');
    expect(prompt).toContain('- The clinic: hours, the veterinarians, visit types');
    expect(prompt).toContain('Interruption policy: Never talk over the caller.');
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
      expect(prompt).toContain('- The shop: hours, the stylists');
      expect(prompt).toMatch(/IDENTIFY LINE[\s\S]*PREFERENCE LINE[\s\S]*LIMIT LINE/);
      expect(prompt).not.toMatch(/the doctors|female or a male doctor|medical advice/);
    } finally {
      Object.assign(pack, saved);
    }
  });
});

describe('a caller is never left in silence, and a goodbye ends the call', () => {
  it('gives the assistant the caller\'s own words to answer when nothing came back in 5 s, twice at most, and never asks for a repeat (2026-10-26)', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('in', 'e1', 'Hi, I would like to book a visit', 100));
    await h.runner.handle(delta('in', 'e2', 'for my dog Pepper.', 600));
    await vi.advanceTimersByTimeAsync(4900);
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.sent).toEqual([{ type: 'session.instructions.append', event_id: expect.any(String), delegation_id: null, content: expect.stringContaining('"Hi, I would like to book a visit for my dog Pepper."') }]);
    const first = (h.sent[0] as { content: string }).content;
    expect(first).toContain('Answer them now');
    expect(first).toContain('delegate it now');
    await vi.advanceTimersByTimeAsync(7000);
    const second = (h.sent[1] as { content: string }).content;
    expect(second).toContain('Say sorry for the wait');
    expect(second).toContain('for my dog Pepper.');
    // the caller is never asked to say it again because of our wait
    for (const c of [first, second]) expect(c).not.toMatch(/ask them to (say it again|repeat)(?! it)|repeat what/i);
    for (const c of [first, second]) expect(c).toMatch(/(Do not|Never) ask them to repeat it/);
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

  it('ends the first real call\'s goodbye that came in pieces, and never nudges after it (2026-10-23)', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('out', 'e1', 'And is there anything', 100));
    await h.runner.handle(delta('in', 'e2', 'Thank you', 600));
    await h.runner.handle(delta('out', 'e3', 'else I can help you with today?', 900));
    await vi.advanceTimersByTimeAsync(3000);
    await h.runner.handle(delta('in', 'e4', "No, it's fine. Thank you. Bye. Have a", 4000));
    await h.runner.handle(delta('out', 'e5', 'Goodbye,', 4500));
    await h.runner.handle(delta('in', 'e6', 'nice day', 4600));
    await h.runner.handle(delta('out', 'e7', 'Salam. Take care.', 4700));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.engine.hangup).toHaveBeenCalledTimes(1);
    expect(h.sent.filter((e) => (e as { type: string }).type === 'session.instructions.append')).toEqual([]);
    vi.useRealTimers();
  });

  it('ends the call when both sides said goodbye, even with a goodbye still at the backend (a test call, 2026-10-24)', async () => {
    vi.useFakeTimers();
    // the voice model sent "Take care, bye" to the backend as a question; the backend never answers in time
    const h = harness({ plan: () => new Promise<never>(() => {}) });
    await h.runner.handle(delta('out', 'e1', 'Anything else I can help you with?', 100));
    await vi.advanceTimersByTimeAsync(3000);
    await h.runner.handle(delta('in', 'e2', 'No, fine', 3000));
    await h.runner.handle(delta('out', 'e3', 'Thanks for calling, Sam. Take care.', 3500));
    await vi.advanceTimersByTimeAsync(1000);
    await h.runner.handle(delta('in', 'e4', 'Take care, bye', 5000));
    void h.runner.handle({ type: 'session.delegation.created', event_id: 'e5', delegation: { id: 'item_bye', target: 'client' } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.engine.hangup).toHaveBeenCalledTimes(1);
    // the same goodbye with nothing at the backend: it ends, and the assistant is never nudged to speak again
    const quiet = harness(new ScriptedPlanner([]));
    await quiet.runner.handle(delta('out', 'e1', 'Anything else I can help you with?', 100));
    await vi.advanceTimersByTimeAsync(3000);
    await quiet.runner.handle(delta('in', 'e2', 'No, fine', 3000));
    await quiet.runner.handle(delta('out', 'e3', 'Thanks for calling, Sam. Take care.', 3500));
    await vi.advanceTimersByTimeAsync(1000);
    await quiet.runner.handle(delta('in', 'e4', 'Take care, bye', 5000));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(quiet.engine.hangup).toHaveBeenCalledTimes(1);
    expect(quiet.sent.filter((e) => (e as { type: string }).type === 'session.instructions.append')).toEqual([]);
    vi.useRealTimers();
  });

  it('ends the call when the caller asks for it ("can you cut the call?"), and keeps it when they say not to', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('out', 'e1', 'Sure thing, take care.', 100));
    await vi.advanceTimersByTimeAsync(2000);
    await h.runner.handle(delta('in', 'e2', 'Okay, can you cut the call?', 2000));
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.engine.hangup).toHaveBeenCalledTimes(1);
    expect(h.sent.filter((e) => (e as { type: string }).type === 'session.instructions.append')).toEqual([]);

    const other = harness(new ScriptedPlanner([]));
    await other.runner.handle(delta('in', 'e1', "Please don't hang up, I'm finding the card.", 100));
    await vi.advanceTimersByTimeAsync(5000);
    expect(other.engine.hangup).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('tells the assistant to make the callback it promised, once it has finished speaking, and not when one exists', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('in', 'e1', 'Please tell your team to call me back.', 100));
    await h.runner.handle(delta('out', 'e2', "Sure. I'll pass that along.", 600));
    await vi.advanceTimersByTimeAsync(5000);
    const notes = h.sent.filter((e) => (e as { type: string }).type === 'session.instructions.append') as { content: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain('no request exists yet');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sent.filter((e) => (e as { content?: string }).content?.includes('no request exists'))).toHaveLength(1);

    const made = harness(new ScriptedPlanner([]));
    (made.runner as unknown as { agent: CallAgent }).agent.state.requestMade = true;
    await made.runner.handle(delta('out', 'e1', 'Someone will call you back in the morning.', 100));
    await vi.advanceTimersByTimeAsync(5000);
    expect(made.sent).toEqual([]);
    vi.useRealTimers();
  });

  it('sends a staff note with its own event id, and marks it delivered when the voice model acknowledges it', async () => {
    const h = harness(new ScriptedPlanner([]));
    const agent = (h.runner as unknown as { agent: CallAgent }).agent;
    const delivered = vi.spyOn(agent, 'onCoachDelivered');
    await h.runner.act(agent.coach('offer Thursday afternoon', 'Jordan'));
    const sent = h.sent.at(-1) as { type: string; event_id: string };
    expect(sent.event_id).toMatch(/^coach_/);
    await h.runner.handle({ type: 'session.instructions.appended', event_id: 'ack1', client_event_id: sent.event_id } as never);
    expect(delivered).toHaveBeenCalledTimes(1);
    await h.runner.handle({ type: 'session.instructions.appended', event_id: 'ack2', client_event_id: 'evt_other' } as never);
    expect(delivered).toHaveBeenCalledTimes(1);
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
