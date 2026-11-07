// SPDX-License-Identifier: AGPL-3.0-only
import { type Pager, PAGE_COOLDOWN_MS, p0Rule, pagerFromEnv, runbookLink } from './paging';

/**
 * Alerts for the people who run Attendra, in a Slack channel (an incoming webhook): a
 * call turned away, a call that failed, a job that gave up, the backup route answering.
 * Nobody watches logs; the system says when something is wrong, and when it is right
 * again.
 *
 * Quiet on purpose. The first alert of a kind goes out at once; more of the same kind
 * within the window are counted and sent as one line when the window ends; a kind that
 * stops failing for a whole window gets "back to normal". An alert carries codes and
 * counts, never a caller's details: no names, and numbers cut to their last 4 digits.
 *
 * The P0 kinds (paging.ts) also page the on-call phone, when a pager is set, and their
 * Slack line carries the runbook's address.
 */
export interface Alerter {
  /** Something is wrong. `kind` groups repeats ("call_rejected"); `text` says what, in plain words. */
  alert(kind: string, text: string): void;
  /** Something worth knowing that is not a failure (a deploy finished, a service started). Never throttled. */
  note(text: string): void;
  /** Sends what is still counted, for a clean shutdown. */
  flush(): Promise<void>;
}

export interface AlerterOptions {
  /** A Slack incoming webhook. Without one, alerts are only logged. */
  webhookUrl?: string;
  /** Which part of Attendra speaks: "voice", "worker", "api". */
  service: string;
  log?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
  /** How long repeats of a kind are gathered into one line, and quiet counts as recovery. Defaults to 15 minutes. */
  windowMs?: number;
  /** Pages the P0 kinds. Left out, ATTENDRA_PAGER_* in the environment choose it (paging.ts); null turns paging off. */
  pager?: Pager | null;
  /** Where the runbooks are, like https://github.com/org/repo/blob/main/runbooks. Left out, ATTENDRA_RUNBOOK_URL. */
  runbookUrl?: string;
  /** For tests. */
  post?: (url: string, body: unknown) => Promise<void>;
  now?: () => number;
}

const LAST4 = /\+?\d[\d\s().-]{6,}\d/g;
/** Numbers in an alert are cut to their last 4 digits: "+17205550160" is "…0160". */
export const maskNumbers = (text: string) => text.replace(LAST4, (m) => `…${m.replace(/\D/g, '').slice(-4)}`);

const defaultPost = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`slack answered ${res.status}`);
};

export function createAlerter(o: AlerterOptions): Alerter {
  const windowMs = o.windowMs ?? 15 * 60_000;
  const now = o.now ?? Date.now;
  const post = o.post ?? defaultPost;
  const pager = o.pager === undefined ? pagerFromEnv(process.env, o.log) : o.pager;
  const runbooks = o.runbookUrl ?? process.env.ATTENDRA_RUNBOOK_URL;
  // per kind: when its window started, repeats counted in it, how many in this window, and the last text
  const open = new Map<string, { since: number; more: number; seen: number; last: string; timer: NodeJS.Timeout | null }>();
  // per P0 kind: when it last paged
  const paged = new Map<string, number>();
  const page = (kind: string, text: string, seen: number) => {
    const rule = p0Rule(kind);
    if (!pager || !rule || seen < rule.after) return;
    const last = paged.get(kind);
    if (last !== undefined && now() - last < PAGE_COOLDOWN_MS) return;
    paged.set(kind, now());
    const said = seen > 1 ? `${seen} within ${Math.round(windowMs / 60_000)} min. Latest: ${text}` : text;
    void pager.page({ service: o.service, kind, text: maskNumbers(said), link: runbookLink(runbooks, kind) })
      .catch((err: unknown) => o.log?.warn({ err: { message: (err as Error).message } }, 'page not sent'));
  };
  // a P0 kind's Slack line says so, with its runbook
  const tag = (kind: string) => {
    if (!p0Rule(kind)) return '';
    const link = runbookLink(runbooks, kind);
    return link ? ` [P0, runbook: ${link}]` : ' [P0]';
  };
  const send = (text: string) => {
    const line = maskNumbers(`[${o.service}] ${text}`);
    if (!o.webhookUrl) { o.log?.warn({ alert: line }, 'alert (no Slack webhook set)'); return Promise.resolve(); }
    return post(o.webhookUrl, { text: line }).catch((err: unknown) => o.log?.warn({ err: { message: (err as Error).message } }, 'alert not sent'));
  };
  const close = (kind: string) => {
    const s = open.get(kind);
    if (!s) return;
    if (s.more > 0) {
      // still failing: report the count, and keep watching for another window
      void send(`:warning: ${kind}: ${s.more} more in the last ${Math.round(windowMs / 60_000)} min. Latest: ${s.last}${tag(kind)}`);
      s.since = now(); s.more = 0; s.seen = 0;
      s.timer = setTimeout(() => close(kind), windowMs); s.timer.unref?.();
      return;
    }
    open.delete(kind);
    void send(`:white_check_mark: ${kind}: back to normal (none for ${Math.round(windowMs / 60_000)} min).`);
  };
  return {
    alert(kind, text) {
      const s = open.get(kind);
      if (s) { s.more++; s.seen++; s.last = text; page(kind, text, s.seen); return; }
      const timer = setTimeout(() => close(kind), windowMs);
      timer.unref?.();
      open.set(kind, { since: now(), more: 0, seen: 1, last: text, timer });
      void send(`:rotating_light: ${kind}: ${text}${tag(kind)}`);
      page(kind, text, 1);
    },
    note(text) { void send(`:information_source: ${text}`); },
    async flush() {
      const pending = [...open.entries()].filter(([, s]) => s.more > 0);
      for (const [, s] of open) if (s.timer) clearTimeout(s.timer);
      open.clear();
      await Promise.all(pending.map(([kind, s]) => send(`:warning: ${kind}: ${s.more} more before shutdown. Latest: ${s.last}`)));
    },
  };
}

/** An alerter that only logs: for tests and for a deployment without Slack. */
export const silentAlerter: Alerter = { alert: () => {}, note: () => {}, flush: async () => {} };
