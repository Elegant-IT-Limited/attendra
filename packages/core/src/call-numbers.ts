// SPDX-License-Identifier: AGPL-3.0-only
import { type CallEvent, hasTurnEnds, turnTimings } from './call-events';
import { STALL_MS } from './call-markers';
import { talksAboutInternals } from './medical';

/**
 * A clinic's daily numbers, per call path (foundation A, item 7): the review's digest metrics, from the per-call event
 * log and the call records already kept. One function for the QA export's `numbers` and `pnpm db:call-numbers`. A
 * number that cannot be measured yet with what is recorded says so, with the reason: it is never made up.
 */

/** A count over the day's calls on one path, or why there is none. `callsMeasured`: how many of the calls it covers. */
export type DayMetric =
  | { status: 'measured'; value: number; callsMeasured: number; source: string; definition: string }
  | { status: 'not_measured'; reason: string };
/** Reply times: the median and 90th percentile in ms, over `n` caller turns. */
export type ReplyTimes =
  | { status: 'measured'; p50: number; p90: number; n: number; callsMeasured: number; source: string; definition: string }
  | { status: 'not_measured'; reason: string };

/** One of the day's calls, as the numbers read it. Words are read in memory only; nothing of them is returned. */
export interface NumbersCall {
  id: string;
  /** engine/flow: gpt-realtime/tools, gpt-live/planner, vapi/tools... */
  path: string;
  testCall: boolean;
  /** The runner's stall count (calls.stalls, the 5 s nudge); null on a path without our runner (Vapi) or an older call. */
  runnerStalls: number | null;
  /** The call's event log, in order; empty when it has none (before this release, past 7 days, or the log failed). */
  events: Pick<CallEvent, 'type' | 'atMs'>[];
  /** The tool refusals on the call (call_actions with an error code), in order. */
  refusals: { tool: string; code: string }[];
  /** The assistant's lines; null when the transcript is gone (retention). */
  agentLines: string[] | null;
}

export interface PathNumbers {
  path: string;
  calls: number;
  testCalls: number;
  callsWithEventLog: number;
  stalls: DayMetric;
  replyMs: ReplyTimes;
  yesDisagreements: DayMetric;
  refusalLoops: DayMetric & { loops?: { tool: string; code: string; calls: number }[] };
  internalTalk: DayMetric;
}

/** A refusal said this many times in one call, for the same tool and code, is a loop. */
export const REFUSAL_LOOP_MIN = 3;

/** The value at a fraction of the sorted list (nearest rank). */
export function percentileOf(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

const NO_LOG = 'no call on this path has an event log for the day: the log started with foundation A and is kept 7 days';
const notMeasured = (reason: string) => ({ status: 'not_measured' as const, reason });

/** The day's numbers for each call path, paths in name order. */
export function dailyNumbers(calls: readonly NumbersCall[]): PathNumbers[] {
  const paths = [...new Set(calls.map((c) => c.path))].sort();
  return paths.map((path) => numbersFor(path, calls.filter((c) => c.path === path)));
}

function numbersFor(path: string, calls: readonly NumbersCall[]): PathNumbers {
  const timed = calls.filter((c) => hasTurnEnds(c.events));
  const timings = new Map(timed.map((c) => [c.id, turnTimings(c.events)]));
  const noTurnEnds = path.startsWith('gpt-live')
    ? 'GPT-Live\'s sideband sends no event when the caller stops speaking, so a reply time cannot be read from its log'
    : calls.some((c) => c.events.length) ? 'the event log of these calls has no end of a caller turn' : NO_LOG;

  // stalls: from the log where it shows the caller's turns; otherwise the runner's own count (same 5 s)
  let stalls = 0;
  let stallCalls = 0;
  const sources = new Set<string>();
  for (const c of calls) {
    const t = timings.get(c.id);
    if (t) { stalls += t.stalls; stallCalls++; sources.add('event_log'); } else if (c.runnerStalls !== null) { stalls += c.runnerStalls; stallCalls++; sources.add('call_record'); }
  }
  const replies = [...timings.values()].flatMap((t) => t.replyMs);

  // refusal loops: the same tool refusing with the same code 3 times or more in one call
  const loops = new Map<string, { tool: string; code: string; calls: number }>();
  let loopCalls = 0;
  for (const c of calls) {
    const counts = new Map<string, number>();
    for (const r of c.refusals) counts.set(`${r.tool}\u0000${r.code}`, (counts.get(`${r.tool}\u0000${r.code}`) ?? 0) + 1);
    const looped = [...counts].filter(([, n]) => n >= REFUSAL_LOOP_MIN);
    if (looped.length) loopCalls++;
    for (const [key] of looped) {
      const [tool, code] = key.split('\u0000') as [string, string];
      const l = loops.get(key) ?? { tool, code, calls: 0 };
      l.calls++;
      loops.set(key, l);
    }
  }

  const read = calls.filter((c) => c.agentLines !== null);
  const talk = read.reduce((n, c) => n + c.agentLines!.filter(talksAboutInternals).length, 0);

  return {
    path, calls: calls.length, testCalls: calls.filter((c) => c.testCall).length, callsWithEventLog: calls.filter((c) => c.events.length).length,
    stalls: stallCalls
      ? { status: 'measured', value: stalls, callsMeasured: stallCalls, source: [...sources].sort().join('+'), definition: `caller turns where no reply started within ${STALL_MS / 1000} s of the caller stopping (event_log), or the runner's 5 s nudges where the log has no turn ends (call_record)` }
      : notMeasured(path.startsWith('vapi') ? NO_LOG : 'no call on this path has a stall count or an event log'),
    replyMs: replies.length
      ? { status: 'measured', p50: percentileOf(replies, 0.5)!, p90: percentileOf(replies, 0.9)!, n: replies.length, callsMeasured: timed.length, source: 'event_log', definition: 'ms from the caller stopping speaking to the start of the assistant\'s reply' }
      : notMeasured(timed.length ? 'no caller turn on this path was answered with a reply' : noTurnEnds),
    yesDisagreements: notMeasured('needs a second reading of the caller\'s yes (the voice model\'s own, planned for batch B); today only the transcript\'s yes is recorded'),
    refusalLoops: { status: 'measured', value: loopCalls, callsMeasured: calls.length, source: 'call_actions', definition: `calls where one tool refused with the same code ${REFUSAL_LOOP_MIN} times or more`, loops: [...loops.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)) },
    internalTalk: read.length
      ? { status: 'measured', value: talk, callsMeasured: read.length, source: 'transcript', definition: 'assistant lines that talk about how it works (core talksAboutInternals: "in the background", "the system", "the lookup"...)' }
      : notMeasured('the transcripts of these calls are gone (the clinic\'s retention)'),
  };
}

/** The numbers as text lines, for the script. */
export function formatDailyNumbers(head: string, paths: readonly PathNumbers[]): string[] {
  const m = (x: DayMetric) => (x.status === 'measured' ? `${x.value} (${x.callsMeasured} calls, ${x.source})` : `not measured yet: ${x.reason}`);
  const lines = [head];
  if (!paths.length) lines.push('no calls');
  for (const p of paths) {
    lines.push(`== ${p.path}: ${p.calls} calls (${p.testCalls} test calls), ${p.callsWithEventLog} with an event log`);
    lines.push(`stalls: ${m(p.stalls)}`);
    lines.push(`reply ms: ${p.replyMs.status === 'measured' ? `p50 ${p.replyMs.p50}, p90 ${p.replyMs.p90} over ${p.replyMs.n} turns (${p.replyMs.callsMeasured} calls)` : `not measured yet: ${p.replyMs.reason}`}`);
    lines.push(`yes-disagreements: ${m(p.yesDisagreements)}`);
    lines.push(`refusal loops: ${m(p.refusalLoops)}${p.refusalLoops.loops?.length ? `: ${p.refusalLoops.loops.map((l) => `${l.tool}/${l.code} in ${l.calls}`).join(', ')}` : ''}`);
    lines.push(`internal-talk lines: ${m(p.internalTalk)}`);
  }
  return lines;
}
