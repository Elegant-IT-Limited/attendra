// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Appointment } from '@attendra/api/contracts';
import { type ClinicConfig, localParts, managedList, providerName, shownProviders } from '@attendra/core';
import { Bot, Check, User } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { MarkedBadge, markedWords } from '@/components/schedule/visit-status';
import { Empty } from '@/components/ui/feedback';
import { Label, Select } from '@/components/ui/input';
import { dayTitle, timeOf, VISIT_DOTS } from '@/lib/format';
import { closedDay } from '@/lib/schedule-lanes';
import { cn } from '@/lib/utils';
import { RENDER_MARKS, useRenderMark } from '@/lib/render-mark';

/** Every row, a day's heading included, is this tall: the list draws only the rows in view. */
const ROW = 44;
/** The list's own height; past it the rows scroll inside it. */
const HEIGHT = 560;
/** Rows drawn past each edge of the view, so a scroll never shows a gap. */
const OVERSCAN = 8;

type Row = { kind: 'day'; date: string } | { kind: 'visit'; a: Appointment };

/**
 * The day (or the week) as one list in time order: a row per visit with the time, who it
 * is with, who it is for, the visit type, its status and who booked it. Narrowed by
 * provider, specialty or visit type, from the clinic's own lists. Three hundred rows are
 * nothing to it: only the rows in view are drawn.
 */
export function Agenda({ clinic, dates, appointments, onOpen, word }: {
  clinic: ClinicConfig;
  dates: string[];
  appointments: Appointment[];
  onOpen: (id: string) => void;
  /** "veterinarian" or "provider". */
  word: string;
}) {
  const id = useId();
  const tz = clinic.timezone;
  const [providerId, setProviderId] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [visitTypeId, setVisitTypeId] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const providers = shownProviders(clinic.providers, appointments.map((a) => a.providerId));
  const specialties = managedList(clinic, 'specialties');
  const providerOf = (pid: string) => clinic.providers.find((p) => p.id === pid);
  const visitOf = (vid: string) => clinic.visitTypes.find((v) => v.id === vid);
  const dot = (vid: string) => VISIT_DOTS[Math.max(0, clinic.visitTypes.findIndex((v) => v.id === vid)) % VISIT_DOTS.length];

  const rows = useMemo<Row[]>(() => {
    const kept = appointments.filter((a) => (!providerId || a.providerId === providerId)
      && (!specialty || (providerOf(a.providerId)?.specialty ?? '').toLowerCase() === specialty.toLowerCase())
      && (!visitTypeId || a.visitTypeId === visitTypeId))
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    if (dates.length === 1) return kept.map((a) => ({ kind: 'visit', a }));
    // a week: each day under its own heading, days with nothing on them left out
    const byDate = new Map<string, Appointment[]>();
    for (const a of kept) {
      const d = localParts(new Date(a.startsAt), tz).date;
      byDate.set(d, [...(byDate.get(d) ?? []), a]);
    }
    return dates.flatMap((d) => (byDate.get(d) ?? []).length ? [{ kind: 'day', date: d } as Row, ...byDate.get(d)!.map((a) => ({ kind: 'visit', a } as Row))] : []);
  }, [appointments, dates, providerId, specialty, visitTypeId, tz, clinic]);

  const visits = rows.filter((r) => r.kind === 'visit').length;
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + HEIGHT) / ROW) + OVERSCAN);
  const narrowed = !!(providerId || specialty || visitTypeId);

  useRenderMark(RENDER_MARKS.agenda, rows.length > 0);
  return (
    <div data-testid="agenda">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3" data-toolbar="agenda">
        <div className="w-64 space-y-1">
          <Label htmlFor={`${id}-provider`} className="sr-only">{word.charAt(0).toUpperCase()}{word.slice(1)}</Label>
          <Combobox id={`${id}-provider`} label={`${word.charAt(0).toUpperCase()}${word.slice(1)}`} value={providerId} onChange={setProviderId} placeholder={`Every ${word}`}
            options={providers.map((p) => ({ value: p.id, label: providerName(p) }))} />
        </div>
        {specialties.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-specialty`} className="sr-only">Specialty</Label>
            <Select id={`${id}-specialty`} className="h-9 w-48" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
              <option value="">Every specialty</option>
              {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor={`${id}-visit`} className="sr-only">Visit type</Label>
          <Select id={`${id}-visit`} className="h-9 w-52" value={visitTypeId} onChange={(e) => setVisitTypeId(e.target.value)}>
            <option value="">Every visit type</option>
            {clinic.visitTypes.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
        </div>
        <p className="text-xs text-text-muted tabular-nums" aria-live="polite">{visits} {visits === 1 ? 'visit' : 'visits'}{narrowed ? ' match' : ''}</p>
      </div>
      {!rows.length ? (
        narrowed ? <Empty title="Nothing matches">No visit fits these filters. Clear one to see more.</Empty> : <Empty title="Nothing booked here">No visits on {dates.length === 1 ? 'this day' : 'these days'}.</Empty>
      ) : (
        <div ref={scroller} className="overflow-y-auto" style={{ maxHeight: HEIGHT }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          {/* a list as tall as every row, with only the rows in view inside it */}
          <ul className="relative" style={{ height: rows.length * ROW }} aria-label="Agenda" data-testid="agenda-list">
            {rows.slice(first, last).map((r, i) => {
              const top = (first + i) * ROW;
              if (r.kind === 'day') {
                const closed = closedDay(clinic, r.date);
                return (
                  <li key={r.date} className="absolute inset-x-0 flex items-end bg-surface-sunken/60 px-4 pb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted" style={{ top, height: ROW }}>
                    {dayTitle(r.date)}{closed ? `, ${closed.toLowerCase()}` : ''}
                  </li>
                );
              }
              const { a } = r;
              const cancelled = a.status === 'cancelled';
              const confirmed = !cancelled && !!a.confirmedAt;
              const Icon = a.bookedBy.kind === 'assistant' ? Bot : User;
              const visit = visitOf(a.visitTypeId)?.name ?? '';
              const who = (() => { const p = providerOf(a.providerId); return p ? providerName(p) : a.providerId; })();
              return (
                <li key={a.id} className="absolute inset-x-0 border-b border-border/70" style={{ top, height: ROW }}>
                  <button type="button" onClick={() => onOpen(a.id)} data-testid="agenda-row"
                    aria-label={`${timeOf(a.startsAt, tz)}, ${a.patientName}, ${visit}, with ${who}${cancelled ? ', cancelled' : markedWords(a.status) || (confirmed ? ', confirmed' : '')}, booked by ${a.bookedBy.kind === 'assistant' ? 'the assistant' : 'staff'}`}
                    className="flex h-full w-full items-center gap-3 px-4 text-left text-sm hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none">
                    <span className="w-16 shrink-0 tabular-nums text-text-muted">{timeOf(a.startsAt, tz)}</span>
                    <span className="w-40 shrink-0 truncate text-text-muted" title={who}>{who}</span>
                    <span className={cn('min-w-0 flex-1 truncate font-medium', cancelled && 'line-through text-text-muted')}>{a.patientName}</span>
                    <span className="flex w-44 shrink-0 items-center gap-1.5 truncate text-text-muted">
                      <span className={cn('size-2 shrink-0 rounded-full', dot(a.visitTypeId))} aria-hidden />
                      <span className="truncate">{visit}</span>
                    </span>
                    <span className="w-24 shrink-0">
                      {cancelled ? <Badge tone="neutral">Cancelled</Badge> : a.status !== 'booked' ? <MarkedBadge status={a.status} /> : confirmed ? <Badge tone="ok"><Check className="size-3" aria-hidden /> Confirmed</Badge> : <Badge tone="accent">Booked</Badge>}
                    </span>
                    <Icon className="size-3.5 shrink-0 text-text-muted" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
