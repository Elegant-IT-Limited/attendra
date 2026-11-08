import { describe, expect, it } from 'vitest';
import { ClinicConfig, RIVERBEND_CLINIC, realDate, settingsFieldProblems } from '../src';

describe('the Settings field standard, on save', () => {
  it('passes a clinic as it is set up', () => {
    expect(settingsFieldProblems(RIVERBEND_CLINIC)).toEqual([]);
  });
  it('refuses names that are only spaces or symbols, and lengths past the fields', () => {
    const bad = { ...RIVERBEND_CLINIC, name: '  ***  ', visitTypes: [{ ...RIVERBEND_CLINIC.visitTypes[0]!, name: '' }], faqs: [{ id: 'faq_long', question: 'x'.repeat(201), answer: 'y' }], recording: { enabled: true, notice: 'n'.repeat(301) } };
    expect(settingsFieldProblems(bad).map((i) => i.path)).toEqual(['name', 'visitTypes.0.name', 'faqs.0.question', 'recording.notice']);
    // digits are fine in a clinic's or a pet's name
    expect(settingsFieldProblems({ ...RIVERBEND_CLINIC, name: 'Clinic 24' })).toEqual([]);
  });
  it('refuses a holiday or a special day that is not on the calendar', () => {
    expect(['2026-02-28', '2028-02-29', '2026-12-31'].every(realDate)).toBe(true);
    expect(['2026-02-31', '2027-02-29', '2026-13-01', '2026-1-01'].some(realDate)).toBe(false);
    const bad = { ...RIVERBEND_CLINIC, holidays: ['2026-12-25', '2026-02-31'], specialDays: [{ date: '2026-04-31', windows: [] }] };
    expect(settingsFieldProblems(bad)).toEqual([
      { path: 'holidays.1', message: 'Holiday: 2026-02-31 is not a day on the calendar' },
      { path: 'specialDays.0.date', message: 'Special day: 2026-04-31 is not a day on the calendar' },
    ]);
  });
  it('refuses a hospital whose name is only symbols', () => {
    const e = RIVERBEND_CLINIC.emergencies as { mode: 'handle'; number: string; backupHospital: { name: string; phone: string; address: string } };
    const bad = { ...RIVERBEND_CLINIC, emergencies: { ...e, backupHospital: { ...e.backupHospital, name: '!!' } } } as typeof RIVERBEND_CLINIC;
    expect(settingsFieldProblems(bad)).toEqual([{ path: 'emergencies.backupHospital.name', message: 'Hospital name: type a name, not only spaces or symbols' }]);
  });
  it('keeps what is typed without spaces at either end: names, questions, answers, the greeting, the recording notice', () => {
    const c = ClinicConfig.parse({ ...RIVERBEND_CLINIC, greeting: '  ' + RIVERBEND_CLINIC.greeting + '  ', faqs: [{ id: 'faq_park', question: ' Where do I park? ', answer: ' Behind the clinic. ' }],
      visitTypes: [{ ...RIVERBEND_CLINIC.visitTypes[0]!, name: ' check-up ' }, ...RIVERBEND_CLINIC.visitTypes.slice(1)], recording: { enabled: true, notice: ' This call is recorded. ' } });
    expect([c.greeting, c.faqs[0]!.question, c.faqs[0]!.answer, c.visitTypes[0]!.name, c.recording.notice]).toEqual([RIVERBEND_CLINIC.greeting.trim(), 'Where do I park?', 'Behind the clinic.', 'check-up', 'This call is recorded.']);
  });
});
