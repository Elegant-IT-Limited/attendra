// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Appointment } from '@attendra/api/contracts';
import { type ClinicConfig, localParts, specialDayOf, toMinutes, weekdayOf, windowsOn } from '@attendra/core';
import { Bot, Check, User } from 'lucide-react';
import { Empty } from '@/components/ui/feedback';
import { dayTitle, timeOf, VISIT_DOTS, VISIT_TONES } from '@/lib/format';
import { cn } from '@/lib/utils';

const PX = 1.3; // pixels per minute: a 20-minute visit is 26 pixels tall
type Provider = ClinicConfig['providers'][number];

// a special day's own hours stand in for the week's
const hoursFor = (clinic: ClinicConfig, p: Provider, date: string) => specialDayOf(clinic, date)?.windows ?? windowsOn(p.hours ?? clinic.hours, weekdayOf(date));
/** Closed all day: a holiday, or a special day with no hours. What the calendar says instead of hours. */
const closedDay = (clinic: ClinicConfig, date: string) => {
  const special = specialDayOf(clinic, date);
  if (special) return special.windows.length ? null : special.note || 'Closed';
  return clinic.holidays.includes(date) ? 'Holiday' : null;
};
const minutesOf = (iso: string, tz: string) => localParts(new Date(iso), tz).minutes;
/** "Okafor" for "Dr. Nkem Okafor": what fits a week column. The full name is on hover. */
const shortName = (name: string) => name.replace(/^Dr\.?\s+/, '').split(/\s+/).at(-1) ?? name;

/**
 * The schedule as a grid: one column per provider for a day, or one column per day
 * with a lane per provider for a week. Closed time is shaded, holidays are marked,
 * and each appointment is a block as long as the visit.
 */
export function Calendar({ clinic, dates, providers, appointments, today, now, onOpen }: {
  clinic: ClinicConfig;
  dates: string[];
  providers: Provider[];
  appointments: Appointment[];
  today: string;
  now: Date;
  onOpen: (id: string) => void;
}) {
  const tz = clinic.timezone;
  const opens = dates.flatMap((d) => providers.flatMap((p) => hoursFor(clinic, p, d)));
  const booked = appointments.map((a) => [minutesOf(a.startsAt, tz), minutesOf(a.endsAt, tz)] as const);
  const start = Math.floor(Math.min(8 * 60, ...opens.map((w) => toMinutes(w.open)), ...booked.map(([s]) => s)) / 60) * 60;
  const end = Math.ceil(Math.max(17 * 60, ...opens.map((w) => toMinutes(w.close)), ...booked.map(([, e]) => e)) / 60) * 60;
  const height = (end - start) * PX;
  const hours = Array.from({ length: (end - start) / 60 }, (_, i) => start + i * 60);
  const week = dates.length > 1;
  const byDate = (date: string) => appointments.filter((a) => localParts(new Date(a.startsAt), tz).date === date);
  const nowMin = localParts(now, tz).minutes;
  const visitIndex = (id: string) => Math.max(0, clinic.visitTypes.findIndex((v) => v.id === id));

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        {/* column headings */}
        <div className="sticky top-0 z-20 grid border-b border-border bg-surface" style={{ gridTemplateColumns: `3.5rem repeat(${week ? dates.length : providers.length}, minmax(0, 1fr))` }}>
          <div />
          {week ? dates.map((d) => {
            const holiday = closedDay(clinic, d);
            return (
              <div key={d} className={cn('border-l border-border px-2 py-2 text-sm', d === today && 'bg-primary-soft')}>
                <p className={cn('font-medium', d === today && 'text-primary')}>{dayTitle(d, 'short')}</p>
                <div className="mt-1 flex gap-1 text-xs text-text-muted">
                  {holiday ? <span>{holiday === 'Holiday' ? 'Holiday, closed' : holiday}</span> : providers.map((p) => <span key={p.id} className="flex-1 truncate" title={p.name}><abbr title={p.name} className="no-underline">{shortName(p.name)}</abbr></span>)}
                </div>
              </div>
            );
          }) : providers.map((p) => (
            <div key={p.id} className="border-l border-border px-3 py-2.5 text-sm font-medium">{p.name}</div>
          ))}
        </div>
        <div className="relative grid" style={{ gridTemplateColumns: `3.5rem repeat(${week ? dates.length : providers.length}, minmax(0, 1fr))`, height }}>
          {/* hour labels and lines */}
          <div className="relative">
            {hours.map((h) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 whitespace-nowrap text-xs tabular-nums text-text-muted" style={{ top: (h - start) * PX }}>
                {h === start ? '' : `${((Math.floor(h / 60) + 11) % 12) + 1} ${h < 12 * 60 ? 'AM' : 'PM'}`}
              </span>
            ))}
          </div>
          {hours.slice(1).map((h) => <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/70" style={{ top: (h - start) * PX, left: '3.5rem' }} />)}
          {(week ? dates : [dates[0]!]).map((date) => (
            <div key={date} className="relative border-l border-border"
              style={week ? { gridTemplateColumns: `repeat(${providers.length}, minmax(0, 1fr))`, display: 'grid' } : { display: 'contents' }}>
              {providers.map((p) => (
                <Lane key={p.id} clinic={clinic} provider={p} date={date} start={start} end={end}
                  appointments={byDate(date).filter((a) => a.providerId === p.id)} onOpen={onOpen} visitIndex={visitIndex}
                  nowMin={date === today ? nowMin : null} divided={week} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Lane({ clinic, provider, date, start, end, appointments, onOpen, visitIndex, nowMin, divided }: {
  clinic: ClinicConfig; provider: Provider; date: string; start: number; end: number; appointments: Appointment[];
  onOpen: (id: string) => void; visitIndex: (id: string) => number; nowMin: number | null; divided: boolean;
}) {
  const tz = clinic.timezone;
  const holiday = closedDay(clinic, date);
  const open = holiday ? [] : hoursFor(clinic, provider, date).map((w) => [toMinutes(w.open), toMinutes(w.close)] as const);
  // closed stretches between the opening windows, shaded
  const closed: [number, number][] = [];
  let cursor = start;
  for (const [o, c] of open) { if (o > cursor) closed.push([cursor, o]); cursor = Math.max(cursor, c); }
  if (cursor < end) closed.push([cursor, end]);

  return (
    <div className={cn('relative', !divided ? 'border-l border-border' : 'border-l border-border/40 first:border-l-0')} data-testid="lane" role="group" aria-label={`${provider.name}, ${dayTitle(date)}`}>
      {closed.map(([s, e]) => (
        <div key={s} className="absolute inset-x-0 bg-[repeating-linear-gradient(135deg,var(--muted),var(--muted)_6px,transparent_6px,transparent_12px)] opacity-80"
          style={{ top: (s - start) * PX, height: (e - s) * PX }} aria-hidden />
      ))}
      {holiday && <p className="absolute inset-x-0 top-3 text-center text-xs font-medium text-text-muted">{holiday}</p>}
      {nowMin !== null && nowMin >= start && nowMin <= end && (
        <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: (nowMin - start) * PX }} aria-hidden />
      )}
      {appointments.map((a) => {
        const s = minutesOf(a.startsAt, tz);
        const e = minutesOf(a.endsAt, tz);
        const cancelled = a.status === 'cancelled';
        const Icon = a.bookedBy.kind === 'assistant' ? Bot : User;
        const h = Math.max((e - s) * PX - 2, 18);
        return (
          <button key={a.id} type="button" onClick={() => onOpen(a.id)} data-testid="appointment"
            aria-label={`${timeOf(a.startsAt, tz)}, ${a.patientName}, ${clinic.visitTypes.find((v) => v.id === a.visitTypeId)?.name ?? ''}${cancelled ? ', cancelled' : ''}${a.confirmedAt && !cancelled ? ', confirmed' : ''}, booked by ${a.bookedBy.kind === 'assistant' ? 'the assistant' : 'staff'}`}
            className={cn('absolute overflow-hidden rounded-md border border-border/60 border-l-4 px-1.5 text-left text-xs leading-tight shadow-xs transition hover:z-20 hover:shadow-md focus-visible:z-20 focus-ring',
              VISIT_TONES[visitIndex(a.visitTypeId) % VISIT_TONES.length],
              cancelled ? 'right-0.5 left-1/2 z-0 border-dashed text-text-muted' : 'inset-x-0.5 z-10')}
            style={{ top: (s - start) * PX + 1, height: h }}>
            <span className={cn('flex items-center gap-1', h > 30 ? 'pt-1' : 'pt-0.5')}>
              <Icon className="size-3 shrink-0 text-text-muted" aria-hidden />
              {/* too short for a second line: the time goes on the first, and both truncate together */}
              <span className={cn('truncate font-medium', cancelled && 'line-through')}>
                {a.confirmedAt && !cancelled && <Check className="mr-0.5 inline size-3 text-success" aria-hidden />}
                {a.patientName}{h > 30 ? '' : <span className="font-normal text-text-muted"> · {timeOf(a.startsAt, tz)}</span>}
              </span>
            </span>
            {h > 30 && <span className={cn('block truncate text-text-muted', cancelled && 'line-through')}>{timeOf(a.startsAt, tz)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The same appointments as a list, for a phone: the grid does not fit in 390 pixels. */
export function ScheduleList({ clinic, dates, appointments, onOpen }: { clinic: ClinicConfig; dates: string[]; appointments: Appointment[]; onOpen: (id: string) => void }) {
  const tz = clinic.timezone;
  const provider = (id: string) => clinic.providers.find((p) => p.id === id)?.name ?? id;
  const visit = (id: string) => clinic.visitTypes.find((v) => v.id === id)?.name ?? id;
  const idx = (id: string) => Math.max(0, clinic.visitTypes.findIndex((v) => v.id === id));
  const days = dates.map((d) => ({ date: d, items: appointments.filter((a) => localParts(new Date(a.startsAt), tz).date === d) })).filter((d) => d.items.length || dates.length === 1);
  if (!days.length) return <Empty title="Nothing booked">No appointments in this range.</Empty>;
  return (
    <div className="divide-y divide-border">
      {days.map(({ date, items }) => (
        <section key={date} className="py-3">
          <h3 className="px-4 pb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            {dayTitle(date)}{closedDay(clinic, date) ? `, ${closedDay(clinic, date)!.toLowerCase()}` : ''}
          </h3>
          {items.length === 0 ? <p className="px-4 text-sm text-text-muted">Nothing booked.</p> : (
            <ul>
              {items.map((a) => {
                const Icon = a.bookedBy.kind === 'assistant' ? Bot : User;
                return (
                  <li key={a.id}>
                    <button type="button" onClick={() => onOpen(a.id)} className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none">
                      <span className="w-16 shrink-0 tabular-nums text-text-muted">{timeOf(a.startsAt, tz)}</span>
                      <span className={cn('size-2 shrink-0 rounded-full', VISIT_DOTS[idx(a.visitTypeId) % VISIT_DOTS.length])} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate font-medium', a.status === 'cancelled' && 'line-through text-text-muted')}>{a.patientName}</span>
                        <span className="block truncate text-xs text-text-muted">{visit(a.visitTypeId)}, {provider(a.providerId)}{a.status === 'cancelled' ? ', cancelled' : ''}</span>
                      </span>
                      <Icon className="size-3.5 shrink-0 text-text-muted" aria-label={a.bookedBy.kind === 'assistant' ? 'Booked by the assistant' : 'Booked by staff'} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

const MONTH_SHOWN = 3;

/**
 * A month at a glance: six weeks from the Monday before the 1st, a box per day with
 * its first visits (time, name, visit colour) and how many more. A day's number opens
 * that day; a visit opens its panel. Days of other months are dimmed, closed days say so.
 */
export function MonthGrid({ clinic, month, dates, appointments, today, onOpen, onDay }: {
  clinic: ClinicConfig;
  /** "2026-10" */
  month: string;
  dates: string[];
  appointments: Appointment[];
  today: string;
  onOpen: (id: string) => void;
  onDay: (date: string) => void;
}) {
  const tz = clinic.timezone;
  const idx = (id: string) => Math.max(0, clinic.visitTypes.findIndex((v) => v.id === id));
  const byDate = new Map<string, Appointment[]>();
  for (const a of [...appointments].sort((x, y) => x.startsAt.localeCompare(y.startsAt))) {
    const d = localParts(new Date(a.startsAt), tz).date;
    byDate.set(d, [...(byDate.get(d) ?? []), a]);
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]" role="grid" aria-label="Month">
        <div className="grid grid-cols-7 border-b border-border text-xs font-medium text-text-muted" role="row">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} role="columnheader" className="px-2 py-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {dates.map((d) => {
            const items = byDate.get(d) ?? [];
            const other = !d.startsWith(month);
            const closed = closedDay(clinic, d);
            return (
              <div key={d} role="gridcell" data-testid="month-day" aria-label={`${dayTitle(d)}, ${items.length} booked`}
                className={cn('min-h-28 border-b border-l border-border p-1.5 [&:nth-child(7n+1)]:border-l-0', other && 'bg-surface-sunken/50', d === today && 'bg-primary-soft/40')}>
                <div className="mb-1 flex items-center justify-between gap-1">
                  <button type="button" onClick={() => onDay(d)} aria-label={`Open ${dayTitle(d)}`}
                    className={cn('focus-ring flex size-7 items-center justify-center rounded-full text-sm tabular-nums hover:bg-surface-sunken',
                      d === today ? 'bg-primary font-semibold text-on-primary hover:bg-primary' : other ? 'text-text-muted' : 'font-medium')}>
                    {Number(d.slice(8))}
                  </button>
                  {closed && <span className="truncate text-xs text-text-muted" title={closed}>{closed}</span>}
                </div>
                <ul className="space-y-0.5">
                  {items.slice(0, MONTH_SHOWN).map((a) => (
                    <li key={a.id}>
                      <button type="button" onClick={() => onOpen(a.id)} data-testid="appointment"
                        className="focus-ring flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-surface-sunken">
                        <span className={cn('size-2 shrink-0 rounded-full', VISIT_DOTS[idx(a.visitTypeId) % VISIT_DOTS.length])} aria-hidden />
                        <span className="shrink-0 tabular-nums text-text-muted">{timeOf(a.startsAt, tz)}</span>
                        <span className={cn('truncate', a.status === 'cancelled' && 'line-through text-text-muted')}>{a.patientName}</span>
                        {a.confirmedAt && a.status === 'booked' && <Check className="size-3 shrink-0 text-success" aria-label="confirmed" />}
                      </button>
                    </li>
                  ))}
                </ul>
                {items.length > MONTH_SHOWN && (
                  <button type="button" onClick={() => onDay(d)} className="focus-ring mt-0.5 rounded px-1 text-xs font-medium text-primary hover:underline">
                    {items.length - MONTH_SHOWN} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
