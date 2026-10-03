import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallAgent, ToolResult } from '../src';
import { world } from './support';

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); });
afterAll(() => w.t.close());

const firstSlot = (results: ToolResult[]) => (results.find((r) => Array.isArray(r.data.slots))!.data.slots as { slot_id: string }[])[0]!.slot_id;
type Out = Awaited<ReturnType<CallAgent['onDelegation']>>;
const spoken = (out: Out) => out.flatMap((o) => (o.type === 'commentary' ? [o.content] : [])).join(' ');
const bookings = () => w.backend.scheduler.upcoming(DEMO_CLINIC.id, w.patientIds.maria!, new Date('2026-09-28T00:00:00Z'));

describe('the call record', () => {
  const patientOf = async (callId: string) => ((await w.t.db.execute(sql`select patient_id from calls where id = ${callId}`)).rows[0] as { patient_id: string | null }).patient_id;

  it('links a call to the patient once, and only once, the caller is verified', async () => {
    const c = await w.call('+13035550147', { record: true });
    c.caller('Hi, this is Maria Delgado, born March 5th 1985.');
    await c.delegate([{ tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 5th 1985' } }]);
    expect(await patientOf(c.callId)).toBeNull(); // the wrong date of birth, and a matching phone number, prove nothing
    c.caller('Sorry, March 4th 1985.');
    await c.delegate([{ tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } }]);
    expect(await patientOf(c.callId)).toBe(w.patientIds.maria);
  });

  it('leaves a call with nobody verified unlinked', async () => {
    const c = await w.call('+13035550147', { record: true });
    c.caller('What time do you open tomorrow?');
    await c.delegate([{ tool: 'get_clinic_info', args: { question: 'opening hours' } }]);
    expect(await patientOf(c.callId)).toBeNull();
  });
});

describe('booking over the phone', () => {
  it('verifies, offers real slots, reads back, and books only after a clear yes, then texts once', async () => {
    const c = await w.call();
    c.caller('Hi, this is Maria Delgado, born March 4th 1985. I need a sick visit, my knee hurts.');
    const verify = await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    expect(c.state.verifiedPatient?.firstName).toBe('Maria');
    expect(spoken(verify)).toContain('Tuesday, September 29 at 8:00 AM');

    c.assistant('I have Tuesday at 8, 8:20 or 8:40 with Dr. Okafor.');
    c.caller('The first one please.');
    const offered = [...c.state.offered.keys()][0]!;
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: offered, replaces_appointment_id: null } }]);
    expect(await bookings()).toHaveLength(0); // proposing is not booking

    c.assistant('Tuesday, September 29 at 8:00 AM with Dr. Nkem Okafor for a sick visit. Shall I book it?');
    c.caller('Yes, that works.');
    const done = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(spoken(done)).toContain('"booked":true');
    expect(await bookings()).toHaveLength(1);
    expect(w.sms).toMatchObject([{ to: '+13035550147', template: 'booking_confirmed', language: 'en' }]);
    expect(c.state.outcome).toBe('booked');
  });

  it('does not book on a hedge, even when the planner tries to commit', async () => {
    const c = await w.call();
    c.caller('Maria Delgado, 3/4/1985, annual physical please');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: '3/4/1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_annual', provider_id: null, from_date: null, part_of_day: 'afternoon' } },
    ]);
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    c.assistant('Shall I book Tuesday at 1 PM?');
    c.caller('Hmm, maybe, is there anything Thursday?');
    const out = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(out.errors).toEqual(['no_clear_yes']);
    expect(await bookings()).toHaveLength(1); // still only the one from the previous call
  });

  it('refuses patient actions before identity is verified, and refuses slots nobody offered', async () => {
    const c = await w.call();
    c.caller('Can you just cancel my appointment?');
    const out = await c.delegate([
      { tool: 'list_appointments', args: {} },
      { tool: 'propose_booking', args: { slot_id: 'prov_okafor@2026-09-29T14:00:00.000Z', replaces_appointment_id: null } },
    ]);
    expect(out.errors).toEqual(['identity_required', 'identity_required']);

    await c.delegate([{ tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: 'September 9 1962', phone: '303-555-0163' } }]);
    const invented = await c.delegate([{ tool: 'propose_booking', args: { slot_id: 'prov_okafor@2026-09-29T14:00:00.000Z', replaces_appointment_id: null } }]);
    expect(invented.errors).toEqual(['slot_not_offered']);
  });

  it('gives the same answer for a wrong DOB as for no such patient, and stops after three tries', async () => {
    const c = await w.call();
    const tries = [];
    for (let i = 0; i < 4; i++) tries.push(await c.delegate([{ tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: '1 January 1990' } }]));
    expect(tries.map((t) => t.errors[0])).toEqual(['not_verified', 'not_verified', 'not_verified', 'too_many_attempts']);
  });

  it('tells apart two patients with the same name and DOB by the phone on their file, and never guesses without it', async () => {
    const c = await w.call(null);
    const out = await c.delegate([{ tool: 'verify_caller', args: { full_name: 'Sam Rivera', date_of_birth: 'July 15 1990' } }]);
    expect(out.errors).toEqual(['phone_required']);
    await c.delegate([{ tool: 'verify_caller', args: { full_name: 'Sam Rivera', date_of_birth: 'July 15 1990', phone: '(303) 555-0172' } }]);
    expect(c.state.verifiedPatient?.id).toBe(w.patientIds.sam_b);
  });

  it('a parent books for each child on the family phone, and a doctor who does not see children is never offered', async () => {
    const c = await w.call(); // from Maria's phone
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Lucas Delgado', date_of_birth: 'May 12 2019' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    expect(c.state.verifiedPatient?.id).toBe(w.patientIds.lucas);
    expect([...c.state.offered.values()].every((s) => s.providerId !== 'prov_lindqvist')).toBe(true); // she sees adults only
    const asked = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: 'prov_lindqvist', from_date: null, part_of_day: 'any' } }]);
    expect(asked.errors).toEqual(['no_provider_for_patient']);
    // the second child: verified on the same phone, and what was offered for Lucas is gone
    await c.delegate([{ tool: 'verify_caller', args: { full_name: 'Sofia Delgado', date_of_birth: 'November 2 2023' } }]);
    expect(c.state.verifiedPatient?.id).toBe(w.patientIds.sofia);
    expect(c.state.offered.size).toBe(0);
  });

  it('adds a new patient after the check finds nobody, asks for a guardian for a child, and offers new-patient visits only', async () => {
    const c = await w.call('+13035550199');
    const missing = await c.delegate([{ tool: 'verify_caller', args: { full_name: 'Ana Reyes', date_of_birth: 'June 1 2018' } }]);
    expect(missing.errors).toEqual(['not_verified']);
    const child = await c.delegate([{ tool: 'register_patient', args: { first_name: 'Ana', last_name: 'Reyes', date_of_birth: 'June 1 2018', gender: 'female' } }]);
    expect(child.errors).toEqual(['guardian_required']);
    await c.delegate([{ tool: 'register_patient', args: { first_name: 'Ana', last_name: 'Reyes', date_of_birth: 'June 1 2018', gender: 'female', guardian_name: 'Luis Reyes' } }]);
    expect(c.state.verifiedPatient).toMatchObject({ firstName: 'Ana', isNew: true });
    const annual = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_annual', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(annual.errors).toEqual(['new_patient_visit_type']);
    await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_new', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    // a six-year-old new patient: only doctors who see children and take new patients
    expect(c.state.offered.size).toBeGreaterThan(0);
    expect([...c.state.offered.values()].every((s) => ['prov_okafor', 'prov_raman'].includes(s.providerId))).toBe(true);
    // the front desk is asked to check the new record
    const [review] = await w.t.db.execute(sql`select type, status from tasks where call_id = ${c.callId}`).then((r) => r.rows);
    expect(review).toEqual({ type: 'review', status: 'open' });
  });

  it('adds nobody before the check has found nobody, and is no way round its limit', async () => {
    const c = await w.call('+13035550198');
    const early = await c.delegate([{ tool: 'register_patient', args: { first_name: 'Eve', last_name: 'Early', date_of_birth: 'May 5 1990', gender: 'female' } }]);
    expect(early.errors).toEqual(['verify_first']);
    for (let i = 0; i < 3; i++) await c.delegate([{ tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: `January ${i + 1} 1990` } }]);
    // three wrong guesses used up: registering the real details now would be a fourth guess
    const late = await c.delegate([{ tool: 'register_patient', args: { first_name: 'Maria', last_name: 'Delgado', date_of_birth: 'March 4 1985', gender: 'female', phone: '303-555-0147' } }]);
    expect(late.errors).toEqual(['too_many_attempts']);
    expect(c.state.verifiedPatient).toBeNull();
  });

  it('texts a booking for a patient it just added only to the number they are calling from', async () => {
    const book = async (caller: string | null, phone: string) => {
      const c = await w.call(caller);
      c.caller('I am new, Zoe Quill, March 3 1991, sick visit');
      await c.delegate([
        { tool: 'verify_caller', args: { full_name: 'Zoe Quill', date_of_birth: 'March 3 1991', phone } },
        { tool: 'register_patient', args: { first_name: 'Zoe', last_name: 'Quill', date_of_birth: 'March 3 1991', gender: 'female', phone } },
        { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
        { tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) },
      ]);
      c.assistant('Just to confirm, the first time. Is that right?');
      c.caller('Yes');
      return c.delegate([{ tool: 'commit_pending', args: {} }]);
    };
    const before = w.sms.length;
    await book(null, '303-555-0196'); // a browser call: nothing to match the number against
    expect(w.sms.length).toBe(before);
    await book('+13035550197', '303-555-0197'); // the number they are calling from
    expect(w.sms.length).toBe(before + 1);
  });

  it('offers a female or a male doctor when the caller asks, and says when there is none', async () => {
    const c = await w.call(null);
    await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, provider_gender: 'female', from_date: null, part_of_day: 'any' } }]);
    expect([...c.state.offered.values()].every((s) => ['prov_lindqvist', 'prov_raman'].includes(s.providerId))).toBe(true);
    const none = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_annual', provider_id: 'prov_okafor', provider_gender: 'female', from_date: null, part_of_day: 'any' } }]);
    expect(none.errors).toEqual(['no_provider_of_gender']);
  });

  it('anyone may hear the doctors and their open times without being verified', async () => {
    const c = await w.call(null);
    const out = await c.delegate([
      { tool: 'get_clinic_info', args: { question: 'which doctors do you have' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: 'prov_raman', from_date: null, part_of_day: 'any' } },
    ]);
    expect(out.errors).toEqual([null, null]);
    expect(c.state.verifiedPatient).toBeNull();
    expect(c.state.offered.size).toBeGreaterThan(0);
  });

  it('describes each doctor to the planner: specialty, what they see people for, ages, hours, new patients', async () => {
    const c = await w.call(null);
    const results: ToolResult[] = [];
    await c.delegate([{ tool: 'get_clinic_info', args: { question: 'do you have a pediatrician' } }], {
      plan: async (_input, execute) => { results.push(await execute('get_clinic_info', { question: 'do you have a pediatrician' })); return { say: null }; },
    });
    const providers = results[0]!.data.providers as { name: string; specialty: string; sees: string; categories: string[]; accepting_new_patients: boolean; hours: string }[];
    expect(providers.find((p) => p.name === 'Dr. Priya Raman')).toMatchObject({ specialty: 'Pediatrics', sees: 'ages 0 to 17', categories: ['Children', 'Newborns', 'Vaccinations'], accepting_new_patients: true });
    expect(providers.find((p) => p.name === 'Dr. Ann Lindqvist')).toMatchObject({ sees: 'ages 18 and over', accepting_new_patients: false, hours: 'Tue 09:00-15:00; Thu 09:00-15:00' });
  });

  it('knows a doctor added in the dashboard from the next request on a call already under way', async () => {
    const added = { ...DEMO_CLINIC, providers: [...DEMO_CLINIC.providers, { ...DEMO_CLINIC.providers[0]!, id: 'prov_new', name: 'Dr. Mid Call' }] };
    let current = DEMO_CLINIC;
    const c = await w.call(null, { reload: async () => current });
    current = added;
    const results: ToolResult[] = [];
    await c.delegate([], { plan: async (_i, execute) => { results.push(await execute('get_clinic_info', { question: 'doctors' })); return { say: null }; } });
    expect((results[0]!.data.providers as { name: string }[]).map((p) => p.name)).toContain('Dr. Mid Call');
  });
});

describe('safety', () => {
  it('reacts to an emergency on the caller\'s words alone, drops the pending change, and schedules the on-call transfer', async () => {
    const c = await w.call();
    c.caller('James Whitaker, September 9 1962, I want to book');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: 'September 9 1962', phone: '303-555-0163' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
      { tool: 'propose_booking', args: (r) => ({ slot_id: firstSlot(r), replaces_appointment_id: null }) },
    ]);
    const out = c.caller('actually I have chest pain and my left arm feels numb');
    expect(out[0]).toMatchObject({ type: 'instructions', delegationId: null });
    expect(out[0]!.type === 'instructions' && out[0]!.content).toContain('call 911');
    expect(out[1]).toEqual({ type: 'transfer', uri: 'tel:+13035550199', afterMs: 8000 });
    expect(c.state.pending).toBeNull();
    expect(c.state.outcome).toBe('emergency');
  });

  it('queues the on-call transfer for chest pain even when "this is an emergency" came first, and only once', async () => {
    const c = await w.call();
    const general = c.caller('this is an emergency');
    expect(general.some((o) => o.type === 'transfer')).toBe(false); // the bare word rings no one
    const cardiac = c.caller('my husband has chest pain');
    expect(cardiac).toContainEqual({ type: 'transfer', uri: 'tel:+13035550199', afterMs: 8000 });
    const again = c.caller('and now he is not breathing');
    expect(again.some((o) => o.type === 'transfer')).toBe(false);
  });

  it('turns a refill into a staff task and never approves it', async () => {
    const c = await w.call();
    await c.delegate([{ tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: '09/09/1962', phone: '303-555-0163' } }]);
    const out = await c.delegate([{ tool: 'create_refill_request', args: { medication: 'lisinopril 10 mg', pharmacy: 'Walgreens on Colfax', callback_number: '+13035550163' } }]);
    expect(spoken(out)).toContain('Do not promise approval');
    expect(c.state.outcome).toBe('task_created');
  });

  it('refuses a medical question the caller asked, even when the model passes on a softened one', async () => {
    const c = await w.call();
    c.caller('How much Tylenol for a child who is four?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'children\'s pharmacy information' } }, { tool: 'search_knowledge', args: { question: 'pediatric info' } }]);
    expect(out.errors).toEqual(['medical_question', 'medical_question']);
  });
});

describe('call control', () => {
  it('still tells the caller the booking went through when writing the call record fails', async () => {
    const c = await w.call('+13035550163', { actions: { record: async () => { throw new Error('audit write failed'); } } });
    c.caller('Hi, this is James Whitaker, born September 9 1962. I need a sick visit in the afternoon.');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: 'September 9 1962', phone: '303-555-0163' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'afternoon' } },
      { tool: 'propose_booking', args: (r) => ({ slot_id: firstSlot(r), replaces_appointment_id: null }) },
    ]);
    c.assistant('Tuesday afternoon with Dr. Okafor. Shall I book it?');
    c.caller('Yes, please book it.');
    const done = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(spoken(done)).toContain('"booked":true');
    expect(spoken(done)).not.toContain("couldn't complete");
    expect(c.state.outcome).toBe('booked');
  });

  it('discards a slow result once the caller has moved on to a newer request', async () => {
    const c = await w.call();
    let release!: () => void;
    const slow = { plan: () => new Promise<{ say: string }>((r) => { release = () => r({ say: 'Friday at 9 is booked' }); }) };
    const first = c.delegate([], slow);
    const second = c.delegate([{ tool: 'get_clinic_info', args: { question: 'what is your address' } }]);
    release();
    expect([...(await first)]).toEqual([]);
    expect((await second).some((o) => o.type === 'commentary' && o.content.includes('214 Maple Street'))).toBe(true);
  });

  it('never claims success when the backend fails', async () => {
    const c = await w.call();
    const broken = { plan: async () => { throw new Error('scheduler unavailable'); } };
    const out = await c.delegate([], broken);
    expect(spoken(out)).toContain('couldn\'t complete');
    expect(spoken(out)).not.toMatch(/booked|done|confirmed/);
  });

  it('transfers to the front desk only during hours, and offers a callback after', async () => {
    const c = await w.call();
    const out = await c.delegate([{ tool: 'transfer_call', args: { target: 'front_desk' } }]);
    expect(out.find((o) => o.type === 'transfer')).toBeUndefined();
    expect(spoken(out)).toContain('callback');
  });
});

describe('review fixes', () => {
  it('does not count a yes spoken before the read-back', async () => {
    const c = await w.call();
    c.caller('Maria Delgado, March 4 1985, sick visit');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'afternoon' } },
      { tool: 'propose_booking', args: (r) => ({ slot_id: firstSlot(r), replaces_appointment_id: null }) },
    ]);
    c.caller('yeah yeah'); // over the hold music, before anything was read back
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).errors).toEqual(['not_read_back']);
    c.assistant('Tuesday at 1:00 PM with Dr. Okafor for a sick visit. Shall I book it?');
    c.caller('Hmm, maybe.');
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).errors).toEqual(['no_clear_yes']);
    c.assistant('Would you like me to book it?');
    c.caller('Yes please.');
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).errors).toEqual([null]);
  });

  it('counts a read-back spoken in the same breath as "let me book that", as on the first live test call', async () => {
    const c = await w.call();
    c.caller('Maria Delgado, March 4 1985, sick visit, afternoon');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'afternoon' } },
    ]);
    c.assistant('I have 1, 2 or 3 PM. Which time would you like?');
    c.caller('3');
    c.assistant('Sure, I will go ahead and book that.'); // already speaking while the proposal runs
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()].at(-1)!, replaces_appointment_id: null }) }]);
    c.assistant('Tuesday at 3 PM with Dr. Okafor for a sick visit. Would you like me to book it?'); // same turn
    c.caller('Yeah');
    c.assistant('Alright, booking that now.');
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).errors).toEqual([null]);
  });

  it('ignores a cough or a breath after the yes', async () => {
    const c = await w.call();
    c.caller('Maria Delgado, March 4 1985, sick visit');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'afternoon' } },
      { tool: 'propose_booking', args: (r) => ({ slot_id: firstSlot(r), replaces_appointment_id: null }) },
    ]);
    c.assistant('Tuesday at 1:00 PM with Dr. Okafor for a sick visit. Shall I book it?');
    c.caller('Yes. I said yes');
    c.assistant('Thanks, I will book it.');
    c.caller('[clear throat');
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).errors).toEqual([null]);
  });

  it('refuses to move an appointment the caller does not have', async () => {
    const c = await w.call();
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: 'September 9 1962', phone: '303-555-0163' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    const out = await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: '00000000-0000-4000-8000-000000000000' }) }]);
    expect(out.errors).toEqual(['unknown_appointment']);
    expect(c.state.pending).toBeNull();
  });

  it('keeps listening after an emergency: a new kind gets its own instruction, and the task stays stopped', async () => {
    const c = await w.call('+13035550163');
    await c.delegate([{ tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: 'September 9 1962', phone: '303-555-0163' } }]);
    expect(c.caller('I have chest pain')).toHaveLength(2); // instruction + delayed transfer
    expect(c.caller('and now I think I passed out for a second')).toEqual([expect.objectContaining({ type: 'instructions' })]); // new kind, no second transfer
    expect(c.caller('chest pain still')).toEqual([]); // same kind, not repeated
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(out.errors).toEqual(['emergency_in_progress']);
  });

  it('honours "it is not an emergency" for the bare word, and never rings on-call for it', async () => {
    const c = await w.call();
    expect(c.caller('it is not an emergency, I just need a refill')).toEqual([]);
    const other = await w.call();
    expect(other.caller('this is kind of an emergency')).toEqual([expect.objectContaining({ type: 'instructions' })]);
  });

  it('refuses the writes of a request the caller has already replaced', async () => {
    const c = await w.call();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let late: { data: Record<string, unknown> } | undefined;
    const slow = { plan: async (_i: unknown, execute: (n: 'create_callback', a: unknown) => Promise<{ data: Record<string, unknown> }>) => {
      await gate;
      late = await execute('create_callback', { reason: 'the old request', callback_number: '+13035550147' });
      return { say: 'done' };
    } };
    const first = c.delegate([], slow as never);
    await c.delegate([{ tool: 'get_clinic_info', args: { question: 'address' } }]);
    release();
    expect([...(await first)]).toEqual([]);
    expect(late?.data.error).toBe('superseded');
  });

  it('puts transfers and hang-ups after the spoken result, with time to say it', async () => {
    const c = await w.call();
    const out = await c.delegate([{ tool: 'end_call', args: { reason: 'done' } }]);
    expect(out.map((o) => o.type)).toEqual(['thinking', 'commentary', 'hangup']);
    expect(out.at(-1)).toMatchObject({ type: 'hangup', afterMs: 3500 });
  });

  it('reports the booking as made even when the confirmation text fails', async () => {
    const c = await w.call();
    const original = w.backend.messenger.sendTemplate;
    w.backend.messenger.sendTemplate = async () => { throw new Error('twilio down'); };
    try {
      c.caller('James Whitaker, 9/9/1962, annual physical');
      await c.delegate([
        { tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: '9/9/1962', phone: '303-555-0163' } },
        { tool: 'find_slots', args: { visit_type_id: 'vt_annual', provider_id: null, from_date: '2026-10-05', part_of_day: 'any' } },
        { tool: 'propose_booking', args: (r) => ({ slot_id: firstSlot(r), replaces_appointment_id: null }) },
      ]);
      c.assistant('Monday October 5 at 8 AM. Shall I book it?');
      c.caller('Yes.');
      const out = await c.delegate([{ tool: 'commit_pending', args: {} }]);
      expect(spoken(out)).toContain('"booked":true');
      expect(spoken(out)).toContain('"sms_sent":false');
    } finally {
      w.backend.messenger.sendTemplate = original;
    }
  });
});
