// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Appointment } from '@attendra/api/contracts';
import { type ClinicConfig, localParts, toMinutes, weekdayOf, windowsOn } from '@attendra/core';
import { Bot, User } from 'lucide-react';
import { Empty } from '@/components/ui/feedback';
import { dayTitle, timeOf, VISIT_DOTS, VISIT_TONES } from '@/lib/format';
import { cn } from '@/lib/utils';

const PX = 1.3; // pixels per minute: a 20-minute visit is 26 pixels tall
type Provider = ClinicConfig['providers'][number];

const hoursFor = (clinic: ClinicConfig, p: Provider, date: string) => windowsOn(p.hours ?? clinic.hours, weekdayOf(date));
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
        <div className="sticky top-0 z-20 grid border-b border-border bg-card" style={{ gridTemplateColumns: `3.5rem repeat(${week ? dates.length : providers.length}, minmax(0, 1fr))` }}>
          <div />
          {week ? dates.map((d) => {
            const holiday = clinic.holidays.includes(d);
            return (
              <div key={d} className={cn('border-l border-border px-2 py-2 text-sm', d === today && 'bg-accent')}>
                <p className={cn('font-medium', d === today && 'text-primary')}>{dayTitle(d, 'short')}</p>
                <div className="mt-1 flex gap-1 text-[11px] text-muted-foreground">
                  {holiday ? <span>Holiday, closed</span> : providers.map((p) => <span key={p.id} className="flex-1 truncate" title={p.name}><abbr title={p.name} className="no-underline">{shortName(p.name)}</abbr></span>)}
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
              <span key={h} className="absolute right-2 -translate-y-1/2 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground" style={{ top: (h - start) * PX }}>
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
  const holiday = clinic.holidays.includes(date);
  const open = holiday ? [] : hoursFor(clinic, provider, date).map((w) => [toMinutes(w.open), toMinutes(w.close)] as const);
  // closed stretches between the opening windows, shaded
  const closed: [number, number][] = [];
  let cursor = start;
  for (const [o, c] of open) { if (o > cursor) closed.push([cursor, o]); cursor = Math.max(cursor, c); }
  if (cursor < end) closed.push([cursor, end]);

  return (
    <div className={cn('relative', !divided ? 'border-l border-border' : 'border-l border-border/40 first:border-l-0')} data-testid="lane" aria-label={`${provider.name}, ${dayTitle(date)}`}>
      {closed.map(([s, e]) => (
        <div key={s} className="absolute inset-x-0 bg-[repeating-linear-gradient(135deg,var(--muted),var(--muted)_6px,transparent_6px,transparent_12px)] opacity-80"
          style={{ top: (s - start) * PX, height: (e - s) * PX }} aria-hidden />
      ))}
      {holiday && <p className="absolute inset-x-0 top-3 text-center text-xs font-medium text-muted-foreground">Holiday</p>}
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
            aria-label={`${timeOf(a.startsAt, tz)}, ${a.patientName}, ${clinic.visitTypes.find((v) => v.id === a.visitTypeId)?.name ?? ''}${cancelled ? ', cancelled' : ''}, booked by ${a.bookedBy.kind === 'assistant' ? 'the assistant' : 'staff'}`}
            className={cn('absolute overflow-hidden rounded-md border border-border/60 border-l-4 px-1.5 text-left text-[11px] leading-tight shadow-xs transition hover:z-20 hover:shadow-md focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              VISIT_TONES[visitIndex(a.visitTypeId) % VISIT_TONES.length],
              cancelled ? 'right-0.5 left-1/2 z-0 border-dashed opacity-60' : 'inset-x-0.5 z-10')}
            style={{ top: (s - start) * PX + 1, height: h }}>
            <span className={cn('flex items-center gap-1', h > 30 ? 'pt-1' : 'pt-0.5')}>
              <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className={cn('truncate font-medium', cancelled && 'line-through')}>{a.patientName}</span>
            </span>
            {h > 30 && <span className={cn('block truncate text-muted-foreground', cancelled && 'line-through')}>{timeOf(a.startsAt, tz)}</span>}
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
          <h3 className="px-4 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {dayTitle(date)}{clinic.holidays.includes(date) ? ', holiday' : ''}
          </h3>
          {items.length === 0 ? <p className="px-4 text-sm text-muted-foreground">Nothing booked.</p> : (
            <ul>
              {items.map((a) => {
                const Icon = a.bookedBy.kind === 'assistant' ? Bot : User;
                return (
                  <li key={a.id}>
                    <button type="button" onClick={() => onOpen(a.id)} className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
                      <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{timeOf(a.startsAt, tz)}</span>
                      <span className={cn('size-2 shrink-0 rounded-full', VISIT_DOTS[idx(a.visitTypeId) % VISIT_DOTS.length])} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate font-medium', a.status === 'cancelled' && 'line-through opacity-60')}>{a.patientName}</span>
                        <span className="block truncate text-xs text-muted-foreground">{visit(a.visitTypeId)}, {provider(a.providerId)}{a.status === 'cancelled' ? ', cancelled' : ''}</span>
                      </span>
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={a.bookedBy.kind === 'assistant' ? 'Booked by the assistant' : 'Booked by staff'} />
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
