// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { EMERGENCY_CHOICES, emergencyHandlingSummary, PACKS, RIVERBEND_CLINIC } from '../src';

// Note 49 B3: a caller read "We handle emergencies, any time (on call)" in the clinic's materials and asked what it means;
// the assistant could not say. The words come from the clinic's own setting, the one Settings > Emergencies saves.
const NOW = new Date('2026-09-28T16:00:00Z'); // Monday 10:00 in Denver: open
const NIGHT = new Date('2026-09-29T05:00:00Z'); // Monday 23:00 in Denver: closed
const HOSPITAL = { name: 'Front Range Pet Emergency', phone: '+17205550188', address: '1200 Larkspur Avenue, Denver' };
const AFTER = { name: 'Night Owl Animal ER', phone: '+17205550189', address: '88 Cedar Road, Denver' };
const LINE = '+17205550179';
const SETTINGS = {
  refer: { mode: 'refer' as const, hospital: HOSPITAL },
  handle: { mode: 'handle' as const, number: LINE, backupHospital: HOSPITAL },
  hours: { mode: 'hours' as const, number: LINE, afterHoursHospital: AFTER },
};

describe.each(['en', 'es'] as const)('the clinic\'s emergency handling, said in %s', (lang) => {
  const phone = (n: string) => PACKS[lang].speakPhone(n);
  it('refer: the hospital, its address and number, at any hour', () => {
    const said = emergencyHandlingSummary({ ...RIVERBEND_CLINIC, emergencies: SETTINGS.refer }, NOW, lang);
    for (const part of [HOSPITAL.name, HOSPITAL.address, phone(HOSPITAL.phone), lang === 'es' ? 'a cualquier hora' : 'at any hour', '911']) expect(said).toContain(part);
  });
  it('handle: the team on call at any hour, the emergency line, and the backup hospital', () => {
    const said = emergencyHandlingSummary({ ...RIVERBEND_CLINIC, emergencies: SETTINGS.handle }, NOW, lang);
    for (const part of [phone(LINE), lang === 'es' ? 'de guardia' : 'on call', lang === 'es' ? 'a cualquier hora' : 'at any hour', HOSPITAL.name, '911']) expect(said).toContain(part);
    expect(emergencyHandlingSummary({ ...RIVERBEND_CLINIC, emergencies: { mode: 'handle', number: LINE } }, NOW, lang)).not.toContain(HOSPITAL.name);
  });
  it('hours: the team in its hours (the opening hours unless set), the after-hours hospital outside them, at any time of day', () => {
    for (const at of [NOW, NIGHT]) {
      const said = emergencyHandlingSummary({ ...RIVERBEND_CLINIC, emergencies: SETTINGS.hours }, at, lang);
      for (const part of [phone(LINE), AFTER.name, AFTER.address, phone(AFTER.phone), '8 AM–6 PM', '911']) expect(said).toContain(part);
    }
    const own = emergencyHandlingSummary({ ...RIVERBEND_CLINIC, emergencies: { ...SETTINGS.hours, hours: { ...RIVERBEND_CLINIC.hours, '1': [{ open: '07:00', close: '21:00' }] } } }, NOW, lang);
    expect(own).toContain('7 AM–9 PM');
  });
  it('no setting yet: the nearest 24-hour emergency vet', () => {
    expect(emergencyHandlingSummary({ ...RIVERBEND_CLINIC, emergencies: undefined }, NOW, lang)).toContain(lang === 'es' ? 'emergencias de 24 horas más cercano' : 'nearest 24-hour emergency vet');
  });
});

it('every mode Settings offers has a summary of its own', () => {
  const said = EMERGENCY_CHOICES.map((c) => emergencyHandlingSummary({ ...RIVERBEND_CLINIC, emergencies: SETTINGS[c.value] }, NOW, 'en'));
  expect(new Set(said).size).toBe(EMERGENCY_CHOICES.length);
});
