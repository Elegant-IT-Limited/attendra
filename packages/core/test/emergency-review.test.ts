import { describe, expect, it } from 'vitest';
import { DEMO_CLINIC, emergencyListVersion, emergencyReviewSheet, RIVERBEND_CLINIC } from '../src';

describe('the emergency review sheet', () => {
  it('shows a vet clinic both lists and the exact words, with its own hospital and number', () => {
    const sheet = emergencyReviewSheet(RIVERBEND_CLINIC);
    expect(sheet.animal.map((i) => i.kind)).toEqual(['pet_toxin', 'pet_breathing', 'pet_trauma', 'pet_collapse', 'pet_bloat', 'pet_urinary', 'pet_heat', 'pet_birth']);
    expect(sheet.person.map((i) => i.kind)).toContain('self_harm');
    expect(sheet.says.animal!.en).toBe('This sounds like an emergency. Please take your pet to Front Range Pet Emergency at 1200 Larkspur Avenue, Denver right away. Their number is (720) 555-0188. If a person is hurt or in danger, call 911.');
    expect(sheet.says.animal!.es).toContain('Front Range Pet Emergency');
    expect(sheet.says.person.en).toBe('If this is a medical emergency, please hang up and call 911 right away.');
    expect(sheet.hospitalSet).toBe(true);
  });

  it('shows a medical clinic only the person list, and versions each pack\'s lists', () => {
    const sheet = emergencyReviewSheet(DEMO_CLINIC);
    expect(sheet.animal).toEqual([]);
    expect(sheet.says.animal).toBeNull();
    expect(emergencyListVersion('vet')).toMatch(/^[0-9a-f]{8}$/);
    expect(emergencyListVersion('vet')).not.toBe(emergencyListVersion('clinic'));
    expect(emergencyListVersion('vet')).toBe(emergencyListVersion('vet'));
  });
});
