// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { callActions, callCosts, calls, callSegments } from '../schema';

/**
 * Call statistics for a set of clinics over a window: the numbers every voice batch is measured by (the audit's
 * "before" numbers, made a tool). Counts and timings only: transcripts are decrypted in memory to spot filler lines and
 * repeated questions, and no word, name or number ever leaves this function.
 *
 * Turn timings are on the engine's session timeline (each line's start and end), so they compare across engines:
 * - voice-only: the caller's last words to the assistant's next words, on a turn where no tool ran;
 * - lookup answer: the caller's last words to the first words said after the tool answered (the `answer_timing` row the
 *   runner writes since batch 1a). A filler line ("let me check") said meanwhile is not the answer. Calls from before
 *   1a have no such row: theirs is estimated from the first line that starts after the turn's last tool, flagged `est`.
 */
export const FILLER = /\b(still (checking|working|looking)|one moment|let me (check|look|see)|just a (moment|second|sec)|un momento|d[eé]jeme (revisar|ver|buscar)|sigo (revisando|buscando|verificando)|todav[ií]a estoy|a[uú]n estoy)\b/i;
/** A line that is nothing but filler: short, and filler from the start. */
const fillerOnly = (text: string) => FILLER.test(text) && text.trim().split(/\s+/).length <= 10;
const normQ = (s: string) => s.toLowerCase().replace(/[\p{N}]+/gu, '#').replace(/[^\p{L}#?\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export interface CallStatsRow {
  id: string; clinicId: string; channel: string; engine: string | null; voiceFlow: string | null; outcome: string | null;
  startedAt: Date; durationS: number | null; segments: number; empty: boolean; firstAudioMs: number | null; noAudio: boolean;
  voiceOnlyMs: number[]; lookupMs: number[]; lookupEstimated: boolean;
  fillerLines: number; repeatedQuestions: number; interruptions: number; longGaps: number; actions: number;
  stalls: number | null; answerTimeouts: number | null; costUsd: number | null; closeReason: string | null;
  /** The engine's billed seconds for the call, when it reported them. */
  voiceSeconds: number | null;
}

export interface CallStatsQuery { clinicIds: string[]; since: Date; until?: Date }

/** Per call, in start order. */
export async function callStats(db: Database, cipher: PhiCipher, q: CallStatsQuery): Promise<CallStatsRow[]> {
  const out: CallStatsRow[] = [];
  for (const clinicId of q.clinicIds) {
    const rows = await withClinic(db, clinicId, async (tx) => {
      const list = await tx.select({
        id: calls.id, channel: calls.channel, engine: calls.engine, voiceFlow: calls.voiceFlow, startedAt: calls.startedAt, endedAt: calls.endedAt,
        outcome: calls.outcome, firstAudioMs: calls.firstAudioMs, stalls: calls.stalls, answerTimeouts: calls.answerTimeouts, closeReason: calls.closeReason, voiceSeconds: calls.voiceSeconds,
      }).from(calls).where(and(eq(calls.clinicId, clinicId), gte(calls.startedAt, q.since), ...(q.until ? [lt(calls.startedAt, q.until)] : []))).orderBy(calls.startedAt);
      if (!list.length) return [];
      const ids = list.map((c) => c.id);
      const segs = await tx.select({ callId: callSegments.callId, speaker: callSegments.speaker, textEnc: callSegments.textEnc, startMs: callSegments.startMs, endMs: callSegments.endMs })
        .from(callSegments).where(and(eq(callSegments.clinicId, clinicId), inArray(callSegments.callId, ids))).orderBy(callSegments.startMs, callSegments.id);
      const acts = await tx.select({ callId: callActions.callId, tool: callActions.tool, result: callActions.result, at: callActions.createdAt })
        .from(callActions).where(and(eq(callActions.clinicId, clinicId), inArray(callActions.callId, ids)));
      const costs = await tx.select({ callId: callCosts.callId, total: callCosts.totalUsd }).from(callCosts).where(and(eq(callCosts.clinicId, clinicId), inArray(callCosts.callId, ids)));
      const ctx = phiContext(clinicId, 'call_segments.text');
      return list.map((c) => statsRow(c, clinicId,
        segs.filter((s) => s.callId === c.id).map((s) => ({ speaker: s.speaker, startMs: s.startMs, endMs: s.endMs, text: cipher.decrypt(s.textEnc, ctx) })),
        acts.filter((a) => a.callId === c.id), costs.find((x) => x.callId === c.id)?.total ?? null));
    });
    out.push(...rows);
  }
  return out.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

type Line = { speaker: 'caller' | 'agent'; startMs: number; endMs: number; text: string };
/** The call row's fields the numbers need. `voiceSeconds` is numeric in the database and a number in the API. */
export interface CallStatsCall {
  id: string; channel: string; engine: string | null; voiceFlow: string | null; startedAt: Date; endedAt: Date | null; outcome: string | null;
  firstAudioMs: number | null; stalls: number | null; answerTimeouts: number | null; closeReason: string | null; voiceSeconds: string | number | null;
}

/**
 * One call's row from its call row, its lines (decrypted) and its tool actions. The load test (apps/web/scripts/load-test)
 * reads calls through the API and measures them here too, so its turn times are the same numbers as this report's.
 */
export function statsRow(c: CallStatsCall, clinicId: string, lines: Line[], actions: { tool: string; result: unknown; at: Date }[], cost: string | null): CallStatsRow {
  const timings = actions.filter((a) => a.tool === 'answer_timing').map((a) => (a.result as { wait_ms?: unknown } | null)?.wait_ms).filter((n): n is number => typeof n === 'number' && n >= 0);
  const tools = actions.filter((a) => a.tool !== 'answer_timing' && a.tool !== 'abusive_caller');
  return measure(c, clinicId, lines, tools.map((a) => a.at.getTime() - c.startedAt.getTime()), timings, cost);
}

function measure(c: CallStatsCall, clinicId: string, segs: Line[], actionMs: number[], timings: number[], cost: string | null): CallStatsRow {
  // consecutive lines of one speaker are one turn, as the call state joins them
  const turns: Line[] = [];
  for (const s of segs) {
    const last = turns.at(-1);
    if (last && last.speaker === s.speaker) { last.text += ` ${s.text}`; last.endMs = Math.max(last.endMs, s.endMs); } else turns.push({ ...s });
  }
  const row: CallStatsRow = {
    id: c.id, clinicId, channel: c.channel, engine: c.engine, voiceFlow: c.voiceFlow, outcome: c.outcome, startedAt: c.startedAt,
    durationS: c.endedAt ? Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000) : null, segments: segs.length,
    empty: !turns.some((t) => t.speaker === 'agent' && t.text.trim().length >= 20), firstAudioMs: c.firstAudioMs, noAudio: c.outcome === 'no_audio',
    voiceOnlyMs: [], lookupMs: [...timings], lookupEstimated: !timings.length,
    fillerLines: 0, repeatedQuestions: 0, interruptions: 0, longGaps: 0, actions: actionMs.length,
    stalls: c.stalls, answerTimeouts: c.answerTimeouts, costUsd: cost === null ? null : Number(cost), closeReason: c.closeReason,
    voiceSeconds: c.voiceSeconds === null ? null : Number(c.voiceSeconds),
  };
  const asked = new Set<string>();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.speaker !== 'agent') continue;
    if (FILLER.test(t.text)) row.fillerLines++;
    for (const q of t.text.match(/[^.!?]*\?/g) ?? []) {
      const n = normQ(q);
      if (n.length < 12) continue;
      if (asked.has(n)) row.repeatedQuestions++; else asked.add(n);
    }
    const prev = turns[i - 1];
    if (!prev || prev.speaker !== 'caller') continue;
    const gap = t.startMs - prev.endMs;
    if (gap < 0) { row.interruptions++; continue; }
    if (gap > 8000) row.longGaps++;
    // the next caller turn bounds this one: a tool that ran in between makes it a lookup turn (the tool's clock is ±2 s)
    const until = turns.slice(i + 1).find((x) => x.speaker === 'caller')?.startMs ?? Number.POSITIVE_INFINITY;
    const ran = actionMs.filter((a) => a >= prev.endMs - 2000 && a <= until);
    if (!ran.length) { row.voiceOnlyMs.push(gap); continue; }
    if (!row.lookupEstimated) continue;
    // before 1a: the first line of this turn's replies that starts after the last tool and is more than filler
    const last = Math.max(...ran);
    const answer = segs.find((s) => s.speaker === 'agent' && s.startMs >= prev.endMs && s.startMs < until && s.startMs >= last - 2000 && !fillerOnly(s.text));
    if (answer) row.lookupMs.push(answer.startMs - prev.endMs);
  }
  return row;
}

export const percentile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!;
};
const fmt = (xs: number[]) => (xs.length ? `n=${xs.length} median=${percentile(xs, 0.5)} p90=${percentile(xs, 0.9)} max=${Math.max(...xs)}` : 'n=0');

export interface CallStatsGroup {
  key: string; calls: number; empty: number; noAudio: number; firstAudioMs: number[];
  voiceOnlyMs: number[]; lookupMs: number[]; lookupEstimated: boolean; fillerCalls: number; fillerLines: number;
  repeatedQuestions: number; repeatedCalls: number; interruptions: number; longGaps: number; costUsd: number;
  /** Cost per minute of the calls with both a cost and a length; null with none. */
  costPerMinute: number | null;
}

const perMinute = (rs: CallStatsRow[]) => {
  const priced = rs.filter((r) => r.costUsd !== null && r.voiceSeconds);
  const minutes = priced.reduce((n, r) => n + r.voiceSeconds! / 60, 0);
  return minutes ? Math.round((priced.reduce((n, r) => n + r.costUsd!, 0) / minutes) * 1e4) / 1e4 : null;
};

/** The calls summed by clinic, channel, engine and flow: the lines a batch's before/after table compares. */
export function groupCallStats(rows: CallStatsRow[]): CallStatsGroup[] {
  const groups = new Map<string, CallStatsRow[]>();
  for (const r of rows) {
    const key = `${r.clinicId} · ${r.channel} · ${r.engine ?? 'engine?'} · ${r.voiceFlow ?? 'planner'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([key, rs]) => ({
    key, calls: rs.length, empty: rs.filter((r) => r.empty).length, noAudio: rs.filter((r) => r.noAudio).length,
    firstAudioMs: rs.map((r) => r.firstAudioMs).filter((n): n is number => n !== null),
    voiceOnlyMs: rs.flatMap((r) => r.voiceOnlyMs), lookupMs: rs.flatMap((r) => r.lookupMs), lookupEstimated: rs.some((r) => r.lookupEstimated && r.lookupMs.length),
    fillerCalls: rs.filter((r) => r.fillerLines).length, fillerLines: rs.reduce((n, r) => n + r.fillerLines, 0),
    repeatedQuestions: rs.reduce((n, r) => n + r.repeatedQuestions, 0), repeatedCalls: rs.filter((r) => r.repeatedQuestions).length,
    interruptions: rs.reduce((n, r) => n + r.interruptions, 0), longGaps: rs.reduce((n, r) => n + r.longGaps, 0),
    costUsd: Math.round(rs.reduce((n, r) => n + (r.costUsd ?? 0), 0) * 1e4) / 1e4,
    costPerMinute: perMinute(rs),
  }));
}

/** The report as text lines: one block per group, then one line per call. Numbers and call id prefixes only. */
export function formatCallStats(rows: CallStatsRow[], opts: { perCall?: boolean } = {}): string[] {
  const lines: string[] = [];
  for (const g of groupCallStats(rows)) {
    lines.push(`== ${g.key}: ${g.calls} calls`);
    lines.push(`empty calls (no assistant line of 20+ chars): ${g.empty}; no_audio outcome: ${g.noAudio}`);
    lines.push(`first audio ms: ${fmt(g.firstAudioMs)}`);
    lines.push(`voice-only turn ms: ${fmt(g.voiceOnlyMs)}`);
    lines.push(`lookup answer ms${g.lookupEstimated ? ' (est. for calls before 1a)' : ''}: ${fmt(g.lookupMs)}`);
    lines.push(`filler lines: ${g.fillerLines} in ${g.fillerCalls} calls; repeated questions: ${g.repeatedQuestions} in ${g.repeatedCalls} calls`);
    lines.push(`interruptions: ${g.interruptions}; gaps over 8 s: ${g.longGaps}; cost: $${g.costUsd.toFixed(4)}${g.costPerMinute === null ? '' : ` ($${g.costPerMinute.toFixed(4)} a minute)`}`);
    if (opts.perCall) {
      lines.push('call  started_utc       dur_s segs acts voice_med lookup_med filler repQ gaps>8s first_audio empty outcome close');
      for (const r of rows.filter((x) => `${x.clinicId} · ${x.channel} · ${x.engine ?? 'engine?'} · ${x.voiceFlow ?? 'planner'}` === g.key)) {
        lines.push([r.id.slice(0, 8), r.startedAt.toISOString().slice(0, 16), r.durationS ?? '-', r.segments, r.actions, percentile(r.voiceOnlyMs, 0.5) ?? '-',
          `${percentile(r.lookupMs, 0.5) ?? '-'}${r.lookupEstimated && r.lookupMs.length ? '~' : ''}`, r.fillerLines, r.repeatedQuestions, r.longGaps,
          r.firstAudioMs ?? '-', r.empty ? 'EMPTY' : '-', r.outcome ?? '-', (r.closeReason ?? '-').replace(/\s+/g, '_').slice(0, 40)].join(' '));
      }
    }
    lines.push('');
  }
  return lines;
}
