import { CallRepository, createPhiCipher, PostgresPatientDirectory, seedRiverbend } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Anonymiser, emptyKnown } from '../src/anonymise';
import { type CallForDraft, draftScenario, knownFromConfig, loadCall } from '../src/draft-from-call';
import { Scenario } from '../src/scenario';

// A made-up call that looks like a real one: every name, number, address, email and date here is invented,
// and none of it may survive the anonymiser.
const CLINIC = {
  name: 'Pine Hollow Animal Clinic', industry: 'vet', assistantName: 'Wren', address: '4417 Quillon Avenue, Fernbrook',
  phoneNumbers: ['+13035550170'], routing: [{ target: 'front_desk', uri: 'tel:+13035550171' }],
  providers: [{ name: 'Dr. Tobias Quillfeather', categories: ['Dogs', 'Cats'] }, { name: 'Dr. Ingrid Marchetti', categories: ['Rabbits'] }],
  visitTypes: [{ name: 'wellness exam', names: { es: 'chequeo general' } }, { name: 'Senior Wellness Panel' }],
  emergencyHospital: { name: 'Larkmoor Pet Emergency', phone: '+13035550188', address: '980 Tamsin Road, Fernbrook' },
};
const known = knownFromConfig(CLINIC);
known.numbers.unshift('+1 303 555 0187');
known.owners.push('Marisol Fenwick', 'Fenwick');
known.pets.push('Waffles', 'Noodle');
known.numbers.push('303-555-0187');

const CALL: CallForDraft = {
  callId: 'abcdefab-0000-4000-8000-000000000001',
  startedAt: new Date('2026-11-02T16:05:00Z'),
  timezone: 'America/Denver',
  industry: 'vet',
  channel: 'web',
  outcome: 'booked',
  language: 'en',
  callerNumber: '+1 303 555 0187',
  known,
  actions: [
    { tool: 'verify_caller', atMs: 9000, error: 'phone_required' },
    { tool: 'register_patient', atMs: 21000, error: null },
    { tool: 'find_slots', atMs: 33000, error: null },
  ],
  segments: [
    { speaker: 'agent', startMs: 0, endMs: 3500, text: "Thanks for calling Pine Hollow Animal Clinic, I'm Wren. How can I help you and your pet today?" },
    { speaker: 'caller', startMs: 5000, endMs: 8000, text: 'Hi, this is Marisol Fenwick. My dog Waffles needs a check-up, and we have a new kitten, Juniper Bean.' },
    { speaker: 'agent', startMs: 9500, endMs: 12000, text: "Sure, Marisol. What phone number is your pet's profile under?" },
    { speaker: 'caller', startMs: 13000, endMs: 19000, text: "It's seven two oh, five five five, oh one eight seven. Or my husband Dashiell's, 303-555-0164." },
    { speaker: 'caller', startMs: 19500, endMs: 20500, text: 'Sorry, I mean three oh three, five five five, oh one eight seven.' },
    { speaker: 'agent', startMs: 22000, endMs: 26000, text: 'Thanks. And the new kitten, when was she born?' },
    { speaker: 'caller', startMs: 27000, endMs: 31000, text: 'March 14, 2026, so 03/14/2026. Noodle is the older one, born 2019-06-02.' },
    { speaker: 'caller', startMs: 31500, endMs: 32500, text: 'We moved to 4417 Quillon Avenue, Apt 3B, in Fernbrook. Email me at marisol.fenwick@fernmail.test or marisol dot fenwick at fernmail dot com.' },
    { speaker: 'agent', startMs: 34000, endMs: 38000, text: 'Dr. Quillfeather has Wednesday at 4:40 PM. Or Dr. Marchetti at 9:00 AM.' },
    { speaker: 'caller', startMs: 39000, endMs: 41000, text: 'Quillfeather at four forty pm is great. Ref code X7Q-22#9, member 48213.' },
    { speaker: 'agent', startMs: 42000, endMs: 44000, text: "You're all set with Dr. Tobias Quillfeather at Pine Hollow. If it's an emergency, Larkmoor Pet Emergency is at 980 Tamsin Road." },
  ],
};

// every real thing in the fixture, as words or digits
const FORBIDDEN = [
  'Pine Hollow', 'Pine', 'Hollow', 'Wren', 'Tobias', 'Quillfeather', 'Ingrid', 'Marchetti', 'Larkmoor', 'Tamsin', 'Quillon', 'Fernbrook', 'Marisol', 'Fenwick',
  'Waffles', 'Noodle', 'Juniper Bean', 'Bean', 'Dashiell', 'fernmail', '4417', '980', '0187', '0164', '0170', '0171', '0188', '3035550187', '720',
  'seven two oh', 'three oh three', 'oh one eight seven', 'five five five', '03/14', 'March 14', '2026-', '2019', '48213', 'X7Q', '3B',
];

describe('the anonymiser', () => {
  const yaml = draftScenario(CALL);

  it('replaces every name, number (written or spoken), address, email and date of birth in the fixture', () => {
    for (const real of FORBIDDEN) expect(yaml.toLowerCase(), real).not.toContain(real.toLowerCase());
    // the only digit runs of three or more are the made-up numbers and dates, the call's local time and its id
    const rest = yaml.replace(/303-555-01\d\d|555-01\d\d|2020-01-01|01\/01\/2020|January 1, 2020|100 Main Street|abcdefab|"09:05"/g, '');
    expect(rest).not.toMatch(/\d{3,}/);
  });

  it('keeps the shape of the call: the caller lines in order, made up consistently, the visit words and times kept', () => {
    expect(yaml).toContain('"Hi, this is Jordan Lee. My dog Biscuit needs a check-up, and we have a new kitten, Robin Avery."');
    // the caller's number is 303-555-0100 wherever it is said, in words or digits; another number gets another made-up one
    expect(yaml).toContain('"Sorry, I mean 303-555-0100."');
    expect(yaml).toContain('"It\'s 303-555-0104. Or my husband Quinn\'s, 303-555-0105."');
    expect(yaml).toContain('"January 1, 2020, so 01/01/2020. Pepper is the older one, born 2020-01-01."');
    expect(yaml).toContain('"We moved to 100 Main Street, Apt 1, in Drew. Email me at jordan@example.com or jordan at example dot com."');
    expect(yaml).toContain('# TODO expected: Dr. Ruiz has Wednesday at 4:40 PM. Or Dr. Bell at 9:00 AM.');
    expect(yaml).toContain('"Ruiz at four forty pm is great. Rowan code [redacted] member 303-555-0106."');
    expect(yaml).toContain("# the call's tools after this line: verify_caller (phone_required)");
  });

  it('writes a scenario the eval loader accepts, tagged as a draft', () => {
    const s = Scenario.parse(parse(yaml));
    expect(s).toMatchObject({ id: 'draft-from-call-abcdefab', clinic: 'riverbend', channel: 'web', caller_number: null, local_time: '09:05', tags: ['draft', 'from-call'], expect: { outcome: 'booked' } });
    expect(s.turns).toHaveLength(6);
    expect(s.turns.every((t) => 'caller' in t)).toBe(true);
  });

  it('gives the same output every time', () => {
    expect(draftScenario(CALL)).toBe(yaml);
    expect(draftScenario(structuredClone(CALL))).toBe(yaml);
  });

  it('fails closed: a token it cannot read is replaced, an unknown capitalised word becomes a made-up name', () => {
    const a = new Anonymiser(emptyKnown());
    expect(a.text('Code A1B2C3, paid $40 & 50% off')).toBe('Robin [redacted] paid [redacted] [redacted] [redacted] off');
    expect(a.text('Talk to Thaddeus or thaddeus')).toBe('Talk to Avery or thaddeus');
    expect(a.text('one, two dogs; the one at 10:30 or 11')).toBe('one, two dogs; the one at 10:30 or 11');
    expect(a.text('nueve ocho siete seis')).toBe('303-555-0100');
  });
});

describe('a draft from a stored call', () => {
  it('reads the call, its clinic and the household on its number, anonymises it all, and audits the read', async () => {
    const cipher = createPhiCipher(TEST_DATA_KEY);
    const t = await openTestDatabase();
    try {
      await seedRiverbend(t.db, cipher);
      const C = RIVERBEND_CLINIC.id;
      const calls = new CallRepository(t.db, cipher);
      const callId = await calls.open(C, 'sess_draft', '+17205550172');
      await new PostgresPatientDirectory(t.db, cipher).create(C, { firstName: 'Tolliver', lastName: 'Nguyen', dob: '2025-01-01', phone: '+17205550172', guardianName: 'Linh Nguyen', species: 'Cat' });
      await calls.appendSegment(C, callId, { speaker: 'agent', text: 'Thanks for calling Riverbend Animal Hospital.', startMs: 0, endMs: 2000 });
      await calls.appendSegment(C, callId, { speaker: 'caller', text: 'Hi, Linh here, calling about Tolliver and Mochi. My number is 720 555 0172.', startMs: 3000, endMs: 6000 });
      await calls.recordAction(C, callId, { tool: 'verify_caller', argsRedacted: ['phone'], result: { ok: false, error: 'confirm_number' }, taskRevision: 1 });
      const call = await loadCall(t.db, cipher, callId);
      expect(call).not.toBeNull();
      const yaml = draftScenario(call!);
      for (const real of ['Linh', 'Nguyen', 'Tolliver', 'Mochi', '0172', 'Elena']) expect(yaml).not.toContain(real);
      expect(Scenario.parse(parse(yaml))).toMatchObject({ clinic: 'riverbend', channel: 'phone', caller_number: '303-555-0100', tags: ['draft', 'from-call'] });
      expect(yaml).toContain('My number is 303-555-0100.');
      expect(yaml).toContain('verify_caller (confirm_number)');
      const audit = (await t.db.execute(sql`select count(*)::int as n from audit_logs where action = 'call.transcript.drafted'`)).rows;
      expect(audit).toEqual([{ n: 1 }]);
      expect(await loadCall(t.db, cipher, '00000000-0000-4000-8000-000000000000')).toBeNull();
    } finally {
      await t.close();
    }
  });
});
