// SPDX-License-Identifier: AGPL-3.0-only
import type { Alerter, Logger } from '@attendra/observability';

/**
 * A restart that lets the calls finish (Batch A item 4). On SIGTERM the voice service stops taking new calls and waits
 * for the live ones (phone, browser test, simulated and Vapi calls) to end, at most DRAIN_MAX_MS, then exits. A second
 * signal or the deadline ends the wait: each call still live is told the line is restarting and is hung up, and the
 * number cut is logged and said in Slack. Live call state is in this process's memory, so a call it does not finish is
 * lost to it.
 *
 * During the drain a new phone call is rejected with SIP 503: Twilio's trunk then asks its disaster recovery URL (the
 * backup route, packages/telephony/src/fallback.ts), which rings the clinic's front desk or on-call phone, or says the
 * clinic cannot take the call and where to go in an emergency. Twilio fails over on a 5xx only (a 4xx such as 404, a
 * 486 or a 6xx is final), so 503 is the code that gets the caller answered. A browser test call is refused with
 * `voice_restarting`, which the dashboard says in words.
 */

/** The longest a restart waits for live calls. Docker's stop_grace_period for voice must be longer (deploy: 11m). */
export const DRAIN_MAX_MS = 10 * 60_000;
/** How often the drain looks at the live calls. */
export const DRAIN_POLL_MS = 500;
/** A call cut at the deadline: how long its goodbye may take before the line is closed. */
export const DRAIN_CUT_GOODBYE_MS = 8000;
/** What the voice is told when its call is cut at the deadline: one sentence, then the line closes. */
export const DRAIN_CUT_TEXT = 'The phone line must restart now and this call has to end. Stop the current task. Tell the caller in one or two short sentences that you are sorry, the line is restarting, and ask them to call back in a couple of minutes. Then say nothing more.';
/** What a browser test call started during a drain is refused with (the dashboard says it in words). */
export const DRAINING_ERROR = 'voice_restarting';

/** How a drain ended: every call finished, the deadline, or a second signal. */
export type DrainEnd = 'idle' | 'deadline' | 'signal';
export interface DrainResult {
  end: DrainEnd;
  /** Calls still live when the drain ended, which were cut. */
  cut: number;
  waitedMs: number;
}

export interface DrainOptions {
  /** Calls this process is running now. */
  liveCalls(): number;
  /** Ends the calls still live (a goodbye, then the line closes); resolves once they are over, or after a bound. */
  cut(): Promise<void>;
  pollMs?: number;
  now?: () => number;
}

/** One drain per process: the first start() begins it, later ones get the same result. */
export class Drain {
  private run: Promise<DrainResult> | null = null;
  private forced = false;
  private stop: ((end: DrainEnd) => void) | null = null;
  constructor(private readonly o: DrainOptions) {}

  /** True from the first start(): new calls are refused. */
  get draining(): boolean { return this.run !== null; }

  /** Stops new calls and waits for the live ones to end, at most `maxMs`. */
  start(maxMs: number = DRAIN_MAX_MS): Promise<DrainResult> {
    this.run ??= this.wait(maxMs);
    return this.run;
  }

  /** A second signal: stop waiting and cut what is still live. */
  force(): void {
    this.forced = true;
    this.stop?.('signal');
  }

  private async wait(maxMs: number): Promise<DrainResult> {
    const now = this.o.now ?? Date.now;
    const t0 = now();
    const end = this.o.liveCalls() === 0 ? 'idle' : this.forced ? 'signal' : await new Promise<DrainEnd>((resolve) => {
      const done = (e: DrainEnd) => {
        if (!this.stop) return;
        this.stop = null;
        clearTimeout(deadline);
        clearInterval(poll);
        resolve(e);
      };
      this.stop = done;
      const deadline = setTimeout(() => done('deadline'), maxMs);
      const poll = setInterval(() => { if (this.o.liveCalls() === 0) done('idle'); }, this.o.pollMs ?? DRAIN_POLL_MS);
    });
    if (end === 'idle') return { end, cut: 0, waitedMs: now() - t0 };
    const cut = this.o.liveCalls();
    await this.o.cut();
    return { end, cut, waitedMs: now() - t0 };
  }
}

/** What main.ts drains: a voice server's drain (server.ts drainOf). */
export interface Drainable {
  liveCalls(): number;
  turnedAway(): number;
  start(maxMs?: number): Promise<DrainResult>;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * A restart's drain with its log lines and Slack notes: when it starts with calls live, and when it ends with calls cut
 * or new calls turned away. Counts only, nothing about any call.
 */
export async function drainForRestart(drain: Drainable, o: { log: Logger; alerts?: Alerter; signal: string; maxMs?: number }): Promise<DrainResult> {
  const maxMs = o.maxMs ?? DRAIN_MAX_MS;
  const minutes = Math.round(maxMs / 60_000);
  const live = drain.liveCalls();
  o.log.info({ signal: o.signal, live_calls: live, max_seconds: Math.round(maxMs / 1000) }, 'restart: draining, new calls go to the backup route');
  if (live) o.alerts?.note(`Voice service restarting: waiting for ${plural(live, 'live call')} to end (at most ${minutes} minutes). New phone calls go to the backup route meanwhile.`);
  const r = await drain.start(maxMs);
  const away = drain.turnedAway();
  const fields = { end: r.end, cut: r.cut, waited_seconds: Math.round(r.waitedMs / 1000), turned_away: away };
  const turned = `New calls turned away meanwhile (phone calls to the backup route, test calls refused): ${away}.`;
  if (r.cut) {
    o.log.warn(fields, 'restart: calls were cut');
    o.alerts?.note(`Voice service stopping with ${plural(r.cut, 'call')} cut (${r.end === 'deadline' ? `still live after ${minutes} minutes` : 'a second stop signal'}): our calls heard a goodbye and were hung up; a Vapi call carries on at Vapi without its memory. ${turned}`);
  } else {
    o.log.info(fields, 'restart: every call finished');
    if (live || away) o.alerts?.note(`Voice service stopping: every live call finished (${Math.round(r.waitedMs / 1000)} s). ${turned}`);
  }
  return r;
}
