import { describe, expect, it } from 'vitest';
import { RIVERBEND_CLINIC, settingsFieldProblems } from '../src';

describe('the Settings field standard, on save', () => {
  it('passes a clinic as it is set up', () => {
    expect(settingsFieldProblems(RIVERBEND_CLINIC)).toEqual([]);
  });
  it('refuses names that are only spaces or symbols, and lengths past the fields', () => {
    const bad = { ...RIVERBEND_CLINIC, name: '  ***  ', visitTypes: [{ ...RIVERBEND_CLINIC.visitTypes[0]!, name: '' }], faqs: [{ question: 'x'.repeat(201), answer: 'y' }], recording: { enabled: true, notice: 'n'.repeat(301) } };
    expect(settingsFieldProblems(bad).map((i) => i.path)).toEqual(['name', 'visitTypes.0.name', 'faqs.0.question', 'recording.notice']);
    // digits are fine in a clinic's or a pet's name
    expect(settingsFieldProblems({ ...RIVERBEND_CLINIC, name: 'Clinic 24' })).toEqual([]);
  });
});
