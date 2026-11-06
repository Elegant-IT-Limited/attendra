import { QueryClient } from '@tanstack/react-query';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matcher, SAFETY_POLL_MS, SAFETY_POLL_WORDS, STALE, staleKeys } from '../lib/changes';
import { patchAppointment, patchRequestElsewhere } from '../lib/optimistic';

/**
 * What a notice on the change stream refreshes, what a click shows before the server
 * answers, and that the screens the stream covers no longer poll fast (batch 3).
 */
const key = (...k: unknown[]) => ({ queryKey: k });

describe('what a notice makes stale', () => {
  it('a clinic\'s keys for that clinic only; the person\'s keys wherever they are', () => {
    const m = matcher('clinic_a', staleKeys(['requests', 'me']));
    expect(m(key('tasks', 'clinic_a', 'open'))).toBe(true);
    expect(m(key('tasks', 'clinic_b', 'open'))).toBe(false);
    expect(m(key('me'))).toBe(true);
    expect(m(key('me', 'invitations'))).toBe(true);
    expect(m(key('schedule', 'clinic_a'))).toBe(false);
    // outside any clinic, only the person's keys
    const out = matcher(null, staleKeys(['me', 'requests']));
    expect(out(key('me', 'invitations'))).toBe(true);
    expect(out(key('tasks', 'clinic_a'))).toBe(false);
  });

  it('a role change at this location refreshes who you are (the menu), and the new topics their screens', () => {
    expect(matcher('clinic_a', staleKeys(['team']))(key('me'))).toBe(true);
    expect([...staleKeys(['live'])]).toEqual(['live']);
    expect([...staleKeys(['knowledge'])]).toEqual(['knowledge']);
    expect([...staleKeys(['texts'])]).toEqual(['texts']);
  });

  it('"everything" is every topic\'s screens, and still never a patient record or a search (audited when read)', () => {
    const all = staleKeys(['*']);
    expect(all).toEqual(new Set(Object.values(STALE).flat()));
    for (const audited of ['patient', 'patient-search', 'request-search', 'call-search']) expect(all.has(audited), audited).toBe(false);
    expect(staleKeys('*')).toEqual(all);
  });

  it('says its safety poll in words from the same number', () => {
    expect(SAFETY_POLL_WORDS).toBe(`${SAFETY_POLL_MS / 60_000} minutes`);
  });
});

describe('a click shows its result at once, and is put back if the server says no', () => {
  const appt = { id: 'a1', patientId: 'p', patientName: 'Biscuit', providerId: 'dr_a', visitTypeId: 'v', startsAt: '2026-11-09T15:00:00.000Z', endsAt: '2026-11-09T15:30:00.000Z', status: 'booked' as const, cancelReason: null, bookedBy: { kind: 'staff' as const }, cancelledBy: null, createdAt: '2026-11-01T00:00:00.000Z', overrideReason: null, confirmedAt: null, confirmedVia: null, reminderSentAt: null };

  it('a move: every schedule range on screen and the open panel, keeping the length', async () => {
    const q = new QueryClient();
    q.setQueryData(['schedule', 'clinic_a', '2026-11-09', 7, ''], { from: '2026-11-09', days: 7, appointments: [appt] });
    q.setQueryData(['schedule', 'clinic_a', '2026-11-09', 1, ''], { from: '2026-11-09', days: 1, appointments: [appt] });
    q.setQueryData(['appointment', 'clinic_a', 'a1'], { ...appt, note: null });
    const undo = await patchAppointment(q, 'clinic_a', 'a1', { move: { startsAt: '2026-11-10T17:00:00.000Z', providerId: 'dr_b' } });
    for (const days of [7, 1]) {
      expect(q.getQueryData<{ appointments: typeof appt[] }>(['schedule', 'clinic_a', '2026-11-09', days, ''])!.appointments[0]).toMatchObject({ startsAt: '2026-11-10T17:00:00.000Z', endsAt: '2026-11-10T17:30:00.000Z', providerId: 'dr_b' });
    }
    expect(q.getQueryData(['appointment', 'clinic_a', 'a1'])).toMatchObject({ startsAt: '2026-11-10T17:00:00.000Z', note: null });
    undo();
    expect(q.getQueryData<{ appointments: typeof appt[] }>(['schedule', 'clinic_a', '2026-11-09', 7, ''])!.appointments[0]).toEqual(appt);
  });

  it('a cancel: marked cancelled with its reason; another clinic\'s schedule untouched', async () => {
    const q = new QueryClient();
    q.setQueryData(['schedule', 'clinic_a', 'x'], { from: 'x', days: 1, appointments: [appt] });
    q.setQueryData(['schedule', 'clinic_b', 'x'], { from: 'x', days: 1, appointments: [appt] });
    await patchAppointment(q, 'clinic_a', 'a1', { cancel: { reason: 'patient_asked' } });
    expect(q.getQueryData<{ appointments: typeof appt[] }>(['schedule', 'clinic_a', 'x'])!.appointments[0]).toMatchObject({ status: 'cancelled', cancelReason: 'patient_asked' });
    expect(q.getQueryData<{ appointments: typeof appt[] }>(['schedule', 'clinic_b', 'x'])!.appointments[0]!.status).toBe('booked');
  });

  it('a request claimed or closed leaves Today\'s waiting list; closed, the menu\'s count drops', async () => {
    const q = new QueryClient();
    const waiting = { tasks: [{ id: 't1', number: 1, type: 'callback', createdAt: '2026-11-09T15:00:00.000Z', callId: null, urgent: false }, { id: 't2', number: 2, type: 'refill', createdAt: '2026-11-09T15:00:00.000Z', callId: null, urgent: false }], total: 2 };
    q.setQueryData(['tasks', 'clinic_a', 'waiting'], waiting);
    q.setQueryData(['tasks', 'clinic_a', 'count'], { open: 5 });
    const undo = await patchRequestElsewhere(q, 'clinic_a', 't1', 'claim');
    expect(q.getQueryData(['tasks', 'clinic_a', 'waiting'])).toMatchObject({ tasks: [{ id: 't2' }], total: 1 });
    // a claim leaves it open
    expect(q.getQueryData(['tasks', 'clinic_a', 'count'])).toEqual({ open: 5 });
    undo();
    expect(q.getQueryData(['tasks', 'clinic_a', 'waiting'])).toEqual(waiting);
    await patchRequestElsewhere(q, 'clinic_a', 't2', 'done');
    expect(q.getQueryData(['tasks', 'clinic_a', 'count'])).toEqual({ open: 4 });
    // a note changes neither
    await patchRequestElsewhere(q, 'clinic_a', 't1', 'notes');
    expect(q.getQueryData(['tasks', 'clinic_a', 'count'])).toEqual({ open: 4 });
  });
});

describe('the stream, not a timer, keeps these screens current', () => {
  // the screens whose data the stream covers, by the file that shows them
  const COVERED = ['app/c/[clinicId]/page.tsx', 'app/c/[clinicId]/calls/page.tsx', 'app/c/[clinicId]/schedule/page.tsx', 'app/c/[clinicId]/requests/page.tsx',
    'app/c/[clinicId]/settings/knowledge/page.tsx', 'app/c/[clinicId]/calls/[callId]/page.tsx', 'components/shell.tsx', 'components/invitations-banner.tsx',
    'components/schedule/conflicts-alert.tsx', 'components/calls/test-call.tsx', 'lib/live.ts'];
  it('no covered screen polls faster than the safety net', () => {
    for (const file of COVERED) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8');
      for (const m of src.matchAll(/refetchInterval:\s*([^,}\n]+)/g)) {
        const v = m[1]!.trim();
        // a number written out is a timer of its own: only the safety net is allowed
        expect(/^\d[\d_]*$/.test(v) || /\b\d[\d_]*\s*\*\s*\d/.test(v) ? `${file}: ${v}` : 'ok').toBe('ok');
      }
    }
  });

  it('and every screen file the list names still exists', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const all = new Set([...walk(join(__dirname, '../app')), ...walk(join(__dirname, '../components')), ...walk(join(__dirname, '../lib'))].map((p) => p.slice(join(__dirname, '..').length + 1)));
    for (const file of COVERED) expect(all.has(file), file).toBe(true);
  });
});
