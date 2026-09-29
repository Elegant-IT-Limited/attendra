// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Appointment, Schedule } from '@attendra/api/contracts';
import { addDays, type ClinicConfig, localDateOf, weekdayOf, windowsOn } from '@attendra/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, ChevronLeft, ChevronRight, Plus, User } from 'lucide-react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { AppointmentPanel } from '@/components/schedule/appointment-panel';
import { BookingDialog, capital } from '@/components/schedule/booking-dialog';
import { Calendar, ScheduleList } from '@/components/schedule/calendar';
import { PatientPicker } from '@/components/patients/patient-picker';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { api, useClinic, useClinicConfig } from '@/lib/api';
import { dayTitle, VISIT_DOTS, zoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

export default function SchedulePage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><ScheduleScreen /></Suspense>;
}

const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));

/** The days a week view shows: Monday to Friday, and a weekend day only when the clinic opens or something is booked. */
function weekDays(clinic: ClinicConfig, monday: string, appointments: Appointment[]) {
  const all = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return all.filter((d) => {
    const wd = weekdayOf(d);
    if (wd >= 1 && wd <= 5) return true;
    return windowsOn(clinic.hours, wd).length > 0 || clinic.providers.some((p) => p.hours && windowsOn(p.hours, wd).length > 0)
      || appointments.some((a) => localDateOf(new Date(a.startsAt), clinic.timezone) === d);
  });
}

function ScheduleScreen() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const clinic = config.data;
  const tz = clinic?.timezone ?? 'UTC';
  const today = localDateOf(new Date(), tz);
  const view = params.get('view') === 'week' ? 'week' : 'day';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : today;
  const open = params.get('appointment');
  const [providerId, setProviderId] = useState('');
  // in a week the columns are narrow and a cancelled block sits on top of the booking that replaced it, so they start hidden there
  const [cancelledShown, setCancelledShown] = useState({ day: true, week: false });
  const [booking, setBooking] = useState(false);

  const set = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) { if (v === null) q.delete(k); else q.set(k, v); }
    router.replace(`${pathname}?${q}`, { scroll: false });
  };

  const from = view === 'week' ? mondayOf(date) : date;
  const days = view === 'week' ? 7 : 1;
  const schedule = useQuery({
    queryKey: ['schedule', clinicId, from, days, providerId],
    queryFn: () => api<Schedule>(`/clinics/${clinicId}/appointments?${new URLSearchParams({ from, days: String(days), ...(providerId ? { providerId } : {}) })}`),
    enabled: !!clinic,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const showCancelled = cancelledShown[view];
  const setShowCancelled = (v: boolean) => setCancelledShown((c) => ({ ...c, [view]: v }));
  const appointments = useMemo(() => (schedule.data?.appointments ?? []).filter((a) => showCancelled || a.status === 'booked'), [schedule.data, showCancelled]);

  if (!clinic) return <><PageHeader title="Schedule" /><Skeleton className="h-96" /></>;
  const providers = clinic.providers.filter((p) => !providerId || p.id === providerId);
  const dates = view === 'week' ? weekDays(clinic, from, schedule.data?.appointments ?? []) : [date];
  const step = view === 'week' ? 7 : 1;
  const booked = appointments.filter((a) => a.status === 'booked').length;
  const writable = can('schedule:write');

  return (
    <>
      <PageHeader title="Schedule" description={<>Every booking, whoever made it. Times are {zoneLabel(tz)}.</>}
        actions={writable && <Button onClick={() => setBooking(true)}><Plus /> New booking</Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => set({ date: addDays(date, -step) })} aria-label={view === 'week' ? 'Previous week' : 'Previous day'}><ChevronLeft /></Button>
          <Button variant="outline" size="sm" onClick={() => set({ date: today })} disabled={view === 'day' ? date === today : mondayOf(today) === from}>Today</Button>
          <Button variant="outline" size="sm" onClick={() => set({ date: addDays(date, step) })} aria-label={view === 'week' ? 'Next week' : 'Next day'}><ChevronRight /></Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="schedule-date" className="sr-only">Date</Label>
          <Input id="schedule-date" type="date" className="h-8 w-40" value={date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
        </div>
        <div className="flex rounded-md border border-input p-0.5" role="tablist" aria-label="View">
          {(['day', 'week'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => set({ view: v })}
              className={cn('rounded px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {v === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </div>
        <div className="space-y-1">
          <Label htmlFor="schedule-provider" className="sr-only">Provider</Label>
          <Select id="schedule-provider" className="h-8 w-48" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">All providers</option>
            {clinic.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <label className="flex h-8 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
          Show cancelled
        </label>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-semibold">{view === 'week' ? `Week of ${dayTitle(from)}` : dayTitle(date)}{view === 'day' && date === today ? ', today' : ''}</h2>
            <p className="text-xs text-muted-foreground">
              {schedule.isPending ? 'Loading…' : `${booked} booked${view === 'day' && clinic.holidays.includes(date) ? '. The clinic is closed for a holiday.' : ''}`}
            </p>
          </div>
          <Legend clinic={clinic} />
        </div>
        {schedule.isError && <Alert tone="danger" className="m-4">The schedule did not load. It retries on its own; refresh the page if it keeps failing.</Alert>}
        {schedule.isPending ? <div className="space-y-3 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}</div> : (
          <>
            <div className="hidden md:block">
              <Calendar clinic={clinic} dates={dates} providers={providers} appointments={appointments} today={today} now={new Date()} onOpen={(id) => set({ appointment: id })} />
            </div>
            <div className="md:hidden">
              <ScheduleList clinic={clinic} dates={dates} appointments={appointments} onOpen={(id) => set({ appointment: id })} />
            </div>
            {appointments.length === 0 && (
              <div className="hidden md:block"><Empty title="Nothing booked here yet">Bookings the assistant takes on the phone, and ones you make with New booking, appear on this grid.</Empty></div>
            )}
          </>
        )}
      </Card>

      <AppointmentPanel clinicId={clinicId} clinic={clinic} appointmentId={open} onClose={() => set({ appointment: null })} canWrite={writable}
        patientHref={can('patients:read') ? (id) => `/c/${clinicId}/patients/${id}` : undefined} />
      {writable && (
        <BookingDialog clinicId={clinicId} clinic={clinic} open={booking} onOpenChange={setBooking}
          findPatient={(pick) => <PatientPicker clinicId={clinicId} onPick={pick} canAdd={can('patients:write')} />}
          onBooked={(id, startsAt) => set({ date: localDateOf(new Date(startsAt), tz), appointment: id })} />
      )}
    </>
  );
}

function Legend({ clinic }: { clinic: ClinicConfig }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      {clinic.visitTypes.map((v, i) => (
        <li key={v.id} className="flex items-center gap-1.5"><span className={cn('size-2.5 rounded-full', VISIT_DOTS[i % VISIT_DOTS.length])} aria-hidden />{capital(v.name)}</li>
      ))}
      <li className="flex items-center gap-1"><Bot className="size-3.5" aria-hidden /> Booked by the assistant</li>
      <li className="flex items-center gap-1"><User className="size-3.5" aria-hidden /> Booked by staff</li>
    </ul>
  );
}
