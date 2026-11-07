// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import type { Database } from './client';

/** What changed in a clinic, or for one person: the dashboard asks for that page again. Never a row, never patient data. */
export type ChangeTopic = 'requests' | 'schedule' | 'patients' | 'calls' | 'settings' | 'team' | 'knowledge' | 'texts' | 'live' | 'me';
/**
 * 'team': someone's role, a removal or an invitation at this location changed (migration 0046).
 * 'knowledge', 'texts': a document indexed, a text delivered (0048). 'live': a call started,
 * ended, or changed what it is doing (the voice service, notifyLive). 'me': this person's
 * own invitations or roles changed (0048), sent to the person, never to a clinic.
 */
export const CHANGE_TOPICS: readonly ChangeTopic[] = ['requests', 'schedule', 'patients', 'calls', 'settings', 'team', 'knowledge', 'texts', 'live', 'me'];
export const CHANGE_CHANNEL = 'attendra_changes';
/** How long notices are kept for a browser that reconnects with Last-Event-ID. */
export const REPLAY_MS = 60_000;
/** LISTEN down for longer than this is an alert: until it is back, no screen hears of a change. */
export const LISTEN_DOWN_ALERT_MS = 10_000;

/** Who a stream is for: its clinic (none on the start page and the profile) and its person. */
export interface ChangeScope { clinicId?: string | null; userId: string }
/**
 * A numbered notice. `topic: '*'` means "anything may have changed": notices were lost
 * (LISTEN was down), so every screen reads again.
 */
export interface Notice { seq: number; topic: ChangeTopic | '*' }
/** What a reconnecting stream missed: some topics, or everything ('*', when the gap cannot be told). */
export type Missed = ChangeTopic[] | '*';

/** The change notices of a clinic or a person, for as long as someone is subscribed. */
export interface ChangeFeed {
  subscribe(scope: ChangeScope, listener: (n: Notice) => void): () => void;
  /** The id of notice `seq` (the newest by default): a stream's messages carry it, so the browser has an id to come back with. */
  cursor(seq?: number): string;
  /** What `scope` missed after `lastEventId`; null when nothing was missed or the id is not one of ours (a first connection). */
  since(scope: ChangeScope, lastEventId: string | null): Missed | null;
  close(): Promise<void>;
}

const keysOf = (s: ChangeScope) => [...(s.clinicId ? [`c:${s.clinicId}`] : []), `u:${s.userId}`];

/**
 * Fans notices out to their clinic's and person's subscribers, numbering each, and keeps
 * the last minute of them so a browser that comes back with Last-Event-ID is told what
 * it missed instead of everything. Ids name this process (`boot`): after a restart, the
 * old ids mean nothing and the browser is told everything may have changed.
 */
export class Fanout {
  private readonly listeners = new Map<string, Set<(n: Notice) => void>>();
  private readonly boot = randomBytes(4).toString('hex');
  private seq = 0;
  /** The last REPLAY_MS of notices, oldest first; `pruned` is the newest seq that fell out. */
  private readonly log: { seq: number; at: number; key: string; topic: ChangeTopic | '*' }[] = [];
  private pruned = 0;

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(scope: ChangeScope, listener: (n: Notice) => void) {
    const keys = keysOf(scope);
    for (const k of keys) {
      const set = this.listeners.get(k) ?? new Set();
      set.add(listener);
      this.listeners.set(k, set);
    }
    return () => {
      for (const k of keys) {
        const set = this.listeners.get(k);
        set?.delete(listener);
        if (set && !set.size) this.listeners.delete(k);
      }
    };
  }

  cursor(seq = this.seq) { return `${this.boot}.${seq}`; }

  since(scope: ChangeScope, lastEventId: string | null): Missed | null {
    const m = /^([0-9a-f]{8})\.(\d+)$/.exec(lastEventId ?? '');
    if (!m) return null;
    const after = Number(m[2]);
    // another process's id, one from the future, or older than what is kept: the gap cannot be told
    if (m[1] !== this.boot || after > this.seq || after < this.pruned) return '*';
    this.prune();
    const keys = new Set(keysOf(scope));
    const topics = new Set<ChangeTopic | '*'>();
    for (const e of this.log) if (e.seq > after && (keys.has(e.key) || e.key === '*')) topics.add(e.topic);
    if (topics.has('*')) return '*';
    return topics.size ? [...topics] as ChangeTopic[] : null;
  }

  /** A notice from Postgres. One that does not parse is dropped. */
  deliver(payload: string | undefined) {
    try {
      const { clinic, user, topic } = JSON.parse(payload ?? '') as { clinic?: string; user?: string; topic?: ChangeTopic };
      if (!topic || !CHANGE_TOPICS.includes(topic)) return;
      // a person's notice is 'me' only, and 'me' is a person's only: a clinic never hears another person's changes
      if (user && topic === 'me') this.emit(`u:${user}`, topic);
      else if (clinic && topic !== 'me') this.emit(`c:${clinic}`, topic);
    } catch { /* not ours */ }
  }

  /** Notices may have been lost: every open stream reads everything again, and so does one that reconnects from before now. */
  lost() { this.emit('*', '*'); }

  private emit(key: string, topic: ChangeTopic | '*') {
    const seq = ++this.seq;
    this.log.push({ seq, at: this.now(), key, topic });
    this.prune();
    const n = { seq, topic };
    // a stream listens under its clinic and its person: told once
    if (key === '*') for (const l of new Set([...this.listeners.values()].flatMap((set) => [...set]))) l(n);
    else for (const l of this.listeners.get(key) ?? []) l(n);
  }

  private prune() {
    const cut = this.now() - REPLAY_MS;
    while (this.log.length && this.log[0]!.at < cut) this.pruned = this.log.shift()!.seq;
  }
}

/** When LISTEN goes down and comes back, for the alert: `ms` is how long it was down. */
export interface ListenWatch {
  onError?: (code: string) => void;
  /** Down longer than LISTEN_DOWN_ALERT_MS, said once per outage. */
  onDown?: () => void;
  /** Back after onDown was said. */
  onUp?: (ms: number) => void;
}

const feedOf = (fanout: Fanout, close: () => Promise<void>): ChangeFeed => ({
  subscribe: (scope, listener) => fanout.subscribe(scope, listener),
  cursor: (seq) => fanout.cursor(seq),
  since: (scope, id) => fanout.since(scope, id),
  close,
});

/**
 * Listens on one connection of its own, outside the pool (a pooled connection would
 * drop LISTEN when it is returned). If the connection drops it reconnects, waiting a
 * little longer each time up to 10 seconds; notices sent meanwhile are lost, so when it
 * is back every open screen is told to read again. Down for more than 10 seconds is an
 * alert, and back again is said too.
 */
export function pgChangeFeed(url: string, watch: ListenWatch | ((code: string) => void) = {}): ChangeFeed {
  const w: ListenWatch = typeof watch === 'function' ? { onError: watch } : watch;
  const fanout = new Fanout();
  let client: Client | null = null;
  let closed = false;
  let wait = 500;
  let downAt: number | null = null;
  let alerted = false;
  let alarm: NodeJS.Timeout | null = null;
  const down = () => {
    if (downAt !== null || closed) return;
    downAt = Date.now();
    alarm = setTimeout(() => { alarm = null; if (downAt !== null && !closed) { alerted = true; w.onDown?.(); } }, LISTEN_DOWN_ALERT_MS);
    alarm.unref?.();
  };
  const up = () => {
    if (alarm) { clearTimeout(alarm); alarm = null; }
    if (downAt === null) return;
    const ms = Date.now() - downAt;
    downAt = null;
    fanout.lost();
    if (alerted) { alerted = false; w.onUp?.(ms); }
  };
  // the connection being tried or used now: a late 'end' from an older one changes nothing
  let current: Client | null = null;
  const retry = (c: Client) => {
    if (closed || current !== c) return;
    current = null;
    client = null;
    down();
    setTimeout(() => void connect(), wait);
    wait = Math.min(wait * 2, 10_000);
  };
  const connect = async () => {
    if (closed) return;
    const c = new Client({ connectionString: url });
    current = c;
    c.on('notification', (n) => { if (n.channel === CHANGE_CHANNEL) fanout.deliver(n.payload); });
    c.on('error', (err: Error & { code?: string }) => { w.onError?.(err.code ?? 'unknown'); });
    c.on('end', () => retry(c));
    try {
      await c.connect();
      await c.query(`listen ${CHANGE_CHANNEL}`);
      if (current !== c) { await c.end().catch(() => {}); return; }
      client = c;
      wait = 500;
      up();
    } catch (err) {
      w.onError?.((err as { code?: string }).code ?? 'unknown');
      // 'end' does not always follow a failed connect: retry() runs once whichever comes first
      retry(c);
      await c.end().catch(() => {});
    }
  };
  void connect();
  return feedOf(fanout, async () => { closed = true; if (alarm) clearTimeout(alarm); await client?.end().catch(() => {}); });
}

/** The same, on an in-process PGlite: the local demo and the tests. */
export async function pgliteChangeFeed(pglite: { listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>> }, now?: () => number): Promise<ChangeFeed & { fanout: Fanout }> {
  const fanout = new Fanout(now);
  const stop = await pglite.listen(CHANGE_CHANNEL, (payload) => fanout.deliver(payload));
  return { ...feedOf(fanout, () => stop()), fanout };
}

/**
 * A notice sent from code rather than a trigger, for what lives outside the database:
 * the voice service's live calls ('live'). Words only, like every notice.
 */
export async function notifyChange(db: Database, clinicId: string, topic: Exclude<ChangeTopic, 'me'>): Promise<void> {
  await db.execute(sql`select pg_notify(${CHANGE_CHANNEL}, ${JSON.stringify({ clinic: clinicId, topic })})`);
}

/**
 * At most one notice per clinic and topic per `ms`, the last one always sent: a call
 * that steps through five tools in a second is one notice, and its final state is never
 * left out. Failures are logged by `onError`, never thrown at the caller.
 */
export function throttledNotify(db: Database, ms = 500, onError: (err: unknown) => void = () => {}) {
  const due = new Map<string, NodeJS.Timeout>();
  return (clinicId: string, topic: Exclude<ChangeTopic, 'me'>) => {
    const key = `${clinicId}|${topic}`;
    if (due.has(key)) return;
    const t = setTimeout(() => { due.delete(key); void notifyChange(db, clinicId, topic).catch(onError); }, ms);
    t.unref?.();
    due.set(key, t);
  };
}
