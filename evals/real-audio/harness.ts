// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * The real-audio harness (batch 1a): a caller with a voice on a real browser test call. Every other eval reads the
 * conversation as text; this one speaks into the call (text-to-speech played into the browser's microphone) and times
 * what the caller would hear (the assistant's audio coming back), so turn-taking, interruptions, silence and the time to
 * an answer are measured as a person on the line meets them, on whichever engine the clinic is switched to.
 * This file holds the parts with no browser and no model: the scenarios, the turn clock, and the report.
 */

export const RealAudioScenario = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  language: z.enum(['en', 'es']).default('en'),
  /** What the caller says first. */
  opening: z.string().min(2),
  /** What the caller knows, for answering the assistant's questions (a model plays the caller from these). */
  facts: z.string().default(''),
  /** A fixed script instead of a model caller: said in order, one line per assistant turn. */
  lines: z.array(z.string()).optional(),
  /** The most caller lines before the call is ended by the harness. */
  maxTurns: z.number().int().min(1).max(30).default(12),
  /** Phrases the assistant must say at some point (case-insensitive), and must never say. */
  expect: z.object({ said: z.array(z.string()).default([]), never: z.array(z.string()).default([]) }).default({ said: [], never: [] }),
});
export type RealAudioScenario = z.infer<typeof RealAudioScenario>;

export const RealAudioFile = z.object({ clinic: z.string().default('riverbend'), voice: z.string().default('ash'), scenarios: z.array(RealAudioScenario).min(1) });

/** How quiet "quiet" is: the assistant's audio level below this for QUIET_MS means it has finished its turn. */
export const SILENCE_LEVEL = 0.012;
export const QUIET_MS = 1200;
/** The longest the caller waits for a reply before it counts as a stall and the caller speaks again ("hello?"). */
export const STALL_MS = 8000;
/** Filler said instead of an answer, in either language. */
export const FILLER = /\b(still (checking|working|looking)|one moment|let me (check|look|see)|just a (moment|second)|un momento|d[eé]jeme (revisar|ver|buscar)|sigo (revisando|buscando))\b/i;

/** One exchange: the caller's line, when its audio ended, when the assistant's audio came back, and what it said. */
export interface Turn {
  caller: string;
  callerEndAt: number;
  /** When the caller first heard the assistant after their line: its audio, not its captions. Null: nothing came back. */
  heardAt: number | null;
  /** The assistant spoke before the caller's line had finished (talked over them). */
  overlapped: boolean;
  agent: string;
}

export interface CallResult {
  scenario: string; engine: string | null; callId: string | null; firstAudioMs: number | null;
  turns: Turn[]; stalls: number; fillerLines: number; repeatedQuestions: number; missing: string[]; forbidden: string[];
  ended: 'caller' | 'assistant' | 'harness' | 'failed'; error?: string;
}

/** Waits that are measured: the caller's last word to the first sound of the reply, for each turn that got one. */
export const replyMs = (r: CallResult) => r.turns.flatMap((t) => (t.heardAt !== null ? [t.heardAt - t.callerEndAt] : []));

const normQ = (s: string) => s.toLowerCase().replace(/[\p{N}]+/gu, '#').replace(/[^\p{L}#?\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The checks on what was said: filler lines, questions asked twice, phrases expected and phrases forbidden. */
export function judgeWords(s: RealAudioScenario, agentLines: string[]) {
  const all = agentLines.join(' ').toLowerCase();
  const asked = new Set<string>();
  let repeatedQuestions = 0;
  for (const line of agentLines) {
    for (const q of line.match(/[^.!?]*\?/g) ?? []) {
      const n = normQ(q);
      if (n.length < 12) continue;
      if (asked.has(n)) repeatedQuestions++; else asked.add(n);
    }
  }
  return {
    fillerLines: agentLines.filter((l) => FILLER.test(l)).length,
    repeatedQuestions,
    missing: s.expect.said.filter((p) => !all.includes(p.toLowerCase())),
    forbidden: s.expect.never.filter((p) => all.includes(p.toLowerCase())),
  };
}

export const percentile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!;
};

/** The run as a report: one table row per call, then the totals a batch's before/after compares. Made-up callers only. */
export function report(results: CallResult[], meta: { startedAt: Date; base: string; clinic: string; engine: string | null }): string {
  const waits = results.flatMap(replyMs);
  const lines = [
    `# Real-audio run ${meta.startedAt.toISOString()}`,
    '',
    `Dashboard ${meta.base}, clinic ${meta.clinic}, engine ${meta.engine ?? 'as the clinic is set'}. ${results.length} calls.`,
    '',
    '| Call | Turns | Reply ms median / p90 / max | First audio ms | Stalls | Filler | Repeated Q | Talked over | Expected missing | Forbidden said | Ended |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const w = replyMs(r);
      return `| ${r.scenario} | ${r.turns.length} | ${w.length ? `${percentile(w, 0.5)} / ${percentile(w, 0.9)} / ${Math.max(...w)}` : '-'} | ${r.firstAudioMs ?? '-'} | ${r.stalls} | ${r.fillerLines} | ${r.repeatedQuestions} | ${r.turns.filter((t) => t.overlapped).length} | ${r.missing.join('; ') || '-'} | ${r.forbidden.join('; ') || '-'} | ${r.ended}${r.error ? ` (${r.error})` : ''} |`;
    }),
    '',
    `**All calls:** reply ms median ${percentile(waits, 0.5) ?? '-'}, p90 ${percentile(waits, 0.9) ?? '-'} (n=${waits.length}); first audio median ${percentile(results.flatMap((r) => (r.firstAudioMs === null ? [] : [r.firstAudioMs])), 0.5) ?? '-'} ms; stalls ${results.reduce((n, r) => n + r.stalls, 0)}; filler lines ${results.reduce((n, r) => n + r.fillerLines, 0)}; repeated questions ${results.reduce((n, r) => n + r.repeatedQuestions, 0)}; failed ${results.filter((r) => r.ended === 'failed').length}.`,
    '',
    'Reply ms is from the end of the caller\'s audio to the first sound of the assistant\'s reply, measured in the browser: what a caller hears. The call ids are in the JSON file next to this one; `pnpm db:call-stats` reads the same calls from the database.',
  ];
  return lines.join('\n');
}
