import { describe, expect, it } from 'vitest';
import { ClinicConfig, EMERGENCY_LINES, emergencyCallLine, emergencyPreview, emergencyRoute, emergencySettingsOf, RIVERBEND_CLINIC, settingsFieldProblems, zonedInstant } from '../src';

// Batch 1b: one source of truth for where an animal's emergency goes. Made-up hospitals and 555-01xx numbers only.
const HOSPITAL = { name: 'Front Range Pet Emergency', phone: '+17205550188', address: '1200 Larkspur Avenue, Denver' };
const AFTER = { name: 'Night Owl Animal ER', phone: '+17205550189', address: '88 Cedar Road, Denver' };
const TEAM = '+17205550177';
const base = ClinicConfig.parse({ ...RIVERBEND_CLINIC, holidays: ['2026-11-26'], specialDays: [{ date: '2026-11-27', windows: [{ open: '09:00', close: '12:00' }] }] });
const at = (date: string, time: string) => zonedInstant(date, time, base.timezone);
// a Monday, open (the clinic's hours) and closed (late evening); a holiday; a special day
const OPEN = at('2026-11-09', '10:00');
const CLOSED = at('2026-11-09', '22:00');
const HOLIDAY = at('2026-11-26', '10:00');
const SPECIAL = at('2026-11-27', '10:00');
const withMode = (emergencies: unknown) => ClinicConfig.parse({ ...base, emergencies });

describe('emergencyRoute: the mode, open or closed', () => {
  it('refer: the hospital, open or closed', () => {
    const c = withMode({ mode: 'refer', hospital: HOSPITAL });
    for (const now of [OPEN, CLOSED]) expect(emergencyRoute(c, now)).toMatchObject({ mode: 'refer', action: 'refer', hospital: HOSPITAL, number: null });
  });

  it('handle: a live transfer to the team at any hour, with the backup hospital for after a failed one', () => {
    const c = withMode({ mode: 'handle', number: TEAM, backupHospital: HOSPITAL });
    for (const now of [OPEN, CLOSED, HOLIDAY]) expect(emergencyRoute(c, now)).toMatchObject({ mode: 'handle', action: 'transfer', number: TEAM, backup: HOSPITAL });
  });

  it('hours: the team in its emergency hours (the opening hours unless set), the after-hours hospital after; holidays and special days closed', () => {
    const c = withMode({ mode: 'hours', number: TEAM, afterHoursHospital: AFTER });
    expect(emergencyRoute(c, OPEN)).toMatchObject({ mode: 'hours', open: true, action: 'transfer', number: TEAM, backup: AFTER, closesAt: '18:00' });
    expect(emergencyRoute(c, CLOSED)).toMatchObject({ mode: 'hours', open: false, action: 'refer', hospital: AFTER });
    expect(emergencyRoute(c, HOLIDAY)).toMatchObject({ open: false, action: 'refer', hospital: AFTER });
    expect(emergencyRoute(c, SPECIAL)).toMatchObject({ open: false, action: 'refer', hospital: AFTER });
    // its own emergency hours, wider than the opening hours: open at 22:00 on a Monday
    const late = withMode({ mode: 'hours', number: TEAM, afterHoursHospital: AFTER, hours: { '1': [{ open: '07:00', close: '23:00' }] } });
    expect(emergencyRoute(late, CLOSED)).toMatchObject({ open: true, action: 'transfer', closesAt: '23:00' });
  });

  it('a clinic saved before the setting: an on-call line it transferred to is handle, a hospital alone is refer, nothing is none', () => {
    const onCall = ClinicConfig.parse({ ...base, emergencyTransferEnabled: true, routing: [{ target: 'on_call', uri: `tel:${TEAM}`, when: 'always', priority: 1 }] });
    expect(emergencySettingsOf(onCall)).toEqual({ mode: 'handle', number: TEAM, backupHospital: base.emergencyHospital });
    const hospitalOnly = ClinicConfig.parse({ ...base, emergencyTransferEnabled: false });
    expect(emergencySettingsOf(hospitalOnly)).toEqual({ mode: 'refer', hospital: base.emergencyHospital });
    const none = ClinicConfig.parse({ ...base, emergencyTransferEnabled: false, emergencyHospital: undefined });
    expect(emergencySettingsOf(none)).toBeNull();
    expect(emergencyRoute(none, OPEN)).toMatchObject({ mode: null, action: 'none', hospital: null });
  });

  it('cannot be saved with a required field missing', () => {
    expect(ClinicConfig.safeParse({ ...base, emergencies: { mode: 'refer' } }).success).toBe(false);
    expect(ClinicConfig.safeParse({ ...base, emergencies: { mode: 'handle' } }).success).toBe(false);
    expect(ClinicConfig.safeParse({ ...base, emergencies: { mode: 'hours', number: TEAM } }).success).toBe(false);
    expect(ClinicConfig.safeParse({ ...base, emergencies: { mode: 'hours', afterHoursHospital: AFTER } }).success).toBe(false);
    expect(ClinicConfig.safeParse({ ...base, emergencies: { mode: 'handle', number: TEAM } }).success).toBe(true);
    expect(settingsFieldProblems(withMode({ mode: 'refer', hospital: HOSPITAL }))).toEqual([]);
  });
});

describe('what callers hear, and the test-call line', () => {
  it('says the lines in English and Spanish, by the route', () => {
    const hours = withMode({ mode: 'hours', number: TEAM, afterHoursHospital: AFTER });
    const en = emergencyPreview(hours, 'en', true, OPEN);
    expect(en.question).toBe('I\'m sorry, that sounds worrying. Is this still an emergency right now? Do you need help getting emergency care?');
    expect(en.yes).toBe(EMERGENCY_LINES.transfer('en'));
    expect(en.transferFailed).toContain('our team will call you right away');
    expect(en.clearNo).toMatch(/^If it comes back, call us at .*or come straight in\.$/);
    const esClosed = emergencyPreview(hours, 'es', false, CLOSED);
    expect(esClosed.yes).toContain('Night Owl Animal ER');
    expect(esClosed.clearNo).toContain('Night Owl Animal ER');
    expect(esClosed.question).toMatch(/^Lo siento/);
    // refer with no hospital open: the generic line, never a made-up place
    expect(EMERGENCY_LINES.refer('en', 'Luna', null)).toBe('Please take Luna to the nearest 24-hour emergency vet right away.');
  });

  it('the test-call page says where an emergency goes now', () => {
    const hours = withMode({ mode: 'hours', number: TEAM, afterHoursHospital: AFTER });
    expect(emergencyCallLine(hours, OPEN)).toBe('Emergency calls here: transfer to the team now (open until 6 PM), Night Owl Animal ER after.');
    expect(emergencyCallLine(hours, CLOSED)).toContain('sent to Night Owl Animal ER now');
    expect(emergencyCallLine(withMode({ mode: 'handle', number: TEAM }), CLOSED)).toBe('Emergency calls here: transfer to the team now, any time.');
    expect(emergencyCallLine(withMode({ mode: 'refer', hospital: HOSPITAL }), OPEN)).toBe('Emergency calls here: sent to Front Range Pet Emergency, any time.');
  });
});
