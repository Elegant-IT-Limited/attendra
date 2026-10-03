// SPDX-License-Identifier: AGPL-3.0-only
import { Client } from 'pg';

/** What changed in a clinic: the dashboard asks for that page again. Never a row, never patient data. */
export type ChangeTopic = 'requests' | 'schedule' | 'patients' | 'calls' | 'settings';
export const CHANGE_TOPICS: readonly ChangeTopic[] = ['requests', 'schedule', 'patients', 'calls', 'settings'];
export const CHANGE_CHANNEL = 'attendra_changes';

/** One clinic's change notices, for as long as someone is subscribed. */
export interface ChangeFeed {
  subscribe(clinicId: string, listener: (topic: ChangeTopic) => void): () => void;
  close(): Promise<void>;
}

/** Fans notices out to the subscribers of their clinic. A notice that does not parse is dropped. */
class Fanout {
  private readonly listeners = new Map<string, Set<(topic: ChangeTopic) => void>>();
  subscribe(clinicId: string, listener: (topic: ChangeTopic) => void) {
    const set = this.listeners.get(clinicId) ?? new Set();
    set.add(listener);
    this.listeners.set(clinicId, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(clinicId); };
  }
  deliver(payload: string | undefined) {
    try {
      const { clinic, topic } = JSON.parse(payload ?? '') as { clinic?: string; topic?: ChangeTopic };
      if (!clinic || !topic || !CHANGE_TOPICS.includes(topic)) return;
      for (const l of this.listeners.get(clinic) ?? []) l(topic);
    } catch { /* not ours */ }
  }
}

/**
 * Listens on one connection of its own, outside the pool (a pooled connection would
 * drop LISTEN when it is returned). If the connection drops it reconnects, waiting
 * a little longer each time up to 30 seconds; the dashboard keeps working meanwhile
 * and catches up on its next refresh.
 */
export function pgChangeFeed(url: string, onError: (code: string) => void = () => {}): ChangeFeed {
  const fanout = new Fanout();
  let client: Client | null = null;
  let closed = false;
  let wait = 1000;
  const connect = async () => {
    if (closed) return;
    const c = new Client({ connectionString: url });
    c.on('notification', (n) => { if (n.channel === CHANGE_CHANNEL) fanout.deliver(n.payload); });
    c.on('error', (err: Error & { code?: string }) => { onError(err.code ?? 'unknown'); });
    c.on('end', () => { client = null; if (!closed) setTimeout(connect, wait = Math.min(wait * 2, 30_000)); });
    try {
      await c.connect();
      await c.query(`listen ${CHANGE_CHANNEL}`);
      client = c;
      wait = 1000;
    } catch (err) {
      onError((err as { code?: string }).code ?? 'unknown');
      await c.end().catch(() => {});
    }
  };
  void connect();
  return {
    subscribe: (clinicId, listener) => fanout.subscribe(clinicId, listener),
    close: async () => { closed = true; await client?.end().catch(() => {}); },
  };
}

/** The same, on an in-process PGlite: the local demo and the tests. */
export async function pgliteChangeFeed(pglite: { listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>> }): Promise<ChangeFeed> {
  const fanout = new Fanout();
  const stop = await pglite.listen(CHANGE_CHANNEL, (payload) => fanout.deliver(payload));
  return { subscribe: (clinicId, listener) => fanout.subscribe(clinicId, listener), close: () => stop() };
}
