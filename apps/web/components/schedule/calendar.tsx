// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Appointment } from '@attendra/api/contracts';
import { bufferOf, type ClinicConfig, localParts, providerName, toMinutes } from '@attendra/core';
import { Bot, Check, User } from 'lucide-react';
import type { CSSProperties } from 'react';
import { MarkedIcon, markedWords } from '@/components/schedule/visit-status';
import { Empty } from '@/components/ui/feedback';
import { Popover } from '@/components/ui/overlay';
import { dayTitle, hourMark, timeOf, VISIT_DOTS, VISIT_TAILS, VISIT_TONES, visitTypeName, weekdayHeads } from '@/lib/format';
import { blockHeight, clinicHoursFor, closedDay, columnsThatFit, hoursFor, initials, MIN_BLOCK, outsideDesk, placeLane, PX } from '@/lib/schedule-lanes';
import { RENDER_MARKS, useRenderMark } from '@/lib/render-mark';
import { cn } from '@/lib/utils';

/** A day lane is never narrower than this, so its name stays readable; past the card's width the grid scrolls sideways. */
const LANE_MIN_REM = 7;
/**
 * A lane in the week view: two visits side by side at 24px or more each (columnsThatFit). A third at the same time
 * would be narrower than a target anyone can tap, so a busier moment shows one visit and "+N more" (placeLane).
 */
const WEEK_LANE_MIN_REM = 5;
const REM_PX = 16;
type Provider = ClinicConfig['providers'][number];

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
  // Every lane keeps a readable minimum and the grid scrolls inside the card, both ways, instead of squeezing lanes to
  // nothing: a day's lane is 7rem, a week's lane 5rem (two visits side by side stay 24px targets, a third goes in "+N more"), so a week is
  // days × vets lanes wide. Headings stay at the top and the hour column on the left while it scrolls.
  const laneRem = week ? WEEK_LANE_MIN_REM : LANE_MIN_REM;
  const columns = `3.5rem repeat(${week ? dates.length : providers.length}, minmax(${week ? `${providers.length * laneRem}rem` : `${laneRem}rem`}, 1fr))`;
  const minWidth = `max(640px, calc(3.5rem + ${(week ? dates.length : 1) * providers.length * laneRem}rem))`;
  // the grid's own render time, for the render-speed test (e2e/schedule-scale.spec.ts) and the browser's performance panel
  useRenderMark(RENDER_MARKS.grid, providers.length > 0);

  return (
    // one scroller for both directions, so the sticky headings and hour column hold; a focusable region for the keyboard
    <div role="region" aria-label={week ? 'Week schedule' : 'Day schedule'} tabIndex={0} data-testid="schedule-scroller"
      className="max-h-[calc(100dvh-13rem)] min-h-80 overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary">
      <div style={{ minWidth }}>
        {/* column headings; the hour column stays put while the grid scrolls sideways */}
        <div className="sticky top-0 z-30 grid border-b border-border bg-surface" style={{ gridTemplateColumns: columns }}>
          <div className="sticky left-0 z-10 bg-surface" />
          {week ? dates.map((d) => {
            const holiday = closedDay(clinic, d);
            return (
              <div key={d} className={cn('border-l border-border px-2 py-2 text-sm', d === today && 'bg-primary-soft')}>
                <p className={cn('font-medium', d === today && 'text-primary')}>{dayTitle(d, 'short')}</p>
                <div className="mt-1 flex gap-1 text-xs text-text-muted">
                  {holiday ? <span>{holiday === 'Holiday' ? 'Holiday, closed' : holiday}</span> : providers.map((p) => <span key={p.id} className="flex-1 truncate" title={providerName(p)}><abbr title={providerName(p)} className="no-underline">{shortName(providerName(p))}</abbr></span>)}
                </div>
              </div>
            );
          }) : providers.map((p) => (
            // the whole name while the lane has room for it; initials and the surname when it is narrow. The full name is on hover either way
            <div key={p.id} data-testid="lane-head" title={providerName(p)} className="@container min-w-0 border-l border-border px-3 py-2.5 text-sm font-medium">
              <span className="block truncate @max-[9rem]:hidden">{providerName(p)}</span>
              <span className="hidden items-center gap-1.5 @max-[9rem]:flex">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs tabular-nums" aria-hidden>{initials(p.name)}</span>
                <span className="truncate">{shortName(providerName(p))}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="relative grid" style={{ gridTemplateColumns: columns, height }}>
          {/* hour labels and lines */}
          <div className="sticky left-0 z-[25] bg-surface">
            {hours.map((h) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 whitespace-nowrap text-xs tabular-nums text-text-muted" style={{ top: (h - start) * PX }}>
                {h === start ? '' : hourMark(h)}
              </span>
            ))}
          </div>
          {hours.slice(1).map((h) => <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/70" style={{ top: (h - start) * PX, left: '3.5rem' }} />)}
          {(week ? dates : [dates[0]!]).map((date) => (
            <div key={date} className="relative border-l border-border"
              style={week ? { gridTemplateColumns: `repeat(${providers.length}, minmax(${WEEK_LANE_MIN_REM}rem, 1fr))`, display: 'grid' } : { display: 'contents' }}>
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
  // the vet's bookable hours, by the rule every booking follows: their own decide, even while the clinic is closed
  const open = hoursFor(clinic, provider, date).map((w) => [toMinutes(w.open), toMinutes(w.close)] as const);
  const desk = clinicHoursFor(clinic, provider, date).map((w) => [toMinutes(w.open), toMinutes(w.close)] as const);
  // closed stretches between the opening windows, shaded
  const closed: [number, number][] = [];
  let cursor = start;
  for (const [o, c] of open) { if (o > cursor) closed.push([cursor, o]); cursor = Math.max(cursor, c); }
  if (cursor < end) closed.push([cursor, end]);
  // bookable time while the front desk is closed: drawn open, with a band that says so
  const deskClosed = outsideDesk(open, desk);
  // side by side only as many as stay 24-pixel targets at the lane's least width; a busier moment gets "+N more"
  const laid = placeLane(appointments, (a) => [minutesOf(a.startsAt, tz), minutesOf(a.endsAt, tz)], columnsThatFit((divided ? WEEK_LANE_MIN_REM : LANE_MIN_REM) * REM_PX));

  return (
    <div className={cn('relative', !divided ? 'border-l border-border' : 'border-l border-border/40 first:border-l-0')} data-testid="lane" role="group" aria-label={`${providerName(provider)}, ${dayTitle(date)}`}>
      {closed.map(([s, e]) => (
        <div key={s} className="absolute inset-x-0 bg-[repeating-linear-gradient(135deg,var(--muted),var(--muted)_6px,transparent_6px,transparent_12px)] opacity-80"
          style={{ top: (s - start) * PX, height: (e - s) * PX }} aria-hidden />
      ))}
      {deskClosed.map(([s, e]) => (
        <div key={`desk-${s}`} data-testid="desk-closed" title="Front desk closed: bookable by this vet's own hours"
          className="absolute inset-x-0 border-l-2 border-dashed border-border-strong bg-surface-sunken/60" style={{ top: (s - start) * PX, height: (e - s) * PX }} aria-hidden />
      ))}
      {holiday && !open.length && <p className="absolute inset-x-0 top-3 text-center text-xs font-medium text-text-muted">{holiday}</p>}
      {nowMin !== null && nowMin >= start && nowMin <= end && (
        <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: (nowMin - start) * PX }} aria-hidden />
      )}
      {laid.blocks.map(({ item: a, column, columns }) => {
        const s = minutesOf(a.startsAt, tz);
        const e = minutesOf(a.endsAt, tz);
        const cancelled = a.status === 'cancelled';
        const buffer = cancelled ? 0 : bufferOf(clinic.visitTypes, a.visitTypeId);
        if (!buffer) return null;
        // the minutes its visit type keeps free after it (cleaning time), drawn lighter under the visit's own block;
        // protected by the database as well as the slot search (migration 0053)
        const top = Math.max((s - start) * PX + 1 + blockHeight(s, e), (e - start) * PX);
        return (
          <div key={`tail-${a.id}`} data-testid="visit-buffer" role="img" aria-label={`${buffer} minutes kept free after ${a.patientName}`} title={`${buffer} minutes kept free after this visit`}
            className={cn('absolute z-[5] rounded-b-md border-l-4 border-dashed opacity-80', VISIT_TAILS[visitIndex(a.visitTypeId) % VISIT_TAILS.length])}
            style={{ top, height: Math.max(2, (e + buffer - start) * PX - top - 1), left: `calc(${(column / columns) * 100}% + 0.125rem)`, width: `calc(${100 / columns}% - 0.25rem)` }} />
        );
      })}
      {laid.blocks.map(({ item: a, column, columns }) => {
        const s = minutesOf(a.startsAt, tz);
        const e = minutesOf(a.endsAt, tz);
        const cancelled = a.status === 'cancelled';
        const Icon = a.bookedBy.kind === 'assistant' ? Bot : User;
        const h = blockHeight(s, e);
        // two lines of text need 36 pixels with their padding: a 20-minute visit (33) keeps one, with the time on it
        const twoLines = h >= 36;
        return (
          <button key={a.id} type="button" onClick={() => onOpen(a.id)} data-testid="appointment"
            aria-label={`${timeOf(a.startsAt, tz)}, ${a.patientName}, ${clinic.visitTypes.find((v) => v.id === a.visitTypeId)?.name ?? ''}${cancelled ? ', cancelled' : ''}${markedWords(a.status)}${a.confirmedAt && !cancelled ? ', confirmed' : ''}, booked by ${a.bookedBy.kind === 'assistant' ? 'the assistant' : 'staff'}`}
            className={cn('absolute z-10 overflow-hidden rounded-md border border-border/60 border-l-4 px-1.5 text-left text-xs leading-tight shadow-xs transition hover:z-20 hover:shadow-md focus-visible:z-20 focus-ring',
              VISIT_TONES[visitIndex(a.visitTypeId) % VISIT_TONES.length],
              cancelled && 'border-dashed text-text-muted', a.status === 'no_show' && 'opacity-60')}
            // visits drawn at the same height share the lane, side by side: nothing is ever under anything
            style={{ top: (s - start) * PX + 1, height: h, left: `calc(${(column / columns) * 100}% + 0.125rem)`, width: `calc(${100 / columns}% - 0.25rem)` }}>
            <span className={cn('flex items-center gap-1', twoLines ? 'pt-1' : 'pt-0.5')}>
              <Icon className="size-3 shrink-0 text-text-muted" aria-hidden />
              {/* too short for a second line: the time goes on the first, and both truncate together */}
              <span className={cn('truncate font-medium', cancelled && 'line-through')}>
                <MarkedIcon status={a.status} className="mr-0.5" />
                {a.confirmedAt && !cancelled && <Check className="mr-0.5 inline size-3 text-success" aria-hidden />}
                {a.patientName}{twoLines ? '' : <span className="font-normal text-text-muted"> · {timeOf(a.startsAt, tz)}</span>}
              </span>
            </span>
            {twoLines && <span className={cn('block truncate text-text-muted', cancelled && 'line-through')}>{timeOf(a.startsAt, tz)}</span>}
          </button>
        );
      })}
      {laid.more.map((m) => (
        <MoreVisits key={`more-${m.items[0]!.id}`} clinic={clinic} items={m.items} onOpen={onOpen}
          style={{ top: (m.start - start) * PX + 1, height: Math.max(MIN_BLOCK, (m.end - m.start) * PX - 2), left: `calc(${(m.column / m.columns) * 100}% + 0.125rem)`, width: `calc(${100 / m.columns}% - 0.25rem)` }} />
      ))}
    </div>
  );
}

/**
 * The visits of a busy moment that do not fit side by side as 24-pixel targets: one "+N more" target that lists them,
 * each opening its panel. A button, so the keyboard reaches it like any visit; the list closes with Escape.
 */
function MoreVisits({ clinic, items, onOpen, style }: { clinic: ClinicConfig; items: Appointment[]; onOpen: (id: string) => void; style: CSSProperties }) {
  const tz = clinic.timezone;
  const visit = (id: string) => visitTypeName(clinic.visitTypes.find((v) => v.id === id)?.name ?? '');
  return (
    <Popover className="w-64 p-1" trigger={
      <button type="button" data-testid="more-visits" style={style}
        aria-label={`${items.length} more ${items.length === 1 ? 'visit' : 'visits'} from ${timeOf(items[0]!.startsAt, tz)}: ${items.map((a) => a.patientName).join(', ')}`}
        className="absolute z-10 flex items-start justify-center overflow-hidden rounded-md border border-border-strong bg-surface-sunken px-0.5 pt-0.5 text-xs font-medium text-text shadow-xs transition hover:z-20 hover:shadow-md focus-visible:z-20 focus-ring">
        +{items.length}
      </button>
    }>
      <ul aria-label="More visits" data-testid="more-visits-list">
        {items.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => onOpen(a.id)} data-testid="appointment"
              className="focus-ring flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-sunken">
              <span className="shrink-0 tabular-nums text-text-muted">{timeOf(a.startsAt, tz)}</span>
              <span className={cn('min-w-0 flex-1 truncate', a.status === 'cancelled' && 'line-through text-text-muted')}>{a.patientName}</span>
              <span className="sr-only">, {visit(a.visitTypeId)}{a.status === 'cancelled' ? ', cancelled' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/** The same appointments as a list, for a phone: the grid does not fit in 390 pixels. */
export function ScheduleList({ clinic, dates, appointments, onOpen }: { clinic: ClinicConfig; dates: string[]; appointments: Appointment[]; onOpen: (id: string) => void }) {
  const tz = clinic.timezone;
  const provider = (id: string) => { const p = clinic.providers.find((x) => x.id === id); return p ? providerName(p) : id; };
  const visit = (id: string) => visitTypeName(clinic.visitTypes.find((v) => v.id === id)?.name ?? id);
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
                        <span className="block truncate text-xs text-text-muted">{visit(a.visitTypeId)}, {provider(a.providerId)}{a.status === 'cancelled' ? ', cancelled' : markedWords(a.status)}</span>
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
    <div role="region" aria-label="Month schedule" tabIndex={0} className="max-h-[calc(100dvh-13rem)] overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary">
      <div className="min-w-[640px]" role="grid" aria-label="Month">
        <div className="grid grid-cols-7 border-b border-border text-xs font-medium text-text-muted" role="row">
          {weekdayHeads().map((d) => <div key={d} role="columnheader" className="px-2 py-2">{d}</div>)}
        </div>
        {/* a row per week, so the grid reads as one to a screen reader */}
        {Array.from({ length: Math.ceil(dates.length / 7) }, (_, w) => dates.slice(w * 7, w * 7 + 7)).map((week) => (
        <div key={week[0]} role="row" className="grid grid-cols-7">
          {week.map((d) => {
            const items = byDate.get(d) ?? [];
            const other = !d.startsWith(month);
            const closed = closedDay(clinic, d);
            return (
              <div key={d} role="gridcell" data-testid="month-day" aria-label={`${dayTitle(d)}, ${items.length} booked`}
                className={cn('min-h-28 border-b border-l border-border p-1.5 first:border-l-0', other && 'bg-surface-sunken/50', d === today && 'bg-primary-soft/40')}>
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
                        <MarkedIcon status={a.status} />
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
        ))}
      </div>
    </div>
  );
}
