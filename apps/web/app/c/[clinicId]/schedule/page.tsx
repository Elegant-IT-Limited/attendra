// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Appointment, Schedule } from '@attendra/api/contracts';
import { addDays, bookableProviders, bookableWindows, type ClinicConfig, industryPack, localDateOf, shownProviders, weekdayOf, windowsOn, providerName } from '@attendra/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, ChevronLeft, ChevronRight, Plus, User } from 'lucide-react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Agenda } from '@/components/schedule/agenda';
import { AppointmentPanel } from '@/components/schedule/appointment-panel';
import { BookingDialog } from '@/components/schedule/booking-dialog';
import { Calendar, MonthGrid, ScheduleList } from '@/components/schedule/calendar';
import { CancelledHistory } from '@/components/schedule/cancelled-history';
import { PatientPicker } from '@/components/patients/patient-picker';
import { ConflictsAlert } from '@/components/schedule/conflicts-alert';
import { VetsPicker } from '@/components/schedule/vets-picker';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { api, useClinic, useClinicConfig } from '@/lib/api';
import { dayTitle, firstWeekday, VISIT_DOTS, visitTypeName, zoneLabel } from '@/lib/format';
import { capLanes, laneProviders, MANY_PROVIDERS, readChosen, readView, writeChosen, writeView } from '@/lib/schedule-lanes';
import { cn } from '@/lib/utils';
import { SAFETY_POLL_MS } from '@/lib/changes';

/** How a visit shows to a role that sees the schedule without names (a viewer). */
const NAMELESS_VISIT = 'Booked visit';

type View = 'day' | 'week' | 'month' | 'agenda';
// plain labels, each with a one-line hint (ezyVet and Provet Cloud name their views the same way)
const VIEWS: { value: View; label: string; hint: string }[] = [
  { value: 'day', label: 'Day', hint: 'One column per vet' },
  { value: 'week', label: 'Week', hint: '7 days side by side' },
  { value: 'month', label: 'Month', hint: 'The month at a glance' },
  { value: 'agenda', label: 'Agenda', hint: 'Every visit as a list, in time order' },
];

export default function SchedulePage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><ScheduleScreen /></Suspense>;
}

const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));
/** The first day of the week a date is in on the clinic's calendar: the Sunday before at a US clinic (lib/format firstWeekday). */
const weekStartOf = (date: string) => addDays(date, -((weekdayOf(date) - firstWeekday() + 7) % 7));
/**
 * What the schedule shows when nobody chose: booked visits only, in every view, as ezyVet and Provet open theirs.
 * Cancelled ones are a choice away (Booked and cancelled, or the Cancelled history), and the page says when any are hidden.
 */
const DEFAULT_SHOW = 'booked';
/** The first of the month a date is in, and of the months before and after it. */
const monthOf = (date: string) => `${date.slice(0, 7)}-01`;
const shiftMonth = (date: string, by: number) => {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-01`;
};
const monthTitle = (date: string) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${monthOf(date)}T12:00:00Z`));

/** The days a week view shows: Monday to Friday, and a weekend day only when the clinic opens or something is booked. */
function weekDays(clinic: ClinicConfig, monday: string, appointments: Appointment[]) {
  const all = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return all.filter((d) => {
    const wd = weekdayOf(d);
    if (wd >= 1 && wd <= 5) return true;
    return windowsOn(clinic.hours, wd).length > 0 || clinic.providers.some((p) => bookableWindows(clinic, p, d).windows.length > 0)
      || appointments.some((a) => localDateOf(new Date(a.startsAt), clinic.timezone) === d);
  });
}

function ScheduleScreen() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can, isPending: meLoading } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const clinic = config.data;
  const tz = clinic?.timezone ?? 'UTC';
  const today = localDateOf(new Date(), tz);
  // how many can be booked: past MANY_PROVIDERS the day grid draws only the lanes in use and the ones chosen
  const bookable = clinic ? bookableProviders(clinic.providers).length : 0;
  const manyProviders = bookable > MANY_PROVIDERS;
  const asked = params.get('view');
  // everyone opens on Day, or on the view they chose last time in this browser; a big clinic's Day shows the vets in use
  const [remembered, setRemembered] = useState<View>('day');
  useEffect(() => { setRemembered(readView(clinicId)); }, [clinicId]);
  const view: View = asked === 'week' || asked === 'month' || asked === 'agenda' || asked === 'day' ? asked : remembered;
  // the Agenda lists a day, or the week with ?days=7
  const agendaWeek = view === 'agenda' && params.get('days') === '7';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : today;
  const open = params.get('appointment');
  const [providerId, setProviderId] = useState('');
  // the lanes this person pinned on a big clinic's grid, kept in this browser
  const [chosen, setChosen] = useState<string[]>([]);
  const providerList = clinic?.providers;
  useEffect(() => { if (providerList) setChosen(readChosen(clinicId, providerList)); }, [clinicId, providerList]);
  const choose = (ids: string[]) => { setChosen(ids); writeChosen(clinicId, ids); };
  // booked only, booked and cancelled, or cancelled only (a history list); booked only unless chosen, in every view
  const shown = params.get('show');
  const show: 'booked' | 'all' | 'cancelled' = shown === 'booked' || shown === 'all' || shown === 'cancelled' ? shown : DEFAULT_SHOW;
  // ?new=1 (the command palette and the N key) opens New booking straight away
  const [booking, setBookingState] = useState(params.get('new') === '1');
  const setBooking = (open: boolean) => { setBookingState(open); if (!open && params.get('new')) set({ new: null }); };
  // and so does it again while this page is already open: the page stays mounted when only the query changes
  const wantsNew = params.get('new') === '1';
  useEffect(() => { if (wantsNew) setBookingState(true); }, [wantsNew]);

  const set = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) { if (v === null) q.delete(k); else q.set(k, v); }
    router.replace(`${pathname}?${q}`, { scroll: false });
  };

  // a month is six whole weeks, from the first day of the week the 1st is in (Sunday at a US clinic)
  const weekly = view === 'week' || agendaWeek;
  const from = view === 'month' ? weekStartOf(monthOf(date)) : weekly ? mondayOf(date) : date;
  const days = view === 'month' ? 42 : weekly ? 7 : 1;
  const schedule = useQuery({
    queryKey: ['schedule', clinicId, from, days, providerId],
    queryFn: () => api<Schedule>(`/clinics/${clinicId}/appointments?${new URLSearchParams({ from, days: String(days), ...(providerId ? { providerId } : {}) })}`),
    enabled: !!clinic && can('schedule:list') && show !== 'cancelled',
    placeholderData: keepPreviousData,
    refetchInterval: SAFETY_POLL_MS,
  });

  const showCancelled = show === 'all';
  // the visit open in the panel stays on the grid when it is cancelled there, so the block does not vanish behind it
  // a viewer's schedule carries no patient: each visit shows as a booked visit, and does not open
  const named = can('schedule:read');
  const appointments = useMemo(() => (schedule.data?.appointments ?? []).filter((a) => showCancelled || a.status !== 'cancelled' || a.id === open)
    .map((a) => (a.patientName ? a : { ...a, patientName: NAMELESS_VISIT })), [schedule.data, showCancelled, open]);
  const hidden = (schedule.data?.appointments.length ?? 0) - appointments.length;

  if (!meLoading && !can('schedule:list')) {
    return <><PageHeader title="Schedule" /><Card><Empty title="The schedule is for the front desk">Your role cannot see the schedule. Ask a practice manager if you need it.</Empty></Card></>;
  }
  if (!clinic) return <><PageHeader title="Schedule" /><Skeleton className="h-96" /></>;
  // the stand-in a new clinic starts with is shown only while it is the only one, or has visits on screen
  const listed = shownProviders(clinic.providers, (schedule.data?.appointments ?? []).map((a) => a.providerId));
  const dates = view === 'month' ? Array.from({ length: 42 }, (_, i) => addDays(from, i))
    : weekly ? weekDays(clinic, from, schedule.data?.appointments ?? []) : [date];
  // one provider picked in the dropdown is the grid; otherwise every lane, or on a big clinic the lanes in use (lib/schedule-lanes.ts)
  const lanesInUse = providerId ? listed.filter((p) => p.id === providerId) : laneProviders(clinic, listed, dates, appointments.map((a) => a.providerId), chosen);
  // A big clinic's Day and Week draw at most MAX_CHOSEN lanes, My vets first, then the others with visits (note 24): a
  // hundred vets is a hundred columns nobody reads, and × five days 40,000 px wide (ezyVet's Week shows one calendar).
  // The line under the title says how many of how many, and the Agenda lists everyone, one click away.
  const { lanes: providers, capped } = capLanes(lanesInUse, chosen, !providerId && manyProviders);
  const step = weekly ? 7 : 1;
  const go = (by: 1 | -1) => set({ date: view === 'month' ? shiftMonth(date, by) : addDays(date, by * step) });
  const unit = view === 'month' ? 'month' : weekly ? 'week' : 'day';
  // every visit on the calendar, whatever the desk marked it
  const booked = appointments.filter((a) => a.status !== 'cancelled').length;
  const writable = can('schedule:write');
  const pets = industryPack(clinic.industry).identity === 'pet';

  return (
    <>
      <PageHeader title="Schedule" description={<>Every booking, whoever made it. Times are {zoneLabel(tz)}.{named ? '' : ' Your role sees when visits are and with whom, without names.'}</>}
        actions={writable && <Button onClick={() => setBooking(true)}><Plus /> New booking</Button>} />
      <ConflictsAlert clinicId={clinicId} className="mb-4" />
      <div className="mb-4 space-y-2" data-testid="schedule-toolbar">
        {/* Row 1, the same controls in the same places in every view: where you are, the date, the view, and the
            Agenda's range last (it is the only one that comes and goes). Row 2: every filter, always in this order. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-7 pb-5" data-toolbar="schedule">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => go(-1)} aria-label={`Previous ${unit}`}><ChevronLeft /></Button>
            <Button variant="outline" size="sm" onClick={() => set({ date: today })} disabled={view === 'month' ? monthOf(today) === monthOf(date) : weekly ? mondayOf(today) === from : date === today}>Today</Button>
            <Button variant="outline" size="sm" onClick={() => go(1)} aria-label={`Next ${unit}`}><ChevronRight /></Button>
          </div>
          <div className="space-y-1">
            <Label htmlFor="schedule-date" className="sr-only">Date</Label>
            <Input id="schedule-date" type="date" className="h-8 w-40" value={date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
          </div>
          <div className="relative">
            <div className="flex rounded-md border border-border-strong p-0.5" role="tablist" aria-label="View">
              {VIEWS.map((v) => (
                <button key={v.value} id={`schedule-tab-${v.value}`} aria-controls="schedule-panel" role="tab" aria-selected={view === v.value} title={v.hint} aria-describedby="schedule-view-hint"
                  onClick={() => { set({ view: v.value }); setRemembered(v.value); writeView(clinicId, v.value); }}
                  className={cn('rounded px-3 py-1 text-sm focus-ring', view === v.value ? 'bg-primary text-on-primary' : 'text-text-muted hover:text-text')}>
                  {v.label}
                </button>
              ))}
            </div>
            {/* the view's hint, a small caption under the buttons: out of the flow, so its length never moves anything */}
            <p id="schedule-view-hint" className="pointer-events-none absolute left-0 top-full mt-1 whitespace-nowrap text-xs text-text-muted">{VIEWS.find((v) => v.value === view)!.hint}</p>
          </div>
          {/* the Agenda's range keeps its place in every view (hidden and inert where the view has none), so row 1 wraps
              the same way on a phone and nothing below it moves */}
          <div className={cn('flex rounded-md border border-border-strong p-0.5', view !== 'agenda' && 'invisible')} role="group" aria-label="Agenda range"
            aria-hidden={view !== 'agenda' || undefined} inert={view !== 'agenda' || undefined}>
            {([['1', date === today ? 'Today' : 'This day'], ['7', 'This week']] as const).map(([d, label]) => (
              <button key={d} type="button" aria-pressed={agendaWeek === (d === '7')} onClick={() => set({ days: d === '7' ? '7' : null })}
                className={cn('rounded px-3 py-1 text-sm focus-ring', agendaWeek === (d === '7') ? 'bg-primary text-on-primary' : 'text-text-muted hover:text-text')}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3" data-toolbar="schedule-filters">
          <div className="space-y-1">
            <Label htmlFor="schedule-provider" className="sr-only">Provider</Label>
            <Select id="schedule-provider" className="h-8 w-64" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">{pets ? 'All veterinarians' : 'All providers'}</option>
              {listed.map((p) => <option key={p.id} value={p.id}>{p.specialty ? `${providerName(p)}, ${p.specialty}` : providerName(p)}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="schedule-show" className="sr-only">Show</Label>
            <Select id="schedule-show" className="h-8 w-56" value={show} onChange={(e) => set({ show: e.target.value })}>
              <option value="booked">Booked</option>
              <option value="all">Booked and cancelled</option>
              <option value="cancelled">Cancelled (history)</option>
            </Select>
          </div>
          {/* the vets picker (big clinics, Day and Week) comes last, so it never moves the filters before it */}
          {manyProviders && (view === 'day' || view === 'week') && (
            <VetsPicker clinic={clinic} providers={listed} date={date} chosen={chosen} onChange={choose} word={pets ? 'veterinarians' : 'providers'} onGrid={providers.length} />
          )}
        </div>
      </div>

      {show === 'cancelled' ? (
        <Card className="overflow-hidden" data-testid="cancelled">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-semibold">Cancelled visits</h2>
            <p className="text-xs text-text-muted">The history of cancellations: who cancelled, why and when. Open one to see the visit.</p>
          </div>
          <CancelledHistory clinicId={clinicId} clinic={clinic} providerId={providerId} onOpen={(id) => named && set({ appointment: id })} />
        </Card>
      ) : (
      // busy while the grid still shows the previous range: screen readers and tests wait for it
      <Card className="overflow-hidden" data-testid="schedule" role="tabpanel" id="schedule-panel" aria-labelledby={`schedule-tab-${view}`} aria-busy={schedule.isPending || schedule.isPlaceholderData}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-semibold">{view === 'month' ? monthTitle(date) : weekly ? `Week of ${dayTitle(from)}` : dayTitle(date)}{!weekly && view !== 'month' && date === today ? ', today' : ''}</h2>
            <p className="text-xs text-text-muted">
              {schedule.isPending ? 'Loading…' : `${booked} booked${hidden > 0 ? `, ${hidden} cancelled hidden` : ''}${!weekly && view !== 'month' && clinic.holidays.includes(date) ? '. The clinic is closed for a holiday.' : ''}${capped ? `. ${weekly ? 'The week' : 'The day'} shows ${providers.length} of the ${lanesInUse.length} ${pets ? 'vets' : 'providers'} in use: ${chosen.length ? `My ${pets ? 'vets' : 'providers'} first` : `choose ${pets ? 'vets' : 'providers'} to pick which`}, or use Agenda for everyone.` : ''}`}
            </p>
          </div>
          <Legend clinic={clinic} />
        </div>
        {schedule.isError && <Alert tone="danger" className="m-4">The schedule did not load. It retries on its own; refresh the page if it keeps failing.</Alert>}
        {schedule.isPending ? <div className="space-y-3 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}</div> : (
          <>
            <div className="hidden md:block">
              {view === 'month'
                ? <MonthGrid clinic={clinic} month={date.slice(0, 7)} dates={dates} appointments={appointments} today={today} onOpen={(id) => named && set({ appointment: id })} onDay={(d) => set({ view: 'day', date: d })} />
                : view === 'agenda'
                  ? <Agenda clinic={clinic} dates={dates} appointments={appointments} onOpen={(id) => named && set({ appointment: id })} word={pets ? 'veterinarian' : 'provider'} />
                  : <Calendar clinic={clinic} dates={dates} providers={providers} appointments={appointments} today={today} now={new Date()} onOpen={(id) => named && set({ appointment: id })} />}
            </div>
            <div className="md:hidden">
              <ScheduleList clinic={clinic} dates={view === 'month' ? dates.filter((d) => d.startsWith(date.slice(0, 7))) : dates} appointments={appointments} onOpen={(id) => named && set({ appointment: id })} />
            </div>
            {appointments.length === 0 && view !== 'month' && view !== 'agenda' && (hidden > 0 ? (
              <div className="hidden md:block"><Empty title="Nothing booked here">{hidden === 1 ? 'A cancelled visit is' : `${hidden} cancelled visits are`} hidden. Choose Booked and cancelled to see {hidden === 1 ? 'it' : 'them'}.</Empty></div>
            ) : (
              <div className="hidden md:block"><Empty title="Nothing booked here yet">Bookings the assistant takes on the phone, and ones you make with New booking, appear on this grid.{manyProviders && !providerId ? ` Pick ${pets ? 'veterinarians' : 'providers'} with ${pets ? 'Vets' : 'Providers'} to see their lanes meanwhile.` : ''}</Empty></div>
            ))}
          </>
        )}
      </Card>
      )}

      <AppointmentPanel clinicId={clinicId} clinic={clinic} appointmentId={named ? open : null} onClose={() => set({ appointment: null, move: null })} canWrite={writable}
        startMoving={params.get('move') === '1'}
        patientHref={can('patients:read') ? (id) => `/c/${clinicId}/patients/${id}` : undefined} />
      {writable && (
        <BookingDialog clinicId={clinicId} clinic={clinic} open={booking} onOpenChange={setBooking}
          findPatient={(pick) => <PatientPicker clinicId={clinicId} onPick={pick} canAdd={can('patients:write')} />}
          onBooked={(id, startsAt) => set({ new: null, date: localDateOf(new Date(startsAt), tz), appointment: id })} />
      )}
    </>
  );
}

function Legend({ clinic }: { clinic: ClinicConfig }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted" aria-label="Legend">
      {clinic.visitTypes.map((v, i) => (
        <li key={v.id} className="flex items-center gap-1.5"><span className={cn('size-2.5 rounded-full', VISIT_DOTS[i % VISIT_DOTS.length])} aria-hidden />{visitTypeName(v.name)}</li>
      ))}
      <li className="flex items-center gap-1"><Bot className="size-3.5" aria-hidden /> Booked by the assistant</li>
      <li className="flex items-center gap-1"><User className="size-3.5" aria-hidden /> Booked by staff</li>
    </ul>
  );
}
