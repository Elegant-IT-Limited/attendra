// SPDX-License-Identifier: AGPL-3.0-only
import { answerAcrossPieces, isClearYes, LANGUAGES, RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallCache, cachedBackend, CallState, callStateNote, CLINIC_NOW, flowStage, speculativeLookup, voiceToolDefinitions } from '../src';
import { world } from './support';

// Batch 1a: the voice calls the tools itself. The same safety rules (runTool), the booking flow as code around them,
// results shaped the same for every engine, and the call state as one JSON document.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

// a clinic that books after hours, so the test does not depend on the time of day
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };

describe('the tools the voice calls', () => {
  it('are the backend\'s tools as the planner has them, plus the clinic\'s clock', () => {
    const names = voiceToolDefinitions(clinic).map((t) => t.name);
    expect(names).toContain('verify_caller');
    expect(names).toContain('commit_pending');
    expect(names.at(-1)).toBe('clinic_now');
    expect(voiceToolDefinitions(clinic).every((t) => t.strict && t.parameters)).toBe(true);
    expect(CLINIC_NOW.description).toMatch(/Never say the clinic is open or closed without it/);
  });
});

describe('a booking on the tools path', () => {
  it('goes number, pet, times, read-back, yes, booked, with the next step said at each stage', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.state.answersAcrossPieces = true;
    const tool = async (name: string, args: Record<string, unknown> = {}) => (await c.agent.onToolCall(name, args)).output;

    expect(flowStage(c.state, c.agent.flow)).toBe('idle');
    const clock = await tool('clinic_now');
    expect(clock).toMatchObject({ ok: true, outcome: 'ok', data: { zone: 'America/Denver', afterHours: 'book', visitsNow: 'book' } });
    expect(clock.spoken).toMatch(/clinic time \(M[DS]T\)/);
    // "is the clinic open tomorrow?": each of the next days answers yes or no with its hours (note 45, A1)
    const days = (clock.data as { days: { date: string; open: boolean; answer: string }[] }).days;
    expect(days).toHaveLength(8);
    expect(days[1]!.answer).toMatch(/^(Yes, the clinic is open tomorrow, \w+, \w+ \d+, from |No, the clinic is closed tomorrow, )/);
    expect(clock.say).toContain('say that day\'s answer from days as written');

    // the number first, read back before it is searched
    const asked = await tool('verify_caller', { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' });
    expect(asked).toMatchObject({ ok: false, outcome: 'confirm_number', stage: 'number_asked' });
    expect(asked.say).toContain("That's 720-555-0172?");
    c.assistant("That's 720-555-0172?");
    // a yes, then "hello?": the yes counts on the tools path (V-6), and the read-back is not asked again
    c.caller('Yes.');
    c.state.addTranscript('caller', ' Hello, are you there?', 99_000, 99_500);
    const named = await tool('verify_caller', { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' });
    expect(named.outcome).toBe('owner_check');
    c.assistant('And the owner\'s name on that profile?');
    c.caller('Linh.');
    const found = await tool('verify_caller', { owner_name: 'Linh', pet_name: 'Biscuit', phone: '720 555 0172' });
    expect(found).toMatchObject({ ok: true, outcome: 'found', stage: 'pet_chosen' });
    // the call's state in a line for the voice (batch 1d): it outlasts the oldest turns being cut
    expect(callStateNote(c.state)).toBe('Call state. found: Biscuit.');

    // no time named: the earliest times (an exact time asked for is staged straight away, as on the planner path)
    const times = await tool('find_slots', { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-09-29', from_time: null, part_of_day: 'any' });
    expect(times).toMatchObject({ ok: true, outcome: 'times_found', stage: 'times_offered' });
    expect(times.spoken).toBeTruthy(); // find_slots' own words (say_as) are the words to say
    const slot = (times.data.slots as { slot_id: string }[])[0]!;

    const proposed = await tool('propose_booking', { slot_id: slot.slot_id, replaces_appointment_id: null });
    expect(proposed).toMatchObject({ ok: true, stage: 'readback_pending' });
    expect(proposed.spoken).toMatch(/Shall I book it\?/);
    expect(proposed.next).toMatch(/call commit_pending at once/);
    expect(callStateNote(c.state)).toContain('waiting for a yes to: ');
    // the yes before the read-back was spoken does not book
    expect((await tool('commit_pending')).outcome).toBe('not_read_back');
    c.assistant(proposed.spoken!);
    c.caller('Yes please.');
    c.state.addTranscript('caller', ' Are you still there?', 200_000, 200_400);
    const booked = await tool('commit_pending');
    expect(booked).toMatchObject({ ok: true, outcome: 'booked', stage: 'done' });
    expect(booked.spoken).toMatch(/That's booked|All set/);
    expect(c.state.outcome).toBe('booked');
    expect(callStateNote(c.state)).toMatch(/^Call state\. found: Biscuit\. done: /);
    expect(callStateNote(new CallState())).toBeNull();
  });

  it('a no after a yes, in a later piece, is a no', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.state.answersAcrossPieces = true;
    await c.agent.onToolCall('verify_caller', { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' });
    c.assistant("That's 720-555-0172?");
    c.caller('Yes.');
    c.state.addTranscript('caller', ' Wait, no, that is my old number.', 99_000, 99_500);
    const again = await c.agent.onToolCall('verify_caller', { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' });
    expect(again.output.outcome).toBe('confirm_number');
    expect(c.state.verifiedPatient).toBeNull();
  });

  it('refuses a tool it does not have, and never runs anything once the call is ending', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    expect((await c.agent.onToolCall('drop_tables', {})).output).toMatchObject({ ok: false, outcome: 'unknown_tool' });
    c.state.endedByStaff = true;
    expect((await c.agent.onToolCall('find_slots', {})).output).toMatchObject({ ok: false, outcome: 'call_ending' });
  });

  it('a closed clinic that takes requests refuses times with its reason code, said in the call\'s language', async () => {
    const closed = { ...RIVERBEND_CLINIC, afterHours: 'requests' as const };
    const night = zonedInstant('2026-09-28', '22:00', RIVERBEND_CLINIC.timezone);
    const c = await w.call(null, { clinic: closed, channel: 'web', now: night });
    const out = (await c.agent.onToolCall('find_slots', { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any' })).output;
    expect(out).toMatchObject({ ok: false, outcome: 'after_hours' });
    expect(out.say).toMatch(/closed/);
  });
});

describe('the call state as one JSON document', () => {
  it('round-trips every field: turns, the offered times, the memory, sets and dates', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    await c.agent.onToolCall('find_slots', { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-09-29', part_of_day: 'any' });
    c.caller('It is for Biscuit, my dog.');
    c.state.identitiesTried.add('linh|biscuit');
    c.state.emergencyKinds.add('general');
    const doc = JSON.parse(JSON.stringify(c.state.toJSON()));
    const back = CallState.fromJSON(doc);
    expect(back.toJSON()).toEqual(c.state.toJSON());
    expect(back.offered.size).toBe(c.state.offered.size);
    const [slot] = [...back.offered.values()];
    expect(slot!.start).toBeInstanceOf(Date);
    expect(back.memory.get('petName')).toBe(c.state.memory.get('petName'));
    expect(back.identitiesTried.has('linh|biscuit')).toBe(true);
    expect(back.emergencyLocked).toBe(false);
    expect(() => CallState.fromJSON({ v: 2 } as never)).toThrow(/version/);
  });
});

describe('a yes across pieces', () => {
  it('takes the latest piece with an answer in it, without the "hello?"', () => {
    const yes = (...pieces: string[]) => isClearYes(answerAcrossPieces(pieces, LANGUAGES), ['en', 'es']);
    expect(yes('Yes.', 'Hello, are you there?')).toBe(true);
    expect(yes('Yes, hello, are you there?')).toBe(true);
    expect(yes('Sí, claro.', '¿Hola?')).toBe(true);
    expect(yes('Yes, Thursday works.')).toBe(true);
    expect(yes('Yes.', 'Wait.')).toBe(false);
    expect(yes('Yes.', 'Hmm.')).toBe(false);
    expect(yes('Yes, is that on Thursday?')).toBe(false);
    expect(yes('Yes, book it.', 'No, actually, not that day.')).toBe(false);
    // an earlier doubt, then a clear yes: the yes
    expect(yes('Hmm, maybe.', 'Yes, go ahead.')).toBe(true);
    expect(answerAcrossPieces(['Hello?'], LANGUAGES)).toBe('Hello?');
  });

  it('is off on the planner path: the latest piece only, as before', () => {
    const s = new CallState();
    s.phoneReadback = { digits: '7205550172', atMs: 0, askedAtMs: 1 };
    s.addTranscript('caller', 'Yes.', 10, 20);
    s.addTranscript('agent', 'mm', 30, 31);
    s.addTranscript('caller', 'Hello?', 40, 50);
    expect(s.confirmedReadback('7205550172')).toBe(false);
    s.answersAcrossPieces = true;
    expect(s.confirmedReadback('7205550172')).toBe(true);
  });
});

describe('the call cache (the preload)', () => {
  it('answers the schedule from what was read at the start, and reads afresh after a write', async () => {
    let reads = 0;
    const scheduler = { ...w.backend.scheduler, busy: async (...a: Parameters<typeof w.backend.scheduler.busy>) => { reads++; return w.backend.scheduler.busy(...a); } };
    const backend = { ...w.backend, scheduler: Object.assign(Object.create(Object.getPrototypeOf(w.backend.scheduler)), w.backend.scheduler, { busy: scheduler.busy }) };
    const cache = new CallCache();
    const cached = cachedBackend(backend, cache);
    const from = zonedInstant('2026-09-29', '08:00', clinic.timezone);
    cache.warmSchedule(backend.scheduler, clinic.id, clinic.providers.map((p) => p.id), from);
    const a = await cached.scheduler.busy(clinic.id, ['prov_ruiz'], from, new Date(from.getTime() + 86_400_000));
    const b = await cached.scheduler.busy(clinic.id, ['prov_bell', 'prov_ruiz'], new Date(from.getTime() + 3_600_000), new Date(from.getTime() + 2 * 86_400_000));
    expect(reads).toBe(1);
    expect(cache.hits).toBe(2);
    expect(a.every((r) => r.providerId === 'prov_ruiz')).toBe(true);
    expect(Array.isArray(b)).toBe(true);
    // outside the window, or a provider it never read: the database
    await cached.scheduler.busy(clinic.id, ['prov_ruiz'], from, new Date(from.getTime() + 100 * 86_400_000));
    expect(reads).toBe(2);
    cache.dropSchedule();
    await cached.scheduler.busy(clinic.id, ['prov_ruiz'], from, new Date(from.getTime() + 86_400_000));
    expect(reads).toBe(3);
  });

  it('holds a read for its time to live only', async () => {
    let t = 0;
    const cache = new CallCache(() => t);
    let loads = 0;
    const load = async () => ++loads;
    await cache.read('k', load);
    await cache.read('k', load);
    expect(loads).toBe(1);
    t = 61_000;
    await cache.read('k', load);
    expect(loads).toBe(2);
  });
});

describe('round 2: the visit type from the clinic, and the lookup run ahead', () => {
  it('find_slots takes only the clinic\'s own visit type ids on the tools path', () => {
    const find = voiceToolDefinitions(clinic).find((t) => t.name === 'find_slots')!;
    const visit = (find.parameters as { properties: { visit_type_id: { enum: string[]; description: string } } }).properties.visit_type_id;
    expect(visit.enum).toEqual(clinic.visitTypes.map((v) => v.id));
    expect(visit.description).toContain('vt_wellness (wellness exam)');
  });

  it('a made-up visit type is refused with the real ones, ids and names', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    const out = (await c.agent.onToolCall('find_slots', { visit_type_id: 'vt_checkup', provider_id: null, from_date: null, part_of_day: 'any' })).output;
    expect(out.outcome).toBe('unknown_visit_type');
    expect(out.data.visit_types).toContainEqual({ id: 'vt_wellness', name: 'wellness exam' });
  });

  it('runs a lookup ahead only when the pet is found, the visit is known and the caller asks about a time', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Is Thursday at 4 free?');
    expect(speculativeLookup(c.state, clinic)).toBeNull(); // no pet found yet
    c.state.verifiedPatient = { id: 'p1', firstName: 'Biscuit' } as never;
    expect(speculativeLookup(c.state, clinic)).toBeNull(); // no visit known: never a guess
    c.caller('Is Thursday at 4 free for his vaccine appointment?');
    expect(speculativeLookup(c.state, clinic)).toEqual({ name: 'find_slots', args: { visit_type_id: 'vt_vaccines', provider_id: null, from_date: null, part_of_day: 'any' } });
    c.state.memory.set('visitType', 'vt_wellness', 'tool');
    c.assistant('Thursday at 4 is taken. I have 3:30.');
    c.caller('What about Friday morning?');
    expect(speculativeLookup(c.state, clinic)?.args).toMatchObject({ visit_type_id: 'vt_wellness', part_of_day: 'morning' });
    c.assistant('Friday at 9 or 10?');
    c.caller('Do you have an afternoon time instead?');
    expect(speculativeLookup(c.state, clinic)?.args.part_of_day).toBe('afternoon');
    c.assistant('Friday at 9?');
    c.caller('Yes, that works.');
    expect(speculativeLookup(c.state, clinic)).toBeNull(); // nothing about a time: a yes is not a lookup
  });
});
