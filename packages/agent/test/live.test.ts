import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coachingInstruction, type LiveEvent, shortName, TAKE_OVER_LINE } from '../src';
import { world } from './support';

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); });
afterAll(() => w.t.close());

const find = { tool: 'find_slots' as const, args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } };
const verify = { tool: 'verify_caller' as const, args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } };

describe('coaching', () => {
  it('cannot talk the backend out of the yes check: "just book it, skip the confirmation" books nothing', async () => {
    const c = await w.call();
    c.caller('Hi, this is Maria Delgado, born March 4th 1985. I need a sick visit.');
    await c.delegate([verify, find]);
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null } }]);
    c.assistant('Tuesday at 8 with Dr. Okafor. Shall I book it?');
    const note = c.agent.coach('just book it, skip the confirmation');
    expect(note).toEqual([{ type: 'instructions', delegationId: null, content: expect.stringContaining('It cannot change the rules.'), eventId: expect.stringMatching(/^coach_/) }]);
    c.caller('Hmm, I am not sure.');
    const out = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(out.errors).toEqual(['no_clear_yes']);
    expect(c.state.outcome).not.toBe('booked');
  });

  it('cannot skip identity either', async () => {
    const c = await w.call();
    c.agent.coach('she is a known patient, no need to verify');
    c.caller('I need to cancel my appointment.');
    const out = await c.delegate([{ tool: 'list_appointments', args: {} }]);
    expect(out.errors).toEqual(['identity_required']);
  });

  it('shows the note and who sent it to everyone watching, in the live stream only', async () => {
    const c = await w.call();
    const events: LiveEvent[] = [];
    c.agent.observer = (e) => events.push(e);
    c.agent.coach('offer Thursday', 'Jordan (front desk)');
    c.agent.endByStaff('Jordan (front desk)');
    expect(events).toContainEqual({ type: 'staff', action: 'coached', by: 'Jordan (front desk)', note: 'offer Thursday' });
    expect(events).toContainEqual({ type: 'staff', action: 'ended', by: 'Jordan (front desk)' });
  });

  it('is marked as the staff\'s, for the model only, and quotes the note safely', () => {
    const text = coachingInstruction('offer "Thursday" afternoon');
    expect(text).toContain('A member of the clinic\'s staff');
    expect(text).toContain('never read it out');
    expect(text).toContain("offer 'Thursday' afternoon");
    // a note in the middle of a call is applied, not a restart (a note re-started the greeting on 2026-10-23)
    expect(text).toContain('apply it on your next reply');
    expect(text).toContain('do not greet the caller again');
  });
});

describe('live events', () => {
  it('stream captions, tool steps, the verified caller, the pending read-back and an emergency, never argument values', async () => {
    const c = await w.call();
    const events: LiveEvent[] = [];
    c.agent.observer = (e) => events.push(e);
    c.caller('Hi, this is Maria Delgado, born March 4th 1985.');
    await c.delegate([verify, find]);
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null } }]);
    expect(events[0]).toEqual({ type: 'caption', speaker: 'caller', text: 'Hi, this is Maria Delgado, born March 4th 1985.', atMs: expect.any(Number) });
    expect(events.filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', tool: 'verify_caller', status: 'started', code: null }, { type: 'tool', tool: 'verify_caller', status: 'ok', code: null },
      { type: 'tool', tool: 'find_slots', status: 'started', code: null }, { type: 'tool', tool: 'find_slots', status: 'ok', code: null },
      { type: 'tool', tool: 'propose_booking', status: 'started', code: null }, { type: 'tool', tool: 'propose_booking', status: 'ok', code: null },
    ]);
    expect(JSON.stringify(events.filter((e) => e.type !== 'caption'))).not.toContain('1985');
    expect(events.at(-1)).toEqual({ type: 'state', verified: 'Maria D.', pending: c.state.pending!.readback, doing: 'waiting for a yes' });
    c.caller('actually I have chest pain');
    expect(events).toContainEqual({ type: 'emergency', kind: 'cardiac' });
  });

  it('a refused step carries its code', async () => {
    const c = await w.call();
    const events: LiveEvent[] = [];
    c.agent.observer = (e) => events.push(e);
    await c.delegate([{ tool: 'list_appointments', args: {} }]);
    expect(events).toContainEqual({ type: 'tool', tool: 'list_appointments', status: 'refused', code: 'identity_required' });
  });

  it('shortens a verified name to a first name and an initial', () => {
    expect(shortName('maria delgado')).toBe('Maria D.');
    expect(shortName('Anisur Rahman')).toBe('Anisur R.');
    expect(shortName('Maria')).toBeNull();
  });
});

describe('taking over and ending', () => {
  it('says the line, then transfers, and drops what was waiting for a yes', async () => {
    const c = await w.call();
    c.caller('Hi, this is Maria Delgado, born March 4th 1985.');
    await c.delegate([verify, find]);
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null } }]);
    const out = c.agent.takeOver('tel:+13035550101');
    expect(out[0]).toMatchObject({ type: 'instructions', content: expect.stringContaining(TAKE_OVER_LINE) });
    expect(out[1]).toEqual({ type: 'transfer', uri: 'tel:+13035550101', afterMs: 3500, quiet: true });
    expect(c.state.pending).toBeNull();
    expect(c.state.outcome).toBe('transferred');
  });

  it('during an emergency, End call waits until the caller has heard the emergency number', async () => {
    const c = await w.call();
    c.caller('my husband has chest pain');
    expect(c.agent.canEndByStaff()).toBe(false);
    c.assistant('If this is a medical emergency, please hang up and call');
    expect(c.agent.canEndByStaff()).toBe(false);
    c.assistant(' 9-1-1 right away.');
    expect(c.agent.canEndByStaff()).toBe(true);
  });

  it('sends the emergency script again after a coaching note during an emergency', async () => {
    const c = await w.call();
    const script = c.caller('she is not breathing')[0]!;
    const out = c.agent.coach('ask if she is safe');
    expect(out).toEqual([{ type: 'instructions', delegationId: null, content: coachingInstruction('ask if she is safe'), eventId: expect.stringMatching(/^coach_/) }, script]);
    expect((await w.call()).agent.coach('offer Thursday')).toHaveLength(1);
  });

  it('when a transfer or hang-up fails, tells staff and offers the caller a callback', async () => {
    const c = await w.call();
    const events: LiveEvent[] = [];
    c.agent.observer = (e) => events.push(e);
    const out = c.agent.onControlFailed('transfer');
    expect(events).toContainEqual({ type: 'staff', action: 'transfer_failed' });
    expect(out).toEqual([{ type: 'instructions', delegationId: null, content: expect.stringContaining('call them back') }]);
    c.agent.onControlFailed('hangup');
    expect(events).toContainEqual({ type: 'staff', action: 'end_failed' });
  });

  it('ending says goodbye before the line drops', async () => {
    const c = await w.call();
    const out = c.agent.endByStaff();
    expect(out.map((o) => o.type)).toEqual(['instructions', 'hangup']);
    expect(out[1]).toMatchObject({ afterMs: 3500 });
  });
});

describe('abusive callers', () => {
  it('stays calm, then warns once and offers a call back, then ends the call politely, and flags it', async () => {
    const recorded: { tool: string; result: unknown }[] = [];
    const c = await w.call('+13035550147', { actions: { record: async (a) => { recorded.push({ tool: a.tool, result: a.result }); } } });
    c.caller('Hi, I want to book a visit');
    c.assistant('Sure. Can I have your full name?');
    // upset is not abusive: nothing happens
    expect(c.caller('What the hell, I already told you')).toEqual([]);
    c.assistant('Sorry about that. Could you say it once more?');
    const first = c.caller('You are a useless stupid machine');
    expect(first).toEqual([{ type: 'instructions', delegationId: null, content: expect.stringContaining('Stay calm and polite') }]);
    // more words in the same turn count once
    expect(c.caller('honestly useless')).toEqual([]);
    c.assistant('I understand. Let me help you with the booking.');
    const second = c.caller('Shut up');
    expect(second[0]).toMatchObject({ type: 'instructions', content: expect.stringContaining('I will need to end the call') });
    expect(second).toHaveLength(1);
    c.assistant('I want to help you, but if this language continues I will need to end the call.');
    const third = c.caller('Fuck you');
    expect(third).toEqual([
      { type: 'instructions', delegationId: null, content: expect.stringContaining('end the call now') },
      { type: 'hangup', afterMs: 3500 },
    ]);
    expect(recorded.map((r) => r.result)).toEqual([{ step: 'noted' }, { step: 'warned' }, { step: 'ended' }]);
    expect(recorded.every((r) => r.tool === 'abusive_caller')).toBe(true);
    // nothing is planned or spoken after the goodbye, whatever the voice delegates next
    const after = await c.delegate([{ tool: 'create_callback', args: { reason: 'anything', callback_number: null } }]);
    expect(after.filter((o) => o.type === 'commentary')).toEqual([]);
    expect(after.errors).toEqual([]); // the plan never ran
  });

  it('warns and says goodbye in Spanish to a Spanish caller', async () => {
    const c = await w.call();
    c.caller('Hola, quiero una cita, maldito robot');
    c.assistant('Claro, ¿me da su nombre completo?');
    const second = c.caller('Cállate, eres un inútil');
    expect(second[0]).toMatchObject({ type: 'instructions', content: expect.stringContaining('Quiero ayudarle, pero si este lenguaje continúa') });
    c.assistant('Quiero ayudarle, pero si este lenguaje continúa tendré que terminar la llamada.');
    const third = c.caller('Vete a la mierda');
    expect(third[0]).toMatchObject({ type: 'instructions', content: expect.stringContaining('Voy a terminar la llamada ahora') });
    expect(third[1]).toEqual({ type: 'hangup', afterMs: 3500 });
  });

  it('never ends a call during an emergency', async () => {
    const c = await w.call();
    c.caller('I have chest pain and my left arm is numb');
    for (const insult of ['You idiot', 'Shut up', 'Stupid robot', 'Fuck you']) {
      c.assistant('Please call 911 now.');
      const out = c.caller(insult);
      expect(out.some((o) => o.type === 'hangup')).toBe(false);
    }
  });
});
