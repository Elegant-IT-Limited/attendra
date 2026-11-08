import { describe, expect, it } from 'vitest';
import { ClinicConfig, EMERGENCY_CHOICES, EMERGENCY_LINES, EMERGENCY_MODES, emergencyCallLine, emergencyDraftOf, emergencyDraftIssues, emergencyFormFor, emergencyFormView, emergencyHospitalsOf, emergencyPreview, emergencyRoute, emergencySettingOf, emergencySettingsOf, EMERGENCY_WORDING, hospitalNow, RIVERBEND_CLINIC, settingsFieldProblems, zonedInstant } from '../src';

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

  it('emergencies is the only source (batch 1e): the old fields and the on-call switch are never read for the route', () => {
    // an un-migrated stored configuration still parses, and means no route until db:emergency-settings folds it in
    const old = ClinicConfig.parse({ ...base, emergencies: undefined, emergencyTransferEnabled: true, emergencyHospital: HOSPITAL, moreEmergencyHospitals: [AFTER], routing: [{ target: 'on_call', uri: `tel:${TEAM}`, when: 'always', priority: 1 }] });
    expect(emergencySettingsOf(old)).toBeNull();
    expect(emergencyRoute(old, OPEN)).toMatchObject({ mode: null, action: 'none', hospital: null, backup: null });
    expect(hospitalNow(old, OPEN)).toBeNull();
    expect(emergencyCallLine(old, OPEN)).toContain('no emergency setting yet');
  });

  it('several hospitals in order: the first one open at that moment is named, in refer, hours (closed) and as the backup', () => {
    const NIGHT = { ...HOSPITAL, name: 'Night Paws Emergency', hours: { open: '18:00', close: '08:00' } };
    const DAY = { ...AFTER, name: 'Day Referral Vets', hours: { open: '08:00', close: '18:00' } };
    const refer = withMode({ mode: 'refer', hospital: NIGHT, moreHospitals: [DAY] });
    expect(emergencyRoute(refer, OPEN).hospital?.name).toBe('Day Referral Vets');
    expect(emergencyRoute(refer, CLOSED).hospital?.name).toBe('Night Paws Emergency');
    const hours = withMode({ mode: 'hours', number: TEAM, afterHoursHospital: DAY, moreHospitals: [NIGHT] });
    expect(emergencyRoute(hours, CLOSED).hospital?.name).toBe('Night Paws Emergency');
    const handle = withMode({ mode: 'handle', number: TEAM, backupHospital: DAY, moreHospitals: [NIGHT] });
    expect(emergencyRoute(handle, CLOSED).backup?.name).toBe('Night Paws Emergency');
    // none open: the first anyway, never a made-up place
    expect(emergencyRoute(withMode({ mode: 'refer', hospital: NIGHT }), OPEN).hospital?.name).toBe('Night Paws Emergency');
    // at most 4 more
    expect(ClinicConfig.safeParse({ ...base, emergencies: { mode: 'refer', hospital: HOSPITAL, moreHospitals: [DAY, DAY, DAY, DAY, DAY] } }).success).toBe(false);
    expect(emergencyHospitalsOf(refer.emergencies).map((h) => h.name)).toEqual(['Night Paws Emergency', 'Day Referral Vets']);
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
    expect(en.question).toBe('I\'m sorry to hear that. Is this still an emergency right now? Do you need help getting emergency care?');
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

describe('the emergency form: one source for Settings and the setup page (batch 1e)', () => {
  it('offers the three modes, each with a label and a hint, in the schema\'s order', () => {
    expect(EMERGENCY_CHOICES.map((c) => c.value)).toEqual([...EMERGENCY_MODES]);
    for (const c of EMERGENCY_CHOICES) { expect(c.label.length).toBeGreaterThan(10); expect(c.hint.length).toBeGreaterThan(20); }
  });

  it('a draft from the saved setting saves back the same setting', () => {
    for (const e of [
      { mode: 'refer', hospital: HOSPITAL, moreHospitals: [{ ...AFTER, hours: { open: '18:00', close: '08:00' } }] },
      { mode: 'handle', number: TEAM, backupHospital: HOSPITAL },
      { mode: 'handle', number: TEAM },
      { mode: 'hours', number: TEAM, afterHoursHospital: AFTER, hours: { '1': [{ open: '07:00', close: '23:00' }] } },
    ]) {
      const c = withMode(e);
      const r = emergencySettingOf(emergencyDraftOf(c), c);
      expect(r.success && r.data).toEqual(c.emergencies);
    }
  });

  it('says what is still needed, by the field\'s name on the form; reads typed phones in the clinic\'s country', () => {
    const d = emergencyDraftOf(withMode(undefined));
    expect(d.mode).toBe('refer');
    expect(emergencyDraftIssues(d, base)).toEqual(['the hospital\'s name', 'the hospital\'s phone', 'the hospital\'s address']);
    expect(emergencyDraftIssues({ ...d, mode: 'hours', afterHours: { name: 'Night Owl Animal ER', phone: '(720) 555-0189', address: '88 Cedar Road, Denver', hours: null } }, base)).toEqual(['the emergency line']);
    const typed = emergencySettingOf({ ...d, mode: 'handle', number: '(720) 555-0177' }, base);
    expect(typed.success && typed.data).toEqual({ mode: 'handle', number: TEAM });
  });

  it('the view: issues, the setting, the Right now line and the preview, all from the same route', () => {
    const c = withMode({ mode: 'refer', hospital: HOSPITAL });
    const draft = { ...emergencyDraftOf(c), mode: 'hours' as const, number: TEAM, afterHours: { ...AFTER, hours: null } };
    const v = emergencyFormView(c, draft, OPEN);
    expect(v.issues).toEqual([]);
    expect(v.setting).toEqual({ mode: 'hours', number: TEAM, afterHoursHospital: AFTER });
    const shown = withMode(v.setting);
    expect(v.callLine).toBe(emergencyCallLine(shown, OPEN));
    expect(v.preview.es.closed).toEqual(emergencyPreview(shown, 'es', false, OPEN));
    // an incomplete draft previews the saved setting, as Settings does
    const half = emergencyFormView(c, { ...draft, number: '' }, OPEN);
    expect(half.setting).toBeNull();
    expect(half.issues).toEqual(['the emergency line']);
    expect(half.callLine).toBe(emergencyCallLine(c, OPEN));
  });

  it('serves the constants as they are, and the intro with the clinic\'s emergency number', () => {
    const f = emergencyFormFor(base);
    expect(f.choices).toBe(EMERGENCY_CHOICES);
    expect(f.wording).toBe(EMERGENCY_WORDING);
    expect(f.intro).toContain('call 911');
    expect(JSON.parse(JSON.stringify(f.wording))).toEqual(EMERGENCY_WORDING); // plain strings only: served as JSON unchanged
  });
});
