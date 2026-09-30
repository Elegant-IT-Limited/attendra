import { describe, expect, it } from 'vitest';
import {
  ClinicConfig, crisisLineFor, DEMO_CLINIC, detectEmergencies, detectEmergency, detectLanguage, DHANMONDI_CLINIC, emergencyNumberFor,
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

  it('only Bangla is experimental', () => {
    expect(LANGUAGES.filter((l) => PACKS[l].experimental)).toEqual(['bn']);
  });
});

describe('speaking dates and numbers', () => {
  const tz = 'Asia/Dhaka';
  it('Bangla says the day, the date and the part of the day, in Bengali digits', () => {
    expect(speakSlot(zonedInstant('2025-10-06', '15:00', tz), tz, 'bn')).toBe('সোমবার, ৬ অক্টোবর, বিকেল ৩টা');
    expect(speakSlot(zonedInstant('2026-09-29', '09:30', tz), tz, 'bn')).toBe('মঙ্গলবার, ২৯ সেপ্টেম্বর, সকাল ৯টা ৩০ মিনিট');
    expect(speakSlot(zonedInstant('2026-09-29', '12:15', tz), tz, 'bn')).toBe('মঙ্গলবার, ২৯ সেপ্টেম্বর, দুপুর ১২টা ১৫ মিনিট');
    expect(speakSlot(zonedInstant('2026-09-29', '19:00', tz), tz, 'bn')).toBe('মঙ্গলবার, ২৯ সেপ্টেম্বর, সন্ধ্যা ৭টা');
  });

  it('Spanish uses the article with the hour', () => {
    const denver = DEMO_CLINIC.timezone;
    expect(speakSlot(zonedInstant('2026-09-29', '13:00', denver), denver, 'es')).toMatch(/^martes, 29 de septiembre a la 1:00/);
    expect(speakSlot(zonedInstant('2026-09-29', '15:00', denver), denver, 'es')).toMatch(/^martes, 29 de septiembre a las 3:00/);
  });

  it('English is unchanged', () => {
    const denver = DEMO_CLINIC.timezone;
    expect(speakSlot(zonedInstant('2026-09-29', '08:00', denver), denver)).toBe('Tuesday, September 29 at 8:00 AM');
  });

  it('phone numbers are read digit by digit, and a Bangladeshi number starts with zero', () => {
    expect(PACKS.bn.speakPhone('+8801712345678')).toBe('শূন্য এক সাত এক দুই তিন চার পাঁচ ছয় সাত আট');
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
    ['বাবার বুকে খুব ব্যথা', 'cardiac', 'bn'],
    ['buke betha korche', 'cardiac', 'bn'],
    ['শ্বাস নিতে পারছি না', 'breathing', 'bn'],
    ['shash nite parchi na', 'breathing', 'bn'],
    ['মা অজ্ঞান হয়ে গেছে', 'unresponsive', 'bn'],
    ['ma oggan hoye geche', 'unresponsive', 'bn'],
    ['অনেক রক্ত পড়ছে', 'bleeding', 'bn'],
    ['onek rokto porche', 'bleeding', 'bn'],
    ['আমি আত্মহত্যা করতে চাই', 'self_harm', 'bn'],
    ['ami ar bachte chai na', 'self_harm', 'bn'],
    ['এটা জরুরি', 'general', 'bn'],
  ];
  for (const [text, kind, language] of cases) {
    it(`"${text}" is ${kind}, heard as ${language}`, () => {
      expect(detectEmergency(text)).toMatchObject({ kind, language });
    });
  }

  it('checks every language whatever the clinic offers, so a Spanish emergency at an English-only clinic is still caught', () => {
    expect(detectEmergencies('Hello, me duele el pecho').map((m) => m.kind)).toEqual(['cardiac']);
  });

  it('matches Bengali written either way a transcriber may compose it', () => {
    const composed = 'রক্ত থামছে না';
    expect(detectEmergency(composed.normalize('NFC'))?.kind).toBe('bleeding');
    expect(detectEmergency(composed.normalize('NFD'))?.kind).toBe('bleeding');
  });

  it('honours "not an emergency" in Spanish and Bangla, for the generic word only', () => {
    expect(detectEmergency('no es una emergencia, solo quiero una cita')).toBeNull();
    expect(detectEmergency('joruri na, emni jante chai')).toBeNull();
    expect(detectEmergency('no es una emergencia pero me duele el pecho')?.kind).toBe('cardiac');
  });

  it('does not fire on ordinary words that look like a phrase', () => {
    for (const t of ['quiero un examen de pecho la próxima semana', 'report kobe pabo', 'I need a blood test', 'the sample was given']) {
      expect(detectEmergency(t), t).toBeNull();
    }
  });

  it('uses the clinic\'s emergency number, or the country\'s', () => {
    expect(emergencyNumberFor(DEMO_CLINIC)).toBe('911');
    expect(emergencyNumberFor(DHANMONDI_CLINIC)).toBe('999');
    expect(emergencyNumberFor({ phoneNumbers: ['+8801000000100'] })).toBe('999');
    expect(emergencyNumberFor({ phoneNumbers: ['+442071234567'] })).toBe('999');
    expect(emergencyNumberFor({ phoneNumbers: ['+13035550100'], emergencyNumber: '112' })).toBe('112');
    expect(crisisLineFor(DEMO_CLINIC)).toBe('988');
    expect(crisisLineFor(DHANMONDI_CLINIC)).toBeNull();
  });

  it('the Bangla script gives 999 in Bengali digits and never 911 or 988', () => {
    const script = PACKS.bn.emergencyScript('999');
    expect(script).toContain('৯৯৯');
    expect(script).not.toMatch(/911|988/);
    expect(PACKS.bn.selfHarmScript('999', null)).not.toMatch(/988/);
  });
});

describe('a clear yes in every language', () => {
  const ALL = LANGUAGES;
  it('accepts a plain yes in Spanish and Bangla, in both scripts', () => {
    for (const t of ['Sí', 'sí, claro', 'correcto', 'está bien', 'de acuerdo', 'জি', 'জি, করে দিন', 'হ্যাঁ, ঠিক আছে', 'ji', 'thik ache', 'accha korun', 'Ji, confirm.']) {
      expect(isClearYes(t, ALL), t).toBe(true);
    }
  });

  it('refuses a hedge in any language, even next to a yes', () => {
    for (const t of ['no', 'sí, pero espere', 'mejor otro día', 'tal vez', '¿el jueves?', 'na', 'ji... na, pore janabo', 'জি, একটু দাঁড়ান', 'মনে হয়', 'onno din', 'yes, pore', 'sí, maybe']) {
      expect(isClearYes(t, ALL), t).toBe(false);
    }
  });

  it('matches "দাঁড়ান" however it is composed', () => {
    expect(isClearYes('জি, দাঁড়ান'.normalize('NFC'), ALL)).toBe(false);
    expect(isClearYes('জি, দাঁড়ান'.normalize('NFD'), ALL)).toBe(false);
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
      ['ji, kintu bikel e', ['bn']],
      ['জি, কিন্তু বিকেলে', ['bn']],
      ['জি, তবে আর একটা কথা', ['bn']],
      ['accha, tahole 3 tar dike', ['bn']],
      ['I have to check, ha', ['en']],
      ['I have to check, ha', ALL],
      ['yes, but not Monday', ['en']],
      ['yes, although Friday is better', ['en']],
      ['sí, aunque mejor el jueves', ['es']],
      ['ji, ar ekta kotha', ['bn']],
    ];
    for (const [t, langs] of cases) expect(isClearYes(t, langs), `${t} (${langs.join(',')})`).toBe(false);
  });

  it('takes a yes word only in a language the clinic offers', () => {
    expect(isClearYes('ji', ['en'])).toBe(false);
    expect(isClearYes('claro', ['en', 'bn'])).toBe(false);
    expect(isClearYes('yes', ['es'])).toBe(false);
  });

  it('still takes a plain yes in each language, and a short word said alone', () => {
    expect(isClearYes('Yes, that\'s right.', ['en'])).toBe(true);
    expect(isClearYes('Confirm.', ['en'])).toBe(true);
    expect(isClearYes('Sí, correcto.', ['es'])).toBe(true);
    expect(isClearYes('Sí.', ['es'])).toBe(true);
    expect(isClearYes('Por favor.', ['es'])).toBe(true);
    expect(isClearYes('জি, করে দিন', ['bn'])).toBe(true);
    expect(isClearYes('Ha.', ['bn'])).toBe(true);
    expect(isClearYes('accha', ['bn'])).toBe(true);
    expect(isClearYes('Ji, confirm.', ['bn'])).toBe(true);
  });
});

describe('choosing the reply language', () => {
  it('stays in the primary language until the caller speaks another the clinic offers', () => {
    expect(detectLanguage('', ['en', 'es'], 'en')).toBe('en');
    expect(detectLanguage('Hola, quiero una cita para mañana', ['en', 'es'], 'en')).toBe('es');
    expect(detectLanguage('I want an appointment for tomorrow', ['en', 'es'], 'en')).toBe('en');
  });

  it('reads Bengali script and romanised Bangla, mixed with English, as Bangla', () => {
    expect(detectLanguage('আমার রিপোর্ট কবে পাবো', ['bn', 'en'], 'bn')).toBe('bn');
    expect(detectLanguage('test er report kobe pabo', ['bn', 'en'], 'en')).toBe('bn');
    expect(detectLanguage('Hello, ami Tahmina, amar home sample collection lagbe', ['bn', 'en'], 'bn')).toBe('bn');
    expect(detectLanguage('I would like to book an ECG for my father please', ['bn', 'en'], 'bn')).toBe('en');
  });

  it('never picks a language the clinic does not offer', () => {
    expect(detectLanguage('Hola, quiero una cita', ['en'], 'en')).toBe('en');
    expect(detectLanguage('আমার রিপোর্ট কবে পাবো', ['en', 'es'], 'en')).toBe('en');
  });
});

describe('dates of birth in other languages', () => {
  it('reads Spanish months', () => {
    expect(parseDob('4 de marzo de 1985', TODAY)).toBe('1985-03-04');
    expect(parseDob('el 9 de septiembre de 1962', TODAY)).toBe('1962-09-09');
    expect(parseDob('9 de septiembre de 1962', TODAY)).toBe('1962-09-09');
  });

  it('reads Bengali digits and month names', () => {
    expect(parseDob('১২ মে ১৯৭৯', TODAY)).toBe('1979-05-12');
    expect(parseDob('৩ নভেম্বর ১৯৬৮', TODAY)).toBe('1968-11-03');
    expect(parseDob('১২ই মে ১৯৭৯', TODAY)).toBe('1979-05-12');
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
    expect(ClinicConfig.safeParse({ ...DHANMONDI_CLINIC }).success).toBe(true);
    // but not in one it does not speak
    expect(ClinicConfig.safeParse({ ...base, languages: ['en'], greeting: PACKS.bn.greeting({ assistantName: null, clinicName: base.name }) }).success).toBe(false);
  });

  it('never lets the software\'s name reach a caller', () => {
    expect(ClinicConfig.safeParse({ ...base, greeting: 'Thanks for calling. I am the Attendra AI assistant.' }).error?.issues[0]?.path).toEqual(['greeting']);
    expect(ClinicConfig.safeParse({ ...base, assistantName: 'Attendra' }).error?.issues[0]?.path).toEqual(['assistantName']);
  });

  it('names are one word of 2 to 24 letters, in any script', () => {
    for (const ok of ['Maya', 'Nila', 'নীলা', 'José']) expect(ClinicConfig.safeParse({ ...base, assistantName: ok }).success, ok).toBe(true);
    for (const bad of ['M', 'Maya2', 'Maya Smith', 'A'.repeat(25), '']) expect(ClinicConfig.safeParse({ ...base, assistantName: bad }).success, bad).toBe(false);
  });

  it('the primary language must be one the assistant speaks', () => {
    const r = ClinicConfig.safeParse({ ...base, languages: ['en'], primaryLanguage: 'es' });
    expect(r.error?.issues[0]?.path).toEqual(['languages']);
    expect(ClinicConfig.safeParse({ ...base, languages: ['en', 'en'] }).success).toBe(false);
  });

  it('older configurations keep working: English only, no name', () => {
    const old: Record<string, unknown> = { ...base, greeting: 'Thanks for calling. I am the clinic\'s AI assistant.' };
    for (const key of ['assistantName', 'languages', 'primaryLanguage']) delete old[key];
    const parsed = ClinicConfig.parse(old);
    expect(parsed).toMatchObject({ languages: ['en'], primaryLanguage: 'en' });
    expect(parsed.assistantName).toBeUndefined();
  });

  it('says a visit type in the caller\'s language when the clinic gave one', () => {
    const blood = DHANMONDI_CLINIC.visitTypes.find((v) => v.id === 'vt_blood')!;
    expect(localName(blood, 'bn')).toBe('রক্ত পরীক্ষা');
    expect(localName(blood, 'en')).toBe('blood test');
    expect(localName(blood, 'es')).toBe('blood test');
  });
});
