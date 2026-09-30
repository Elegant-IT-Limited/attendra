// SPDX-License-Identifier: AGPL-3.0-only
import type { LiveEvent } from '@attendra/agent';

/** What staff can do to a live call, provided by the code running it. */
export interface LiveControl {
  /** `by` is the staff member's name, shown to everyone watching; null when the API did not send one. */
  coach(note: string, by: string | null): Promise<void>;
  takeOver(uri: string, by: string | null): Promise<void>;
  end(by: string | null): Promise<void>;
  /** False while the caller has not yet heard the emergency script. */
  canEnd(): boolean;
}

export interface LiveSummary {
  callId: string;
  channel: 'phone' | 'web';
  startedAt: string;
  /** "Maria D.", once the caller is verified. Patient data: the API passes it on only to roles that may read calls. */
  verified: string | null;
  doing: string | null;
  waitingForYes: boolean;
  emergency: boolean;
}

export interface Numbered { id: number; event: LiveEvent | { type: 'snapshot'; state: LiveSummary & { pending: string | null } } }

interface Entry {
  clinicId: string;
  summary: LiveSummary;
  pending: string | null;
  events: Numbered[];
  next: number;
  listeners: Set<(e: Numbered) => void>;
  control: LiveControl;
  /** The one staff action that ends the assistant's part: a take-over or an end. */
  claimed: { key: string; action: 'take_over' | 'end'; by: string } | null;
  coachKeys: Set<string>;
  ended: boolean;
}

export type ActionResult = { ok: true; repeat: boolean } | { ok: false; error: 'not_live' | 'already_taken' | 'web_call' | 'emergency_script'; by?: string };

/**
 * The calls this voice service is running now, and what has happened on each, for
 * staff watching from the dashboard. It lives in this process's memory: one voice
 * instance sees only its own calls, which is the deployment Attendra supports today
 * (docs/architecture.md has the path to several instances over Postgres
 * LISTEN/NOTIFY). Each call keeps a short replay buffer, so a watcher who reconnects
 * with Last-Event-ID misses nothing, and a finished call stays a minute so a
 * watcher still sees how it ended.
 */
export class LiveRegistry {
  private readonly calls = new Map<string, Entry>();

  constructor(private readonly buffer = 2000, private readonly lingerMs = 60_000) {}

  open(callId: string, meta: { clinicId: string; channel: 'phone' | 'web'; startedAt: Date }, control: LiveControl) {
    this.calls.set(callId, {
      clinicId: meta.clinicId, pending: null, events: [], next: 1, listeners: new Set(), control, claimed: null, coachKeys: new Set(), ended: false,
      summary: { callId, channel: meta.channel, startedAt: meta.startedAt.toISOString(), verified: null, doing: null, waitingForYes: false, emergency: false },
    });
  }

  publish(callId: string, event: LiveEvent) {
    const e = this.calls.get(callId);
    if (!e || e.ended) return;
    if (event.type === 'state') {
      e.summary.verified = event.verified;
      e.summary.doing = event.doing;
      e.summary.waitingForYes = !!event.pending;
      e.pending = event.pending;
    } else if (event.type === 'emergency') e.summary.emergency = true;
    // a take-over or an end that did not go through gives the call back: anyone may act again
    else if (event.type === 'staff' && (event.action === 'transfer_failed' || event.action === 'end_failed')) e.claimed = null;
    const numbered = { id: e.next++, event };
    e.events.push(numbered);
    if (e.events.length > this.buffer) e.events.splice(0, e.events.length - this.buffer);
    for (const l of e.listeners) l(numbered);
  }

  /** The call is over: the last event, then the call is forgotten after a short while. */
  end(callId: string, outcome: string) {
    const e = this.calls.get(callId);
    if (!e || e.ended) return;
    this.publish(callId, { type: 'ended', outcome });
    e.ended = true;
    const t = setTimeout(() => this.calls.delete(callId), this.lingerMs);
    t.unref?.();
  }

  /** A clinic's calls that are still going. */
  list(clinicId: string): LiveSummary[] {
    return [...this.calls.values()].filter((e) => e.clinicId === clinicId && !e.ended).map((e) => ({ ...e.summary }));
  }

  has(clinicId: string, callId: string) {
    return this.calls.get(callId)?.clinicId === clinicId;
  }

  /**
   * Everything a watcher needs: first where the call stands now, then the events
   * after `lastEventId` from the buffer, then each new event as it happens. Returns
   * null for a call this clinic does not have here.
   */
  subscribe(clinicId: string, callId: string, lastEventId: number | null, listener: (e: Numbered) => void): (() => void) | null {
    const e = this.calls.get(callId);
    if (!e || e.clinicId !== clinicId) return null;
    listener({ id: 0, event: { type: 'snapshot', state: { ...e.summary, pending: e.pending } } });
    for (const past of e.events) if (lastEventId === null || past.id > lastEventId) listener(past);
    if (e.ended) return () => {};
    e.listeners.add(listener);
    return () => e.listeners.delete(listener);
  }

  /** A staff note. The same key twice is one note. */
  async coach(clinicId: string, callId: string, key: string, note: string, by: string | null = null): Promise<ActionResult> {
    const e = this.live(clinicId, callId);
    if (!e) return { ok: false, error: 'not_live' };
    if (e.coachKeys.has(key)) return { ok: true, repeat: true };
    e.coachKeys.add(key);
    try {
      await e.control.coach(note, by);
    } catch (err) {
      // not sent: the same key sent again is a new try, not a repeat
      e.coachKeys.delete(key);
      throw err;
    }
    return { ok: true, repeat: false };
  }

  /**
   * A take-over or an end. Only one person gets the call: the first claim wins, the
   * same click sent twice is the same claim, and anyone else is told who has it.
   */
  async claim(clinicId: string, callId: string, key: string, by: string, action: 'take_over' | 'end', run: (control: LiveControl) => Promise<void>): Promise<ActionResult> {
    const e = this.live(clinicId, callId);
    if (!e) return { ok: false, error: 'not_live' };
    if (e.claimed) return e.claimed.key === key ? { ok: true, repeat: true } : { ok: false, error: 'already_taken', by: e.claimed.by };
    if (action === 'take_over' && e.summary.channel === 'web') return { ok: false, error: 'web_call' };
    if (action === 'end' && !e.control.canEnd()) return { ok: false, error: 'emergency_script' };
    const claim = { key, action, by };
    e.claimed = claim;
    try {
      await run(e.control);
    } catch (err) {
      // it did not happen: the call is free again, for this person or anyone else
      if (e.claimed === claim) e.claimed = null;
      throw err;
    }
    return { ok: true, repeat: false };
  }

  private live(clinicId: string, callId: string) {
    const e = this.calls.get(callId);
    return e && e.clinicId === clinicId && !e.ended ? e : null;
  }
}
