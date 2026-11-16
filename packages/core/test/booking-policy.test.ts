import { describe, expect, it } from 'vitest';
import { BOOKING_LEAD_MINUTES, bookingPolicy, DEMO_CLINIC, DESK_LEAD_MINUTES, earliestStart, findSlots, lastBookableDate, policyProblem, zonedInstant } from '../src';

// Foundation A, item 6: one booking rule for a visit type and who books it. Monday 28 September 2026, 8 pm in Denver.
const tz = DEMO_CLINIC.timezone;
const now = zonedInstant('2026-09-28', '20:00', tz);
const at = (date: string, time: string) => zonedInstant(date, time, tz);

describe('bookingPolicy', () => {
  it('the assistant: two hours, or the notice when longer; the furthest date; times a visit apart', () => {
    expect(bookingPolicy({}, 'assistant')).toEqual({ actor: 'assistant', leadMinutes: BOOKING_LEAD_MINUTES, noticeHours: 0, maxDaysAhead: null, allStarts: false });
    expect(bookingPolicy({ noticeHours: 1 }, 'assistant').leadMinutes).toBe(120);
    expect(bookingPolicy({ noticeHours: 48, maxDaysAhead: 10 }, 'assistant')).toMatchObject({ leadMinutes: 48 * 60, noticeHours: 48, maxDaysAhead: 10 });
  });

  it('the desk: its own five minutes, every start, and neither the notice nor the furthest date', () => {
    expect(bookingPolicy({ noticeHours: 48, maxDaysAhead: 10 }, 'desk')).toEqual({ actor: 'desk', leadMinutes: DESK_LEAD_MINUTES, noticeHours: 0, maxDaysAhead: null, allStarts: true });
  });

  it('the first start, the last date and why a start is refused', () => {
    const assistant = bookingPolicy({ noticeHours: 48, maxDaysAhead: 10 }, 'assistant');
    expect(earliestStart(assistant, now)).toEqual(at('2026-09-30', '20:00'));
    expect(lastBookableDate(assistant, now, tz)).toBe('2026-10-08');
    expect(lastBookableDate(bookingPolicy({}, 'assistant'), now, tz)).toBeNull();
    expect(policyProblem(assistant, at('2026-09-28', '19:00'), now, tz)).toBe('past');
    expect(policyProblem(assistant, at('2026-09-29', '10:00'), now, tz)).toBe('notice');
    expect(policyProblem(assistant, at('2026-10-01', '10:00'), now, tz)).toBeNull();
    expect(policyProblem(assistant, at('2026-10-09', '10:00'), now, tz)).toBe('too_far_ahead');
    // no notice of its own: the assistant's two hours
    expect(policyProblem(bookingPolicy({}, 'assistant'), at('2026-09-28', '21:00'), now, tz)).toBe('too_soon');
    const desk = bookingPolicy({ noticeHours: 48, maxDaysAhead: 10 }, 'desk');
    expect(policyProblem(desk, at('2026-09-28', '20:04'), now, tz)).toBe('too_soon');
    expect(policyProblem(desk, at('2026-09-29', '10:00'), now, tz)).toBeNull();
    expect(policyProblem(desk, at('2026-10-20', '10:00'), now, tz)).toBeNull();
  });

  it('findSlots keeps to it: nothing inside the notice or past the furthest date for the assistant; the desk sees every start', () => {
    const sick = { ...DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_sick')!, noticeHours: 48, maxDaysAhead: 10 };
    const okafor = DEMO_CLINIC.providers.filter((p) => p.id === 'prov_okafor');
    const assistant = findSlots(DEMO_CLINIC, [], { visitType: sick, providers: okafor, from: '2026-09-29', days: 30, now, limit: 500 });
    expect(assistant[0]!.start.getTime()).toBeGreaterThanOrEqual(at('2026-09-30', '20:00').getTime());
    expect(assistant.at(-1)!.start.getTime()).toBeLessThan(at('2026-10-09', '00:00').getTime());
    const desk = findSlots(DEMO_CLINIC, [], { visitType: sick, providers: okafor, from: '2026-09-29', days: 30, now, limit: 5000, actor: 'desk' });
    expect(desk[0]!.start).toEqual(at('2026-09-29', '08:00'));
    expect(desk.at(-1)!.start.getTime()).toBeGreaterThan(at('2026-10-20', '00:00').getTime());
    // every start the assistant lists, the desk lists too
    const starts = new Set(desk.map((s) => s.start.getTime()));
    expect(assistant.every((s) => starts.has(s.start.getTime()))).toBe(true);
  });
});
