// SPDX-License-Identifier: AGPL-3.0-only
import { type Pager, PAGE_COOLDOWN_MS, p0Rule, pagerFromEnv, runbookLink, SLACK_MENTION, slackPager } from './paging';
import { alertStep } from './steps';

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
 * Every line can be acted on from a phone: an alert about a clinic or a call names the
 * clinic, links the call in the dashboard, and ends with what to do (steps.ts).
 *
 * The P0 kinds (paging.ts) also page the on-call phone, and their Slack line carries the
 * runbook's address. With no ntfy topic set, the pager is Slack itself: the line that
 * pages starts with <!channel>, and no other line does.
 */
export interface Alerter {
  /**
   * Something is wrong. `kind` groups repeats ("call_rejected"); `text` says what, in plain words; `where` is the
   * clinic and call it happened on (ids only: the clinic's name is looked up, the call becomes a link).
   */
  alert(kind: string, text: string, where?: AlertWhere): void;
  /** A kind whose end its own check decides (recovery 'checker': a balance back above its line) is back to normal. */
  resolved(kind: string, text: string): void;
  /** Something worth knowing that is not a failure (a deploy finished, a service started). Never throttled. */
  note(text: string): void;
  /** Sends what is still counted, for a clean shutdown. */
  flush(): Promise<void>;
}

/** The clinic and call an alert is about. Ours, never the caller's. */
export interface AlertWhere {
  clinicId?: string;
  /** Given when the service has it at hand; otherwise looked up with `clinicName`. */
  clinicName?: string;
  callId?: string;
}

export interface AlerterOptions {
  /** A Slack incoming webhook. Without one, alerts are only logged. */
  webhookUrl?: string;
  /** Which part of Attendra speaks: "voice", "worker", "api". */
  service: string;
  log?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
  /** How long repeats of a kind are gathered into one line, and quiet counts as recovery. Defaults to 15 minutes. */
  windowMs?: number;
  /**
   * Pages the P0 kinds. Left out: ntfy when ATTENDRA_PAGER_* in the environment set it (paging.ts), else Slack itself
   * (<!channel>) when there is a webhook. null turns paging off.
   */
  pager?: Pager | null;
  /** Where the runbooks are, like https://github.com/org/repo/blob/main/runbooks. Left out, ATTENDRA_RUNBOOK_URL. */
  runbookUrl?: string;
  /** The dashboard's address (PUBLIC_URL): a call's link is <appUrl>/c/<clinic>/calls/<call>. Without it, no link. */
  appUrl?: string;
  /** Looks up a clinic's name for its alerts. A failed or slow lookup leaves the id alone. */
  clinicName?: (clinicId: string) => Promise<string | undefined>;
  /** For tests. */
  post?: (url: string, body: unknown) => Promise<void>;
  now?: () => number;
}

const LAST4 = /\+?\d[\d\s().-]{6,}\d/g;
/** Numbers in an alert are cut to their last 4 digits: "+17205550160" is "…0160". */
export const maskNumbers = (text: string) => text.replace(LAST4, (m) => `…${m.replace(/\D/g, '').slice(-4)}`);

/** One line to a Slack incoming webhook; throws when Slack does not take it. The alerter's own post. */
export const postToSlack = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`slack answered ${res.status}`);
};

/** A clinic's name is read again after this long: a rename shows within minutes. */
const NAME_TTL_MS = 10 * 60_000;
/** A name lookup slower than this is given up on: the alert goes out with the id. */
const NAME_WAIT_MS = 2000;

/** Calls `f` with `x` now when it is a value, or once it resolves: lines with nothing to look up go out at once. */
const then = <T>(x: T | Promise<T>, f: (v: T) => unknown) => { if (x instanceof Promise) void x.then(f); else f(x); };

export function createAlerter(o: AlerterOptions): Alerter {
  const windowMs = o.windowMs ?? 15 * 60_000;
  const now = o.now ?? Date.now;
  const post = o.post ?? postToSlack;
  const fromEnv = o.pager === undefined ? pagerFromEnv(process.env, o.log) : o.pager;
  const pager = o.pager === undefined && !fromEnv && o.webhookUrl ? slackPager({ url: o.webhookUrl, post }) : fromEnv;
  const runbooks = o.runbookUrl ?? process.env.ATTENDRA_RUNBOOK_URL;
  let appUrl = o.appUrl?.trim();
  while (appUrl?.endsWith('/')) appUrl = appUrl.slice(0, -1);
  if (appUrl && !/^https?:\/\//.test(appUrl)) appUrl = undefined;
  // per kind: when its window started, repeats counted in it, how many in this window, and the last text and place
  const open = new Map<string, { since: number; more: number; seen: number; last: string; where?: AlertWhere; timer: NodeJS.Timeout | null }>();
  // per P0 kind: when it last paged
  const paged = new Map<string, number>();
  const names = new Map<string, { name?: string; at: number }>();

  // the clinic's name, from the alert, the cache or one lookup; never holds an alert up for long, never throws
  const nameOf = (w?: AlertWhere): string | undefined | Promise<string | undefined> => {
    if (!w?.clinicId) return undefined;
    if (w.clinicName) return w.clinicName;
    if (!o.clinicName) return undefined;
    const id = w.clinicId;
    const hit = names.get(id);
    if (hit && now() - hit.at < NAME_TTL_MS) return hit.name;
    // a lookup that throws at once is the same as one that fails: the id stays
    const lookup = Promise.resolve().then(() => o.clinicName!(id)).then((name) => { names.set(id, { name: name?.trim() || undefined, at: now() }); return name?.trim() || undefined; });
    const late = new Promise<undefined>((r) => { const t = setTimeout(() => r(undefined), NAME_WAIT_MS); t.unref?.(); });
    return Promise.race([lookup, late]).catch(() => undefined);
  };
  // what comes after the alert's own words: the clinic, the call's link, what to do. Not cut by maskNumbers: the ids
  // and the link are ours, and a long run of digits in an id must stay whole
  const tailWith = (kind: string, w: AlertWhere | undefined, name: string | undefined) => {
    const parts: string[] = [];
    if (w?.clinicId) parts.push(`Clinic: ${name ? `${maskNumbers(name)} (${w.clinicId})` : w.clinicId}.`);
    if (w?.clinicId && w.callId && appUrl) parts.push(`Call: <${appUrl}/c/${encodeURIComponent(w.clinicId)}/calls/${encodeURIComponent(w.callId)}|open the call>.`);
    const step = alertStep(kind);
    if (step) parts.push(`Do: ${step}`);
    return parts.length ? ` ${parts.join(' ')}` : '';
  };
  const tail = (kind: string, w?: AlertWhere): string | Promise<string> => {
    const name = nameOf(w);
    return name instanceof Promise ? name.then((n) => tailWith(kind, w, n)) : tailWith(kind, w, name);
  };
  // a P0 kind's Slack line says so, with its runbook
  const tag = (kind: string) => {
    if (!p0Rule(kind)) return '';
    const link = runbookLink(runbooks, kind);
    return link ? ` [P0, runbook: ${link}]` : ' [P0]';
  };
  // `body` is cut to the last 4 digits of any number; `after` (clinic, link, step, tag) is sent as it is
  const send = (body: string, after = '', mention = false) => {
    const line = `${mention ? `${SLACK_MENTION} ` : ''}${maskNumbers(`[${o.service}] ${body}`)}${after}`;
    if (!o.webhookUrl) { o.log?.warn({ alert: line }, 'alert (no Slack webhook set)'); return Promise.resolve(); }
    return post(o.webhookUrl, { text: line }).catch((err: unknown) => o.log?.warn({ err: { message: (err as Error).message } }, 'alert not sent'));
  };
  // whether this alert pages: the kind's P0 count reached within the window, and not paged within the cooldown
  const pagesNow = (kind: string, seen: number) => {
    const rule = p0Rule(kind);
    if (!pager || !rule || seen < rule.after) return false;
    const last = paged.get(kind);
    if (last !== undefined && now() - last < PAGE_COOLDOWN_MS) return false;
    paged.set(kind, now());
    return true;
  };
  const page = (kind: string, text: string, seen: number, where?: AlertWhere) => {
    if (!pager) return;
    const said = seen > 1 ? `${seen} within ${Math.round(windowMs / 60_000)} min. Latest: ${text}` : text;
    then(tail(kind, where), (t) => {
      void pager.page({ service: o.service, kind, text: `${maskNumbers(said)}${t}`, link: runbookLink(runbooks, kind) })
        .catch((err: unknown) => o.log?.warn({ err: { message: (err as Error).message } }, 'page not sent'));
    });
  };
  const close = (kind: string) => {
    const s = open.get(kind);
    if (!s) return;
    if (s.more > 0) {
      // still failing: report the count, and keep watching for another window
      const { more, last, where } = s;
      then(tail(kind, where), (t) => send(`:warning: ${kind}: ${more} more in the last ${Math.round(windowMs / 60_000)} min. Latest: ${last}`, `${t}${tag(kind)}`));
      s.since = now(); s.more = 0; s.seen = 0;
      s.timer = setTimeout(() => close(kind), windowMs); s.timer.unref?.();
      return;
    }
    open.delete(kind);
    // a state its own check watches (a low balance) is not over because it went quiet: the check says when it is
    if (p0Rule(kind)?.recovery === 'checker') return;
    void send(`:white_check_mark: ${kind}: back to normal (none for ${Math.round(windowMs / 60_000)} min).`);
  };
  return {
    alert(kind, text, where) {
      const s = open.get(kind);
      if (s) {
        s.more++; s.seen++; s.last = text; s.where = where;
        // a burst that reaches its P0 count pages now; its count goes to Slack when the window ends
        if (pagesNow(kind, s.seen)) page(kind, text, s.seen, where);
        return;
      }
      const timer = setTimeout(() => close(kind), windowMs);
      timer.unref?.();
      open.set(kind, { since: now(), more: 0, seen: 1, last: text, where, timer });
      const pages = pagesNow(kind, 1);
      // Slack is the pager: the alert's own line is the page, with the mention, not a second line
      const mention = pages && pager?.channel === 'slack';
      then(tail(kind, where), (t) => send(`:rotating_light: ${kind}: ${text}`, `${t}${tag(kind)}`, mention));
      if (pages && !mention) page(kind, text, 1, where);
    },
    resolved(kind, text) {
      const s = open.get(kind);
      if (s?.timer) clearTimeout(s.timer);
      open.delete(kind);
      // the next time it happens it pages at once, not an hour after this one
      paged.delete(kind);
      void send(`:white_check_mark: ${kind}: back to normal. ${text}`);
    },
    note(text) { void send(`:information_source: ${text}`); },
    async flush() {
      const pending = [...open.entries()].filter(([, s]) => s.more > 0);
      for (const [, s] of open) if (s.timer) clearTimeout(s.timer);
      open.clear();
      await Promise.all(pending.map(async ([kind, s]) => send(`:warning: ${kind}: ${s.more} more before shutdown. Latest: ${s.last}`, await tail(kind, s.where))));
    },
  };
}

/** An alerter that only logs: for tests and for a deployment without Slack. */
export const silentAlerter: Alerter = { alert: () => {}, resolved: () => {}, note: () => {}, flush: async () => {} };
