import { describe, expect, it } from 'vitest';
import {
  ClinicConfig, clinicDay, DEMO_BUSY_LINE, DEMO_EMERGENCY_LINE, DEMO_LIMITS, demoEmergency, demoLimitHit, demoResetDue, emergencyCallLine, emergencyHandlingSummary,
  emergencyRoute, hospitalNow, industryPack, isDemoClinic, REFER_TO_RIVERBEND_HOSPITAL, RIVERBEND_CLINIC,
} from '../src';

// A demo clinic (2026-11-16): the flag, its limits, its clinic day and nightly reset time, and its emergency wording.
const demo = ClinicConfig.parse({ ...RIVERBEND_CLINIC, demoClinic: { enabled: true, baselineAt: null } });
const off = ClinicConfig.parse({ ...RIVERBEND_CLINIC, demoClinic: { enabled: false, baselineAt: '2026-11-16T10:00:00.000Z' } });
const at = new Date('2026-11-16T17:00:00Z'); // 10 am in Denver

describe('the demo clinic flag', () => {
  it('is off unless set, and a saved config without it still parses', () => {
    expect(isDemoClinic(RIVERBEND_CLINIC)).toBe(false);
    expect(isDemoClinic(off)).toBe(false);
    expect(isDemoClinic(demo)).toBe(true);
    expect(ClinicConfig.parse({ ...RIVERBEND_CLINIC, demoClinic: { enabled: true } }).demoClinic).toEqual({ enabled: true, baselineAt: null });
    expect(ClinicConfig.safeParse({ ...RIVERBEND_CLINIC, demoClinic: { enabled: true, baselineAt: 'yesterday' } }).success).toBe(false);
  });
});

describe('the demo limits', () => {
  it('lets a call through under every limit, and names the one it is over', () => {
    expect(demoLimitHit({ callerCalls: 0, clinicSeconds: 0 })).toBeNull();
    expect(demoLimitHit({ callerCalls: DEMO_LIMITS.callsPerCallerPerDay - 1, clinicSeconds: DEMO_LIMITS.clinicSecondsPerDay - 1 })).toBeNull();
    expect(demoLimitHit({ callerCalls: DEMO_LIMITS.callsPerCallerPerDay, clinicSeconds: 0 })).toBe('demo_caller_calls');
    expect(demoLimitHit({ callerCalls: 0, clinicSeconds: DEMO_LIMITS.clinicSecondsPerDay })).toBe('demo_clinic_minutes');
    // the whole line's minutes first: every caller hears it then
    expect(demoLimitHit({ callerCalls: 9, clinicSeconds: 99_999 })).toBe('demo_clinic_minutes');
  });

  it('are 15 minutes a call (wrap-up at 14), 5 calls a caller a day, 60 minutes a day', () => {
    expect(DEMO_LIMITS).toEqual({ callSeconds: 900, wrapUpAtSeconds: 840, callsPerCallerPerDay: 5, clinicSecondsPerDay: 3600 });
    expect(DEMO_BUSY_LINE.en).toBe('Thanks for calling the Attendra demo line. It\'s busy for you right now, please try again tomorrow.');
  });

  it('count in the clinic\'s own day, across a clock change', () => {
    const d = clinicDay('America/Denver', at);
    expect(d).toEqual({ date: '2026-11-16', start: new Date('2026-11-16T07:00:00Z'), end: new Date('2026-11-17T07:00:00Z') });
    // the night the clocks go back in Denver (1 November 2026): a 25-hour day
    const back = clinicDay('America/Denver', new Date('2026-11-01T18:00:00Z'));
    expect(back.end.getTime() - back.start.getTime()).toBe(25 * 3_600_000);
  });
});

describe('the nightly reset time', () => {
  it('is the latest 03:30 on the clinic\'s clock at or before now', () => {
    expect(demoResetDue('America/Denver', at)).toEqual(new Date('2026-11-16T10:30:00Z'));
    // 2 am in Denver: still yesterday's
    expect(demoResetDue('America/Denver', new Date('2026-11-16T09:00:00Z'))).toEqual(new Date('2026-11-15T10:30:00Z'));
    // exactly 03:30: due now
    expect(demoResetDue('America/New_York', new Date('2026-11-16T08:30:00Z'))).toEqual(new Date('2026-11-16T08:30:00Z'));
  });
});

describe('a demo clinic\'s emergencies', () => {
  const refer = ClinicConfig.parse({ ...demo, emergencies: REFER_TO_RIVERBEND_HOSPITAL });
  it('route nowhere real, whatever the setting holds; a normal clinic keeps its route', () => {
    expect(demoEmergency(demo)).toBe(true);
    expect(emergencyRoute(refer, at)).toMatchObject({ action: 'none', hospital: null, number: null, backup: null });
    expect(emergencyRoute(demo, at)).toMatchObject({ action: 'none', number: null });
    expect(hospitalNow(refer, at)).toBeNull();
    expect(emergencyRoute(RIVERBEND_CLINIC, at)).toMatchObject({ action: 'transfer', number: '+17205550179' });
    expect(emergencyRoute({ ...RIVERBEND_CLINIC, emergencies: REFER_TO_RIVERBEND_HOSPITAL }, at)).toMatchObject({ action: 'refer', hospital: { name: 'Front Range Pet Emergency' } });
    expect(emergencyRoute({ ...off, emergencies: REFER_TO_RIVERBEND_HOSPITAL }, at).hospital?.name).toBe('Front Range Pet Emergency');
  });

  it('the guardrail\'s script says the demo line and offers no text; a normal clinic\'s names its hospital', () => {
    const script = industryPack('vet').emergency!.script;
    const en = script('en', { hospital: null, emergencyNumber: '911', demo: true });
    expect(en).toContain(DEMO_EMERGENCY_LINE.en);
    expect(en).toContain('Do not offer to text anything');
    expect(script('es', { hospital: null, emergencyNumber: '911', demo: true })).toContain(DEMO_EMERGENCY_LINE.es);
    expect(script('en', { hospital: REFER_TO_RIVERBEND_HOSPITAL.hospital, emergencyNumber: '911', textOffer: true })).toContain('Front Range Pet Emergency');
  });

  it('"how do emergencies work" and the dashboard line say it is a demo line', () => {
    expect(emergencyHandlingSummary(refer, at, 'en')).toBe(`${DEMO_EMERGENCY_LINE.en} If a person is hurt or in danger, call 911.`);
    expect(emergencyHandlingSummary(refer, at, 'es')).toContain(DEMO_EMERGENCY_LINE.es);
    expect(emergencyCallLine(refer, at)).toContain('demo clinic');
    expect(emergencyCallLine({ ...RIVERBEND_CLINIC, emergencies: REFER_TO_RIVERBEND_HOSPITAL }, at)).toBe('Emergency calls here: sent to Front Range Pet Emergency, any time.');
  });
});
