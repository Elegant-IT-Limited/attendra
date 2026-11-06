// SPDX-License-Identifier: AGPL-3.0-only
import type { PatientDirectory, SchedulerAdapter } from '@attendra/core';
import type { Backend } from '../tools';

/** How long what was read stays good on a call: a booking by the desk meanwhile shows up within this, and `book` re-checks anyway. */
export const CACHE_TTL_MS = 60_000;
/**
 * How far ahead the schedule is read at the start of the call: the window lookups answer from. find_slots looks up to 60
 * days past a day the caller names (14 with none), so 90 covers a named day up to a month out; a lookup past it reads the
 * database as before. One query at the start of the call, for every provider.
 */
export const PRELOAD_DAYS = 90;

type Busy = Awaited<ReturnType<SchedulerAdapter['busy']>>;
interface Held<T> { value: Promise<T>; at: number }

/**
 * One call's reads, kept for the call (batch 1a, the preload): the clinic's schedule for the next two weeks, read once
 * as the call starts, and the household's pets and visits once the number is confirmed. Every lookup the tools make
 * answers from here when it can (under 100 ms instead of a database round trip each time), and from the database
 * when it can't. Nothing is ever written through it: a booking goes to the database, whose exclusion constraint is the
 * last guard, and drops what was held, so the next lookup reads afresh. Held in memory for the call only; never logged.
 */
export class CallCache {
  private busy: { providerIds: Set<string>; from: number; to: number; held: Held<Busy> } | null = null;
  private readonly byKey = new Map<string, Held<unknown>>();
  /** Reads answered from what was held, and reads that went to the database: for the call's log line. */
  hits = 0;
  misses = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private fresh<T>(h: Held<T> | undefined | null): h is Held<T> { return !!h && this.now() - h.at < CACHE_TTL_MS; }

  /** The clinic's schedule from `from` for PRELOAD_DAYS, for these providers: read now, used by every lookup after. */
  warmSchedule(scheduler: SchedulerAdapter, clinicId: string, providerIds: string[], from: Date) {
    if (!providerIds.length) return;
    const to = new Date(from.getTime() + PRELOAD_DAYS * 86_400_000);
    const value = scheduler.busy(clinicId, providerIds, from, to);
    // a failed read is dropped, never held: the next lookup goes to the database
    value.catch(() => { if (this.busy?.held.value === value) this.busy = null; });
    this.busy = { providerIds: new Set(providerIds), from: from.getTime(), to: to.getTime(), held: { value, at: this.now() } };
  }

  /** Whatever a write may have changed: the schedule and the household's visits are read afresh. */
  dropSchedule() {
    this.busy = null;
    for (const k of [...this.byKey.keys()]) if (k.startsWith('upcoming|') || k.startsWith('history|')) this.byKey.delete(k);
  }

  async scheduleBusy(scheduler: SchedulerAdapter, clinicId: string, providerIds: string[], from: Date, to: Date): Promise<Busy> {
    const b = this.busy;
    if (b && this.fresh(b.held) && from.getTime() >= b.from && to.getTime() <= b.to && providerIds.every((p) => b.providerIds.has(p))) {
      this.hits++;
      const wanted = new Set(providerIds);
      return (await b.held.value).filter((r) => wanted.has(r.providerId) && r.start.getTime() < to.getTime() && r.end.getTime() > from.getTime());
    }
    this.misses++;
    return scheduler.busy(clinicId, providerIds, from, to);
  }

  /** A read by its key: held for the call (TTL), so the same question twice is one database read. */
  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const h = this.byKey.get(key) as Held<T> | undefined;
    if (this.fresh(h)) { this.hits++; return h.value; }
    this.misses++;
    const value = load();
    value.catch(() => { if (this.byKey.get(key)?.value === value) this.byKey.delete(key); });
    this.byKey.set(key, { value, at: this.now() });
    return value;
  }
}

/**
 * The call's backend, reading through its cache: the schedule, a patient's visits and the household on a number.
 * Writes (book, cancel) go straight through and drop what the cache held. Everything else is the backend as it is.
 */
export function cachedBackend(backend: Backend, cache: CallCache): Backend {
  const s = backend.scheduler;
  const scheduler: SchedulerAdapter = {
    busy: (clinicId, providerIds, from, to) => cache.scheduleBusy(s, clinicId, providerIds, from, to),
    book: async (clinicId, input) => { try { return await s.book(clinicId, input); } finally { cache.dropSchedule(); } },
    cancel: async (clinicId, input) => { try { return await s.cancel(clinicId, input); } finally { cache.dropSchedule(); } },
    upcoming: (clinicId, patientId, now) => cache.read(`upcoming|${clinicId}|${patientId}`, () => s.upcoming(clinicId, patientId, now)),
    ...(s.history ? { history: (clinicId: string, patientId: string, now: Date) => cache.read(`history|${clinicId}|${patientId}`, () => s.history!(clinicId, patientId, now)) } : {}),
  };
  const p = backend.patients;
  // the household on a number and the pets on it: read once per number on the call. A pet's own lookup is never held:
  // it counts tries and is audited each time
  const patients: PatientDirectory = Object.assign(Object.create(Object.getPrototypeOf(p)) as PatientDirectory, p, {
    ...(p.householdOnNumber ? { householdOnNumber: (clinicId: string, phone: string, callId: string) => cache.read(`household|${clinicId}|${phone.replace(/\D/g, '').slice(-10)}`, () => p.householdOnNumber!.call(p, clinicId, phone, callId)) } : {}),
    ...(p.petsOnNumber ? { petsOnNumber: (clinicId: string, phone: string, callId: string) => cache.read(`pets|${clinicId}|${phone.replace(/\D/g, '').slice(-10)}`, () => p.petsOnNumber!.call(p, clinicId, phone, callId)) } : {}),
  });
  return { ...backend, scheduler, patients };
}

/** After the pet is found: its visits are read ahead, while the caller is still talking, so the next lookup is instant. */
export function warmPatient(backend: Backend, clinicId: string, patientId: string, now: Date) {
  void backend.scheduler.upcoming(clinicId, patientId, now).catch(() => undefined);
  void backend.scheduler.history?.(clinicId, patientId, now).catch(() => undefined);
}
