// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamRecord } from './report';

/** Splits what a stream sent into whole events: the blocks before the last blank line, and what is left over. */
export function splitEvents(buffer: string): { events: { event: string | null; id: string | null; retry: number | null }[]; rest: string } {
  const events: { event: string | null; id: string | null; retry: number | null }[] = [];
  let rest = buffer;
  let cut: number;
  while ((cut = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    events.push({
      event: /^event: (.*)$/m.exec(block)?.[1] ?? null,
      id: /^id: (.*)$/m.exec(block)?.[1] ?? null,
      retry: /^retry: (\d+)$/m.exec(block) ? Number(/^retry: (\d+)$/m.exec(block)![1]) : null,
    });
  }
  return { events, rest };
}

/**
 * One change stream held for the whole test, as the dashboard holds it (scripts/change-streams.ts in attendra-cloud
 * opens many at once and times one change; this keeps them open and counts what goes wrong). Any end before the test
 * stops it is a drop; it comes back after the server's `retry` with the last id, as a browser does, and a return that
 * never reaches `ready` is a failed reconnect.
 */
export function holdStream(opts: { url: string; cookie: string; index: number; clinicId: string; signal: AbortSignal; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const record: StreamRecord = { index: opts.index, clinicId: opts.clinicId, opens: 0, readyMs: null, drops: [], failedReconnects: 0, changes: 0, longestSilenceMs: 0 };
  const done = (async () => {
    let lastId: string | null = null;
    let retryMs = 3000;
    while (!opts.signal.aborted) {
      const openedAt = now();
      let ready = false;
      record.opens++;
      try {
        const res = await fetch(opts.url, { headers: { cookie: opts.cookie, accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) }, signal: opts.signal });
        if (res.status !== 200 || !res.body) throw new Error(`status ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastByte = now();
        for (;;) {
          const { value, done: ended } = await reader.read();
          const t = now();
          record.longestSilenceMs = Math.max(record.longestSilenceMs, t - lastByte);
          lastByte = t;
          if (ended) throw new Error('stream ended');
          const split = splitEvents(buffer + decoder.decode(value, { stream: true }));
          buffer = split.rest;
          for (const e of split.events) {
            if (e.id) lastId = e.id;
            if (e.retry) retryMs = e.retry;
            if (e.event === 'ready') { ready = true; record.readyMs ??= t - openedAt; }
            if (e.event === 'change') record.changes++;
          }
        }
      } catch (err) {
        if (opts.signal.aborted) break;
        record.drops.push({ at: new Date(now()).toISOString(), reason: (err as Error).message });
        if (record.opens > 1 && !ready) record.failedReconnects++;
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
  })();
  return { record, done };
}
