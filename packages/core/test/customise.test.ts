import { describe, expect, it } from 'vitest';
import { asE164, greetingFor, PACKS, textingOf, bookableProviders, ClinicConfig, clinicWarnings, currentOffers, DEMO_CLINIC, detectEmergencies, emergencyNumberFor, emergencyNumberProblem, hospitalFor, matchesSpecialty, readCustomValues, RIVERBEND_CLINIC, starterClinic, visitTypeFacts, zonedInstant } from '../src';

describe('what a clinic customises', () => {
  it('shows offers only between their dates', () => {
    const c = { offers: [
      { id: 'a', title: 'Vaccine clinic', details: 'Saturdays', from: '2026-10-01', to: '2026-10-31' },
      { id: 'b', title: 'Always on', details: 'Every day' },
      { id: 'c', title: 'Not yet', details: 'Soon', from: '2026-11-01' },
    ] };
    expect(currentOffers(c, '2026-10-20').map((o) => o.title)).toEqual(['Vaccine clinic', 'Always on']);
    expect(currentOffers(c, '2026-11-02').map((o) => o.title)).toEqual(['Always on', 'Not yet']);
    expect(currentOffers({}, '2026-10-20')).toEqual([]);
  });

  it('keeps a visit type as it was when nothing is customised', () => {
    expect(visitTypeFacts(DEMO_CLINIC, 'en')[0]).not.toHaveProperty('description');
    expect(visitTypeFacts(DEMO_CLINIC, 'en')[0]).not.toHaveProperty('booked_by');
  });

  it('checks links, offers and credentials', () => {
    const ok = ClinicConfig.safeParse({ ...DEMO_CLINIC, menuLinks: [{ label: 'ezyVet', url: 'https://ezyvet.example' }] });
    expect(ok.success).toBe(true);
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, menuLinks: [{ label: 'Bad', url: 'http://x.example' }] }).success).toBe(false);
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, offers: [{ id: 'o', title: 'Backwards', details: 'Dates wrong', from: '2026-10-31', to: '2026-10-01' }] }).success).toBe(false);
    const p = { ...DEMO_CLINIC.providers[0]!, credentials: ['x'] };
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, providers: [p] }).success).toBe(false);
  });
});

describe("the clinic's own fields on a record", () => {
  const fields = [{ id: 'chip', label: 'Microchip', kind: 'text' as const }, { id: 'insured', label: 'Insured', kind: 'yesno' as const }, { id: 'due', label: 'Rabies due', kind: 'date' as const }];

  it('keeps trimmed values, leaves empty ones out, and checks each kind', () => {
    expect(readCustomValues(fields, { chip: ' 985 ', insured: 'no', due: '' })).toEqual({ ok: true, values: { chip: '985', insured: 'no' } });
    expect(readCustomValues(fields, { insured: 'maybe' })).toMatchObject({ ok: false, field: 'insured' });
    expect(readCustomValues(fields, { due: '1 May' })).toMatchObject({ ok: false, field: 'due' });
    expect(readCustomValues(fields, { chip: 'x'.repeat(201) })).toMatchObject({ ok: false, field: 'chip' });
    expect(readCustomValues(fields, { other: 'x' })).toMatchObject({ ok: false, field: 'other' });
  });

  it('refuses two fields with the same id', () => {
    const r = ClinicConfig.safeParse({ ...DEMO_CLINIC, customFields: [fields[0], { ...fields[1], id: 'chip' }] });
    expect(r.success).toBe(false);
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, customFields: fields }).success).toBe(true);
  });
});

describe('transfer numbers', () => {
  it('warns when a transfer would ring a number the assistant answers', () => {
    const loop = { ...DEMO_CLINIC, routing: [{ target: 'front_desk' as const, uri: `tel:${DEMO_CLINIC.phoneNumbers[0]}`, when: 'open' as const, priority: 0 }] };
    expect(clinicWarnings(loop).map((w) => w.path)).toContain('routing');
    expect(clinicWarnings(DEMO_CLINIC).map((w) => w.path)).not.toContain('routing');
  });
});

describe('asking about emergencies', () => {
  it('is not an emergency itself, while a real one in the same breath still is', () => {
    expect(detectEmergencies('is this an emergency or can it wait')).toEqual([]);
    expect(detectEmergencies('what counts as an emergency for you')).toEqual([]);
    expect(detectEmergencies('this is an emergency').map((m) => m.kind)).toEqual(['general']);
    expect(detectEmergencies('my husband has chest pain, is this an emergency').map((m) => m.kind)).toContain('cardiac');
  });
});

describe('emergency hospitals', () => {
  const night = { name: 'Night Vets', phone: '+17205550101', address: '1 Night Road, Denver', hours: { open: '18:00', close: '08:00' } };
  const day = { name: 'Day Referral', phone: '+17205550102', address: '2 Day Road, Denver', hours: { open: '08:00', close: '18:00' } };
  const at = (time: string) => zonedInstant('2026-10-20', time, RIVERBEND_CLINIC.timezone);

  it('sends a caller to the first choice open now, overnight hours included, and to none when all are closed', () => {
    const clinic = { ...RIVERBEND_CLINIC, emergencyHospital: night, moreEmergencyHospitals: [day] };
    expect(hospitalFor(clinic, at('22:00'))?.name).toBe('Night Vets');
    expect(hospitalFor(clinic, at('03:00'))?.name).toBe('Night Vets');
    expect(hospitalFor(clinic, at('10:00'))?.name).toBe('Day Referral');
    expect(hospitalFor({ ...clinic, moreEmergencyHospitals: undefined }, at('10:00'))).toBeNull();
    expect(hospitalFor(RIVERBEND_CLINIC, at('10:00'))?.name).toBe('Front Range Pet Emergency'); // no hours: around the clock
  });
});

describe('emergency numbers by country', () => {
  it('knows the numbers of more countries, and keeps 112 for the rest', () => {
    const at = (n: string) => emergencyNumberFor({ phoneNumbers: [n] });
    expect([at('+13035550100'), at('+442079460123'), at('+61298765432'), at('+6495551234'), at('+525512345678'), at('+81312345678'), at('+353115551234'), at('+33155551234'), at('+9771234567')])
      .toEqual(['911', '999', '000', '111', '911', '119', '112', '112', '112']);
    expect(emergencyNumberProblem({ phoneNumbers: ['+353115551234'], emergencyNumber: '999' })).toBeNull();
  });
});

describe('who a caller can be offered', () => {
  it('matches an animal to the group a vet is listed for, and steps the starter vet aside once there is a real one', () => {
    expect(matchesSpecialty({ categories: ['Exotics'] }, 'rabbit')).toBe(true);
    expect(matchesSpecialty({ categories: ['Birds'] }, 'parrot')).toBe(true);
    expect(matchesSpecialty({ categories: ['Dogs', 'Cats'] }, 'rabbit')).toBe(false);
    const starter = starterClinic({ id: 'clinic_x', name: 'Oak Vets', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550100' });
    expect(bookableProviders(starter.providers).map((p) => p.id)).toEqual(['prov_1']);
    const withVet = [...starter.providers, { ...starter.providers[0]!, id: 'prov_patel', name: 'Dr. Patel', placeholder: undefined }];
    expect(bookableProviders(withVet).map((p) => p.id)).toEqual(['prov_patel']);
  });
});

describe('phone numbers staff type', () => {
  it('are kept as E.164 in the clinic\'s country, so texts reach them', () => {
    expect(asE164({ phoneNumbers: ['+13035550100'] }, '(303) 555-0142')).toBe('+13035550142');
    expect(asE164({ phoneNumbers: ['+442079460123'] }, '07700 900123')).toBe('+447700900123');
    expect(asE164({ phoneNumbers: ['+442079460123'] }, '+1 303 555 0142')).toBe('+13035550142');
    expect(asE164({ phoneNumbers: ['+13035550100'] }, '555-0142')).toBe('555-0142');
  });
});

describe('texting and greetings in other languages', () => {
  it('reads an older configuration with texting off and every kind at its default', () => {
    const c = ClinicConfig.parse(DEMO_CLINIC);
    expect(c.texting).toBeUndefined();
    expect(textingOf(c)).toMatchObject({ enabled: false, kinds: { change_confirmed: true, directions: true, provider: false }, links: [] });
  });

  it('refuses two links with one id, and a link that is not https', () => {
    const link = { id: 'form', label: 'New client form', url: 'https://x.example/form', when: 'a new client asks' };
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, texting: { enabled: true, links: [link, link] } }).success).toBe(false);
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, texting: { enabled: true, links: [{ ...link, url: 'http://x.example' }] } }).success).toBe(false);
  });

  it('warns when directions are texted with no address', () => {
    expect(clinicWarnings({ ...DEMO_CLINIC, texting: { ...textingOf(DEMO_CLINIC), enabled: true } }).some((w) => w.path === 'texting')).toBe(true);
    expect(clinicWarnings({ ...DEMO_CLINIC, address: '214 Maple Street', texting: { ...textingOf(DEMO_CLINIC), enabled: true } }).some((w) => w.path === 'texting')).toBe(false);
  });

  it('takes a Spanish greeting only when it says it is an AI assistant, and falls back to the suggestion', () => {
    const ok = ClinicConfig.parse({ ...DEMO_CLINIC, greetings: { es: 'Gracias por llamar. Soy Maya, la asistente virtual de la clínica. ¿En qué le puedo ayudar?' } });
    expect(greetingFor(ok, 'es')).toContain('asistente virtual');
    expect(greetingFor(ok, 'en')).toBe(DEMO_CLINIC.greeting);
    const hidden = ClinicConfig.safeParse({ ...DEMO_CLINIC, greetings: { es: 'Gracias por llamar a la clínica. ¿En qué le puedo ayudar?' } });
    expect(hidden.success).toBe(false);
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, greetings: { en: 'Thanks for calling, I am the AI assistant here.' } }).success).toBe(false); // the main language uses the greeting
    expect(greetingFor({ ...DEMO_CLINIC, greetings: undefined }, 'es')).toBe(PACKS.es.greeting({ assistantName: DEMO_CLINIC.assistantName ?? null, clinicName: DEMO_CLINIC.name }));
  });
});
