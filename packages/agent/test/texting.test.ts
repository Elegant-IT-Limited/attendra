import { ClinicConfig, DEMO_CLINIC, RIVERBEND_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXTS_PER_CALL, type ToolResult } from '../src';
import { world } from './support';

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); });
afterAll(() => w.t.close());
beforeEach(() => { w.sms.length = 0; delete (w.backend.messenger as { optedOut?: unknown }).optedOut; });

const TEXTING = ClinicConfig.parse({
  ...DEMO_CLINIC, address: '214 Maple Street, Suite 3, Denver',
  texting: { enabled: true, links: [{ id: 'new_client', label: 'New client form', url: 'https://maple.example/new', when: 'a new patient asks about paperwork' }] },
});
const said = (r: ToolResult) => String(r.data.say ?? '');

describe('texting during a call', () => {
  it('asks first, sends after a clear yes, to the number they are calling from, once', async () => {
    const c = await w.call('+13035550147', { clinic: TEXTING });
    c.caller('Where are you located?');
    await c.delegate([{ tool: 'get_clinic_info', args: { question: 'address' } }]);
    const first = await c.delegate([{ tool: 'send_text', args: { kind: 'directions', ref: null, to: null } }]);
    expect(first.errors).toEqual(['consent_required']);
    expect(said(first.results[0]!)).toContain("Would you like me to text that to the number you're calling from?");
    expect(w.sms).toHaveLength(0);

    c.assistant("We're at 214 Maple Street. Would you like me to text that to the number you're calling from?");
    c.caller('Yes please.');
    const sent = await c.delegate([{ tool: 'send_text', args: { kind: 'directions', ref: null, to: null } }]);
    expect(sent.errors).toEqual([null]);
    expect(sent.results[0]!.data).toMatchObject({ texted: true, template: 'directions' });
    expect(w.sms).toMatchObject([{ to: '+13035550147', template: 'directions', language: 'en' }]);
    // a yes counts once: asking again is a new question
    const again = await c.delegate([{ tool: 'send_text', args: { kind: 'directions', ref: null, to: null } }]);
    expect(again.errors).toEqual(['consent_required']);
    expect(w.sms).toHaveLength(1);
  });

  it('sends nothing on a hedge', async () => {
    const c = await w.call('+13035550147', { clinic: TEXTING });
    await c.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }]);
    c.assistant("Would you like me to text that to the number you're calling from?");
    c.caller('Hmm, maybe, what time do you close Friday?');
    const out = await c.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }]);
    expect(out.errors).toEqual(['no_clear_yes']);
    expect(w.sms).toHaveLength(0);
  });

  it('takes a Spanish yes', async () => {
    const c = await w.call('+13035550147', { clinic: TEXTING });
    c.caller('¿A qué hora abren mañana?');
    await c.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }]);
    c.assistant('¿Quiere que se lo envíe por mensaje de texto al número desde el que llama?');
    c.caller('Sí, por favor.');
    const out = await c.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }]);
    expect(out.errors).toEqual([null]);
    expect(w.sms.at(-1)).toMatchObject({ template: 'hours', language: 'es' });
  });

  it('is off unless the clinic turned it and the kind on', async () => {
    const off = await w.call('+13035550147');
    expect((await off.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }])).errors).toEqual(['texting_off']);
    const noProvider = await w.call('+13035550147', { clinic: TEXTING }); // provider details are off by default
    const kindOff = await noProvider.delegate([{ tool: 'send_text', args: { kind: 'provider', ref: 'prov_okafor', to: null } }]);
    expect(kindOff.errors).toEqual(['texting_off']);
    // the clinic does text, just not this one: never "texting isn't set up" (a test call, 2026-10-25)
    expect(said(kindOff.results[0]!)).toContain("can't text that one");
    expect(said(kindOff.results[0]!)).toContain('Never say texting is not set up');
  });

  it('texts only the caller\'s number or the one on file, never another', async () => {
    const c = await w.call('+13035550147', { clinic: TEXTING });
    expect((await c.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: '+13035550999' } }])).errors).toEqual(['number_not_allowed']);
    const hidden = await w.call(null, { clinic: TEXTING });
    expect((await hidden.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }])).errors).toEqual(['no_number']);
  });

  it('never offers a text to a number abroad, and says so once (a test call from abroad, 2026-10-25)', async () => {
    const c = await w.call('+8801712345678', { clinic: TEXTING });
    c.caller('Can you text me the location?');
    const out = await c.delegate([{ tool: 'send_text', args: { kind: 'directions', ref: null, to: null } }]);
    expect(out.errors).toEqual(['not_textable']);
    expect(said(out.results[0]!)).toContain('never ask for another number');
    expect(c.state.callerNotTextable).toBe(true);
    expect(w.sms).toHaveLength(0);
    // and a premium US number is the same
    const premium = await w.call('+19005550123', { clinic: TEXTING });
    expect((await premium.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }])).errors).toEqual(['not_textable']);
  });

  it('has nothing to send for an answer not given, an unknown link, or no address', async () => {
    const c = await w.call('+13035550147', { clinic: TEXTING });
    expect((await c.delegate([{ tool: 'send_text', args: { kind: 'answer', ref: 'faq_fasting', to: null } }])).errors).toEqual(['nothing_to_send']);
    expect((await c.delegate([{ tool: 'send_text', args: { kind: 'link', ref: 'nope', to: null } }])).errors).toEqual(['nothing_to_send']);
    c.caller('Do I need to fast before my physical?');
    await c.delegate([{ tool: 'get_clinic_info', args: { question: 'fast before physical blood work' } }]);
    expect((await c.delegate([{ tool: 'send_text', args: { kind: 'answer', ref: 'faq_fasting', to: null } }])).errors).toEqual(['consent_required']);
    const noAddress = await w.call('+13035550147', { clinic: { ...TEXTING, address: undefined } });
    expect((await noAddress.delegate([{ tool: 'send_text', args: { kind: 'directions', ref: null, to: null } }])).errors).toEqual(['nothing_to_send']);
  });

  it('stops after the per-call limit, and for a number that opted out', async () => {
    const c = await w.call('+13035550147', { clinic: TEXTING });
    c.state.textsSent = MAX_TEXTS_PER_CALL;
    expect((await c.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }])).errors).toEqual(['rate_limited']);
    (w.backend.messenger as { optedOut?: () => Promise<boolean> }).optedOut = async () => true;
    const stop = await w.call('+13035550147', { clinic: TEXTING });
    const out = await stop.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }]);
    expect(out.errors).toEqual(['opted_out']);
    expect(said(out.results[0]!)).toContain('asked not to get texts');
  });

  it('in an animal emergency texts only the hospital, after the offer the script makes, and never in calm times', async () => {
    // the vet clinic's settings on the test clinic's record
    const vet = ClinicConfig.parse({ ...RIVERBEND_CLINIC, id: DEMO_CLINIC.id, phoneNumbers: DEMO_CLINIC.phoneNumbers, texting: { enabled: true } });
    const calm = await w.call('+13035550147', { clinic: vet });
    expect((await calm.delegate([{ tool: 'send_text', args: { kind: 'emergency_hospital', ref: null, to: null } }])).errors).toEqual(['not_an_emergency']);

    const c = await w.call('+13035550147', { clinic: vet });
    const script = c.caller('My dog ate a whole bar of dark chocolate!');
    expect(JSON.stringify(script)).toContain("I can text you the hospital's address and number right now; shall I?");
    expect((await c.delegate([{ tool: 'send_text', args: { kind: 'hours', ref: null, to: null } }])).errors).toEqual(['emergency_in_progress']);
    c.assistant("Please take your pet to Front Range Pet Emergency right away. I can text you the hospital's address and number right now; shall I?");
    c.caller('Yes, please.');
    const out = await c.delegate([{ tool: 'send_text', args: { kind: 'emergency_hospital', ref: null, to: null } }]);
    expect(out.errors).toEqual([null]);
    expect(w.sms.at(-1)).toMatchObject({ template: 'emergency_hospital' });
  });

  it('confirms a cancellation by text, like a booking', async () => {
    const c = await w.call('+13035550147', { clinic: TEXTING });
    c.caller('Maria Delgado, March 4th 1985. I want to see a doctor.');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    c.assistant('Shall I book it?');
    c.caller('Yes.');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    const [appt] = await w.backend.scheduler.upcoming(DEMO_CLINIC.id, w.patientIds.maria!, new Date('2026-09-28T00:00:00Z'));
    c.caller('Actually, please cancel it.');
    await c.delegate([{ tool: 'propose_cancellation', args: { appointment_id: appt!.id } }]);
    c.assistant('Cancel the appointment on Tuesday?');
    c.caller('Yes, cancel it.');
    const out = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(out.results[0]!.data).toMatchObject({ cancelled: true, sms_sent: true });
    expect(w.sms.map((s) => s.template)).toEqual(['booking_confirmed', 'cancel_confirmed']);
  });
});

describe('the reminder question after a booking', () => {
  const REMINDERS = ClinicConfig.parse({ ...DEMO_CLINIC, texting: { reminders: { enabled: true } } });
  const book = async (c: Awaited<ReturnType<typeof w.call>>) => {
    c.caller('Maria Delgado, March 4th 1985. I need to see a doctor.');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    c.assistant('Shall I book it?');
    c.caller('Yes.');
    return (await c.delegate([{ tool: 'commit_pending', args: {} }])).results[0]!;
  };
  const textsOk = async () => {
    const found = await w.backend.patients.findByIdentity(DEMO_CLINIC.id, 'Maria Delgado', '1985-03-04', '+13035550147');
    return found.status === 'found' && !!found.patient.textsOk;
  };

  it('is asked once after a booking; a hedge records nothing', async () => {
    const c = await w.call('+13035550147', { clinic: REMINDERS });
    expect(said(await book(c))).toContain('Would you like a reminder text the day before the visit? Message and data rates may apply, and you can reply STOP anytime.');
    expect((await c.delegate([{ tool: 'set_reminder_consent', args: { agreed: true } }])).errors).toEqual(['not_asked']);
    c.assistant("You're booked. Would you like a reminder text the day before the visit? Message and data rates may apply, and you can reply STOP anytime.");
    c.caller('Hmm, I am not sure.');
    expect((await c.delegate([{ tool: 'set_reminder_consent', args: { agreed: true } }])).results[0]!.data).toMatchObject({ reminders: false });
    expect(await textsOk()).toBe(false);
    // answered once: not asked again
    expect((await c.delegate([{ tool: 'set_reminder_consent', args: { agreed: true } }])).errors).toEqual(['not_offered']);
  });

  it('keeps a clear yes on the record, and does not ask someone who already said yes', async () => {
    const c = await w.call('+13035550147', { clinic: REMINDERS });
    await book(c);
    c.assistant("You're booked. Would you like a reminder text the day before the visit? Message and data rates may apply, and you can reply STOP anytime.");
    c.caller('Yes please.');
    expect((await c.delegate([{ tool: 'set_reminder_consent', args: { agreed: true } }])).results[0]!.data).toMatchObject({ reminders: true });
    expect(await textsOk()).toBe(true);
    const next = await w.call('+13035550147', { clinic: REMINDERS });
    expect(said(await book(next))).not.toContain('reminder');
  });

  it('is never asked when the clinic does not send reminders', async () => {
    const c = await w.call('+13035550147');
    expect((await c.delegate([{ tool: 'set_reminder_consent', args: { agreed: true } }])).errors).toEqual(['identity_required']);
  });
});
