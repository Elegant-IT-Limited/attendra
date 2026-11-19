// SPDX-License-Identifier: AGPL-3.0-only
import type { CallEvent } from './call-events';
import { percentileOf } from './call-numbers';

/**
 * Call speed (2026-11-19), from the calls' event logs only (types and times, never a word): per call path, how long the
 * caller waited after they stopped speaking.
 * - reply: until the assistant's reply started (its first audio: an acknowledgement counts, as the caller hears it);
 * - answer: on a turn that needed a lookup (a tool call, or a lookup run ahead), until the last reply of the turn started,
 *   the one after the result, which carries the answer.
 * The target is the owner's: reply median under 1.5 s and 90% under 2.5 s, on each path.
 */
export const SPEED_TARGET = { p50Ms: 1500, p90Ms: 2500 } as const;

const STOPPED = new Set(['input_audio_buffer.speech_stopped', 'vapi.caller.stopped']);
const STARTED = new Set(['input_audio_buffer.speech_started', 'vapi.caller.started']);
const REPLY = new Set(['output_audio_buffer.started', 'vapi.assistant.started']);
const LOOKUP = (type: string) => type === 'response.function_call_arguments.done' || type === 'vapi.tool_calls' || type.startsWith('lookahead.');

export interface SpeedCall { path: string; events: readonly Pick<CallEvent, 'type' | 'atMs'>[] }

export interface PathSpeed {
  path: string;
  calls: number;
  turns: number;
  reply: { n: number; p50: number | null; p90: number | null; under1500: number };
  answer: { n: number; p50: number | null; p90: number | null };
  /** Turns answered with a lookup run ahead of the reply, and acknowledgements said while one ran (path A). */
  lookahead: number;
  acks: number;
  met: boolean;
}

/** One call's turns: for each caller stop, the first reply start, and the last one when the turn needed a lookup. */
export function turnSpeeds(events: readonly Pick<CallEvent, 'type' | 'atMs'>[]): { reply: number[]; answer: number[]; lookahead: number; acks: number } {
  const ev = [...events].sort((a, b) => a.atMs - b.atMs);
  const out = { reply: [] as number[], answer: [] as number[], lookahead: 0, acks: 0 };
  for (let i = 0; i < ev.length; i++) {
    if (!STOPPED.has(ev[i]!.type)) continue;
    const at = ev[i]!.atMs;
    // the turn runs until the caller speaks again
    let end = ev.length;
    for (let j = i + 1; j < ev.length; j++) if (STARTED.has(ev[j]!.type) || STOPPED.has(ev[j]!.type)) { end = j; break; }
    const turn = ev.slice(i + 1, end);
    const replies = turn.filter((e) => REPLY.has(e.type));
    if (!replies.length) continue;
    out.reply.push(replies[0]!.atMs - at);
    if (turn.some((e) => e.type.startsWith('lookahead.'))) out.lookahead++;
    if (turn.some((e) => e.type === 'turn.ack')) out.acks++;
    if (turn.some((e) => LOOKUP(e.type))) out.answer.push(replies.at(-1)!.atMs - at);
  }
  return out;
}

/** The speed of each call path over these calls, paths in name order. */
export function callSpeed(calls: readonly SpeedCall[]): PathSpeed[] {
  const byPath = new Map<string, SpeedCall[]>();
  for (const c of calls) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  return [...byPath.keys()].sort().map((path) => {
    const t = byPath.get(path)!.map((c) => turnSpeeds(c.events));
    const reply = t.flatMap((x) => x.reply);
    const answer = t.flatMap((x) => x.answer);
    const p50 = percentileOf(reply, 0.5);
    const p90 = percentileOf(reply, 0.9);
    return {
      path, calls: byPath.get(path)!.length, turns: reply.length,
      reply: { n: reply.length, p50, p90, under1500: reply.filter((r) => r < SPEED_TARGET.p50Ms).length },
      answer: { n: answer.length, p50: percentileOf(answer, 0.5), p90: percentileOf(answer, 0.9) },
      lookahead: t.reduce((n, x) => n + x.lookahead, 0), acks: t.reduce((n, x) => n + x.acks, 0),
      met: p50 !== null && p90 !== null && p50 < SPEED_TARGET.p50Ms && p90 < SPEED_TARGET.p90Ms,
    };
  });
}

/** The speed as text lines, one block per path. */
export function formatCallSpeed(paths: readonly PathSpeed[]): string[] {
  const s = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(2)} s`);
  return paths.flatMap((p) => [
    `${p.path}: ${p.calls} calls, ${p.turns} replies timed`,
    `  reply start: median ${s(p.reply.p50)}, p90 ${s(p.reply.p90)}, under 1.5 s ${p.reply.under1500}/${p.reply.n}; target median < 1.5 s and p90 < 2.5 s: ${p.met ? 'MET' : 'NOT MET'}`,
    `  answer after a lookup: median ${s(p.answer.p50)}, p90 ${s(p.answer.p90)} over ${p.answer.n} turns; lookups run ahead ${p.lookahead}, acknowledgements ${p.acks}`,
  ]);
}
