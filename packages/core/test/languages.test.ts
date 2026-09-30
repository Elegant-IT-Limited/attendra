import { describe, expect, it } from 'vitest';
import {
  allowedEmergencyNumbers, ClinicConfig, clinicWarnings, countryCopy, crisisLineFor, DEMO_CLINIC, detectEmergencies, detectEmergency, detectLanguage, emergencyNumberFor, emergencyNumberProblem,
  isClearYes, type Language, LANGUAGES, localName, normalise, PACKS, parseDob, speakSlot, zonedInstant,
} from '../src';

const TODAY = new Date('2026-09-29T00:00:00Z');

describe('language packs', () => {
  it('every pack has a greeting that passes its own disclosure check, with and without a name', () => {
    for (const code of LANGUAGES) {
      const pack = PACKS[code];
      for (const assistantName of ['Maya', null]) {
        const greeting = pack.greeting({ assistantName, clinicName: 'Test Clinic' });
        expect(pack.disclosure.test(normalise(greeting)), `${code} ${assistantName}`).toBe(true);
        expect(greeting).not.toMatch(/attendra/i);
      }
    }
  });

  it('every pack writes both texts from the same three variables, and nothing clinical', () => {
    for (const code of LANGUAGES) {
      for (const render of Object.values(PACKS[code].sms)) {
        const text = render({ clinic: 'C', when: 'W', clinicPhone: 'P' });
        expect(text).toContain('C');
        expect(text).toContain('W');
        expect(text).toContain('P');
        expect(text).not.toMatch(/undefined/);
      }
    }
  });
});

describe('speaking dates and numbers', () => {
  it('Spanish uses the article with the hour', () => {
    const denver = DEMO_CLINIC.timezone;
    expect(speakSlot(zonedInstant('2026-09-29', '13:00', denver), denver, 'es')).toMatch(/^martes, 29 de septiembre a la 1:00/);
    expect(speakSlot(zonedInstant('2026-09-29', '15:00', denver), denver, 'es')).toMatch(/^martes, 29 de septiembre a las 3:00/);
  });

  it('English is unchanged', () => {
    const denver = DEMO_CLINIC.timezone;
    expect(speakSlot(zonedInstant('2026-09-29', '08:00', denver), denver)).toBe('Tuesday, September 29 at 8:00 AM');
  });

  it('phone numbers are read digit by digit', () => {
    expect(PACKS.en.speakPhone('+13035550100')).toBe('one three zero three five five five zero one zero zero');
  });
});

describe('the emergency guardrail in every language', () => {
  const cases: [string, string, string][] = [
    ['me duele mucho el pecho', 'cardiac', 'es'],
    ['no puedo respirar', 'breathing', 'es'],
    ['mi esposo está inconsciente', 'unresponsive', 'es'],
    ['está sangrando mucho', 'bleeding', 'es'],
    ['quiero quitarme la vida', 'self_harm', 'es'],
    ['necesito una ambulancia', 'general', 'es'],
    ['mi padre no puede hablar bien', 'stroke', 'es'],
    ['tiene la cara caída', 'stroke', 'es'],
    ['se tomó todas las pastillas', 'overdose', 'es'],
    ['mi hijo se tomó algo del garaje', 'overdose', 'es'],
    ['creo que tomó veneno', 'overdose', 'es'],
    ['se me está cerrando la garganta', 'allergic', 'es'],
  ];
  for (const [text, kind, language] of cases) {
    it(`"${text}" is ${kind}, heard as ${language}`, () => {
      expect(detectEmergency(text)).toMatchObject({ kind, language });
    });
  }

  it('checks every language whatever the clinic offers, so a Spanish emergency at an English-only clinic is still caught', () => {
    expect(detectEmergencies('Hello, me duele el pecho').map((m) => m.kind)).toEqual(['cardiac']);
  });

  it('honours "not an emergency" in Spanish, for the generic word only', () => {
    expect(detectEmergency('no es una emergencia, solo quiero una cita')).toBeNull();
    expect(detectEmergency('no es una emergencia pero me duele el pecho')?.kind).toBe('cardiac');
  });

  it('does not fire on ordinary words that look like a phrase', () => {
    for (const t of ['quiero un examen de pecho la próxima semana', 'report kobe pabo', 'I need a blood test', 'the sample was given', 'se tomó el día libre']) {
      expect(detectEmergency(t), t).toBeNull();
    }
  });

  it('uses the clinic\'s emergency number, or the country\'s', () => {
    expect(emergencyNumberFor(DEMO_CLINIC)).toBe('911');
    expect(emergencyNumberFor({ phoneNumbers: ['+442071234567'] })).toBe('999');
    expect(emergencyNumberFor({ phoneNumbers: ['+442071234567'], emergencyNumber: '112' })).toBe('112');
    expect(emergencyNumberFor({ phoneNumbers: ['+61291234567'] })).toBe('000');
    expect(emergencyNumberFor({ phoneNumbers: ['+4930123456'] })).toBe('112');
    expect(emergencyNumberFor({ phoneNumbers: ['+33142685300'] })).toBe('112');
  });

  it('takes an emergency number only from the country\'s list, so a typo is never spoken', () => {
    expect(allowedEmergencyNumbers(['+13035550100'])).toEqual(['911']);
    expect(allowedEmergencyNumbers(['+442071234567'])).toEqual(['999', '112']);
    expect(allowedEmergencyNumbers(['+61291234567'])).toEqual(['000', '112']);
    expect(emergencyNumberProblem({ phoneNumbers: ['+13035550100'], emergencyNumber: '91' })).toMatch(/911/);
    expect(emergencyNumberProblem({ phoneNumbers: ['+13035550100'], emergencyNumber: '112' })).toMatch(/911/);
    expect(emergencyNumberProblem({ phoneNumbers: ['+442071234567'], emergencyNumber: '911' })).toMatch(/999/);
    expect(emergencyNumberProblem({ phoneNumbers: ['+13035550100'], emergencyNumber: '911' })).toBeNull();
    // a number saved before the rule is not spoken: the country's is
    expect(emergencyNumberFor({ phoneNumbers: ['+13035550100'], emergencyNumber: '91' })).toBe('911');
    expect(crisisLineFor(DEMO_CLINIC)).toBe('988');
    expect(crisisLineFor({ phoneNumbers: ['+442071234567'] })).toBeNull();
  });
});

describe('read-backs name a person or a room properly', () => {
  const v = { when: 'Tuesday at 8:00 AM', visit: 'blood test', replacing: null };
  it.each([
    ['en', 'person', 'Dr. Ann Lindqvist', 'Tuesday at 8:00 AM with Dr. Ann Lindqvist for a blood test'],
    ['en', 'room', 'Sample collection room', 'Tuesday at 8:00 AM in the sample collection room for a blood test'],
    ['es', 'person', 'Dra. Ann Lindqvist', 'Tuesday at 8:00 AM con Dra. Ann Lindqvist, para blood test'],
    ['es', 'room', 'la sala de muestras', 'Tuesday at 8:00 AM en la sala de muestras, para blood test'],
  ] as const)('%s, a %s', (language, providerKind, provider, expected) => {
    expect(PACKS[language].readbackBooking({ ...v, provider, providerKind })).toBe(expected);
  });

  it('keeps an existing provider a person', () => {
    expect(ClinicConfig.parse({ ...DEMO_CLINIC, providers: DEMO_CLINIC.providers.map(({ kind: _k, ...p }) => p) }).providers.every((p) => p.kind === 'person')).toBe(true);
  });
});

describe('wording that follows the clinic\'s country', () => {
  it('names US consent law only for US clinics, and gives each country its own example numbers and date order', () => {
    expect(countryCopy(DEMO_CLINIC)).toMatchObject({ us: true, exampleDob: '03/04/1985', phone: { e164: '+13035550123' } });
    expect(countryCopy(DEMO_CLINIC).recordingHint).toContain('US states');
    const uk = countryCopy({ phoneNumbers: ['+442071234567'] });
    expect(uk).toMatchObject({ us: false, exampleDob: '04/03/1985', phone: { e164: '+442079460123', local: '020 7946 0123' } });
    expect(uk.recordingHint).toBe('Off by default. Check the law where you are before recording calls. A notice plays first.');
    expect(countryCopy({ phoneNumbers: ['+61291234567'] }).phone.e164).toBe('+61491570123');
  });
});

describe('the software\'s name', () => {
  it('in a greeting or as the assistant\'s name is a warning in Settings, never a configuration that fails to load', () => {
    const named = { ...DEMO_CLINIC, greeting: 'Thanks for calling, this is the Attendra AI assistant.', assistantName: 'Attendra' };
    expect(ClinicConfig.safeParse(named).success).toBe(true);
    expect(clinicWarnings(named).map((w) => w.path)).toEqual(['greeting', 'assistantName']);
    expect(clinicWarnings(DEMO_CLINIC)).toEqual([]);
  });
});

describe('a clear yes in every language', () => {
  const ALL = LANGUAGES;
  it('accepts a plain yes in Spanish', () => {
    for (const t of ['Sí', 'sí, claro', 'correcto', 'está bien', 'de acuerdo']) {
      expect(isClearYes(t, ALL), t).toBe(true);
    }
  });

  it('refuses a hedge in any language, even next to a yes', () => {
    for (const t of ['no', 'sí, pero espere', 'mejor otro día', 'tal vez', '¿el jueves?', 'sí, maybe']) {
      expect(isClearYes(t, ALL), t).toBe(false);
    }
  });

  it('keeps the English rules as they were', () => {
    expect(isClearYes('Yes, please book it.', ['en'])).toBe(true);
    expect(isClearYes('yes, actually no', ['en'])).toBe(false);
  });

  it('does not hear a yes inside an ordinary sentence, or past a "but"', () => {
    const cases: [string, readonly Language[]][] = [
      ['I need to confirm with my wife first', ['en']],
      ['I need to confirm with my wife first', ALL],
      ['Ella ha dicho que el lunes', ['es']],
      ['Ella ha dicho que el lunes', ALL],
      ['por favor repita la hora', ['es']],
      ['si puede el martes', ['es']],
      ['sí, pero prefiero el martes', ['es']],
      ['claro, pero el martes', ['es']],
      ['I have to check, ha', ['en']],
      ['I have to check, ha', ALL],
      ['yes, but not Monday', ['en']],
      ['yes, although Friday is better', ['en']],
      ['sí, aunque mejor el jueves', ['es']],
    ];
    for (const [t, langs] of cases) expect(isClearYes(t, langs), `${t} (${langs.join(',')})`).toBe(false);
  });

  it('takes a yes word only in a language the clinic offers', () => {
    expect(isClearYes('claro', ['en'])).toBe(false);
    expect(isClearYes('yes', ['es'])).toBe(false);
  });

  it('still takes a plain yes in each language, and a short word said alone', () => {
    expect(isClearYes('Yes, that\'s right.', ['en'])).toBe(true);
    expect(isClearYes('Confirm.', ['en'])).toBe(true);
    expect(isClearYes('Sí, correcto.', ['es'])).toBe(true);
    expect(isClearYes('Sí.', ['es'])).toBe(true);
    expect(isClearYes('Por favor.', ['es'])).toBe(true);
  });
});

describe('choosing the reply language', () => {
  it('stays in the primary language until the caller speaks another the clinic offers', () => {
    expect(detectLanguage('', ['en', 'es'], 'en')).toBe('en');
    expect(detectLanguage('Hola, quiero una cita para mañana', ['en', 'es'], 'en')).toBe('es');
    expect(detectLanguage('I want an appointment for tomorrow', ['en', 'es'], 'en')).toBe('en');
  });

  it('never picks a language the clinic does not offer', () => {
    expect(detectLanguage('Hola, quiero una cita', ['en'], 'en')).toBe('en');
  });
});

describe('dates of birth in other languages', () => {
  it('reads Spanish months', () => {
    expect(parseDob('4 de marzo de 1985', TODAY)).toBe('1985-03-04');
    expect(parseDob('el 9 de septiembre de 1962', TODAY)).toBe('1962-09-09');
    expect(parseDob('9 de septiembre de 1962', TODAY)).toBe('1962-09-09');
  });

  it('reads a numeric date day first outside North America', () => {
    expect(parseDob('20/02/1992', TODAY, 'dmy')).toBe('1992-02-20');
    expect(parseDob('03/04/1985', TODAY, 'dmy')).toBe('1985-04-03');
    expect(parseDob('03/04/1985', TODAY)).toBe('1985-03-04');
    expect(parseDob('20/02/1992', TODAY)).toBeNull();
  });
});

describe('clinic languages and the assistant\'s name', () => {
  const base = { ...DEMO_CLINIC };

  it('refuses a greeting where a name stands in for the disclosure', () => {
    const r = ClinicConfig.safeParse({ ...base, greeting: 'Thanks for calling Maple Street. I\'m Maya. How can I help?' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]).toMatchObject({ path: ['greeting'], message: 'the greeting must disclose that the caller is speaking with an AI assistant' });
  });

  it('accepts a disclosure in any of the clinic\'s languages', () => {
    expect(ClinicConfig.safeParse({ ...base, greeting: PACKS.es.greeting({ assistantName: 'Maya', clinicName: base.name }) }).success).toBe(true);
    // but not in one it does not speak
    expect(ClinicConfig.safeParse({ ...base, languages: ['en'], greeting: PACKS.es.greeting({ assistantName: null, clinicName: base.name }) }).success).toBe(false);
  });

  it('warns when the software\'s name would reach a caller, and still loads the configuration', () => {
    const greeting = { ...base, greeting: 'Thanks for calling. I am the Attendra AI assistant.' };
    expect(ClinicConfig.safeParse(greeting).success).toBe(true);
    expect(clinicWarnings(greeting).map((w) => w.path)).toEqual(['greeting']);
    expect(clinicWarnings({ ...base, assistantName: 'Attendra' }).map((w) => w.path)).toEqual(['assistantName']);
  });

  it('names are one word of 2 to 24 letters, in any script', () => {
    for (const ok of ['Maya', 'Nila', 'Zoë', 'José']) expect(ClinicConfig.safeParse({ ...base, assistantName: ok }).success, ok).toBe(true);
    for (const bad of ['M', 'Maya2', 'Maya Smith', 'A'.repeat(25), '']) expect(ClinicConfig.safeParse({ ...base, assistantName: bad }).success, bad).toBe(false);
  });

  it('the primary language must be one the assistant speaks', () => {
    const r = ClinicConfig.safeParse({ ...base, languages: ['en'], primaryLanguage: 'es' });
    expect(r.error?.issues[0]?.path).toEqual(['languages']);
    expect(ClinicConfig.safeParse({ ...base, languages: ['en', 'en'] }).success).toBe(false);
  });

  // 'bn' was a language pack once and no longer ships; this test stays because configurations saved with it exist
  it('a configuration saved with a language Attendra no longer ships still loads, without it', () => {
    const saved = {
      ...base, languages: ['bn', 'en'], primaryLanguage: 'bn',
      greeting: 'A greeting in a language no longer offered.',
      visitTypes: base.visitTypes.map((v) => ({ ...v, names: { ...v.names, bn: 'a name in it' } })),
    };
    const parsed = ClinicConfig.parse(saved);
    expect(parsed).toMatchObject({ languages: ['en'], primaryLanguage: 'en' });
    expect(parsed.greeting).toBe(PACKS.en.greeting({ assistantName: 'Maya', clinicName: base.name }));
    expect(parsed.visitTypes.every((v) => !Object.keys(v.names ?? {}).includes('bn'))).toBe(true);
    // a greeting that still discloses the AI in a language offered is kept as it was
    const spanish = PACKS.es.greeting({ assistantName: 'Maya', clinicName: base.name });
    expect(ClinicConfig.parse({ ...saved, languages: ['es', 'bn'], greeting: spanish, primaryLanguage: 'bn' })).toMatchObject({ languages: ['es'], primaryLanguage: 'es', greeting: spanish });
    expect(ClinicConfig.parse({ ...saved, languages: ['bn'] }).languages).toEqual(['en']);
  });

    it('older configurations keep working: English only, no name', () => {
    const old: Record<string, unknown> = { ...base, greeting: 'Thanks for calling. I am the clinic\'s AI assistant.' };
    for (const key of ['assistantName', 'languages', 'primaryLanguage']) delete old[key];
    const parsed = ClinicConfig.parse(old);
    expect(parsed).toMatchObject({ languages: ['en'], primaryLanguage: 'en' });
    expect(parsed.assistantName).toBeUndefined();
  });

  it('says a visit type in the caller\'s language when the clinic gave one', () => {
    const sick = DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_sick')!;
    expect(localName(sick, 'es')).toBe('consulta por enfermedad');
    expect(localName(sick, 'en')).toBe('sick visit');
    const annual = { ...DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_annual')!, names: undefined };
    expect(localName(annual, 'es')).toBe('annual physical');
  });
});
