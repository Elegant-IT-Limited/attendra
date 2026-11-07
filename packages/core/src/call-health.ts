// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a call sounded to the caller, as numbers the voice service measures and the call
 * row keeps (migration 0044): when they first heard the assistant, how often they waited
 * in silence, and how often an answer ran past its limit. No words, no numbers.
 */
export interface CallQuality {
  /** Milliseconds from the answer to the assistant's first audio; null when the caller never heard it. */
  firstAudioMs: number | null;
  /** Caller turns met by 5 s of silence with nothing coming back. */
  stalls: number;
  /** Answers past the 60 s limit, apologised for. */
  answerTimeouts: number;
}

/**
 * The outcome a call is recorded with. A call the caller never heard the assistant on is
 * `no_audio`, whatever else it would have been called: before 0044 those were "No action",
 * and nobody could tell an empty line from a caller who simply hung up.
 */
export function recordedOutcome(outcome: string, q: Pick<CallQuality, 'firstAudioMs'>): string {
  return q.firstAudioMs === null && outcome === 'abandoned' ? 'no_audio' : outcome;
}

/**
 * A line with nothing on it worth an alert: the caller hung up before a greeting could have
 * reached them. Longer than this with no audio, the line was empty and somebody heard nothing.
 */
export const EMPTY_CALL_MIN_MS = 4000;

/** One call as the daily digest sees it. */
export interface DigestCall {
  clinicId: string;
  channel: 'phone' | 'web';
  outcome: string | null;
  closeReason: string | null;
  firstAudioMs: number | null;
  stalls: number | null;
  answerTimeouts: number | null;
  ended: boolean;
}

/** A call that dropped instead of ending: the same test as the voice service's call_dropped alert (and the load test's). */
export const isDropped = (r: string | null) => !!r && (r === 'connection_lost' || r === 'error' || r.startsWith('socket closed'));

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const secs = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);

/**
 * The daily digest for the people who run Attendra: one Slack message with the last day's
 * calls and their trouble, counts and clinic ids only. Empty lines, stalls, answers past the
 * limit and dropped calls each get a count and the clinics they happened at; a quiet day says so.
 */
export function dailyDigest(calls: DigestCall[], hours = 24): string {
  const phone = calls.filter((c) => c.channel === 'phone').length;
  const web = calls.length - phone;
  const ended = calls.filter((c) => c.ended);
  const noAudio = ended.filter((c) => c.outcome === 'no_audio');
  const stalled = ended.filter((c) => (c.stalls ?? 0) > 0);
  const stalls = stalled.reduce((n, c) => n + (c.stalls ?? 0), 0);
  const timedOut = ended.filter((c) => (c.answerTimeouts ?? 0) > 0);
  const timeouts = timedOut.reduce((n, c) => n + (c.answerTimeouts ?? 0), 0);
  const dropped = ended.filter((c) => isDropped(c.closeReason));
  const firstAudio = ended.map((c) => c.firstAudioMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const where = (list: DigestCall[]) => {
    const by = new Map<string, number>();
    for (const c of list) by.set(c.clinicId, (by.get(c.clinicId) ?? 0) + 1);
    return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ');
  };
  const lines = [
    `Daily digest, last ${hours} h: ${calls.length} call${calls.length === 1 ? '' : 's'} (${phone} phone, ${web} browser test), ${calls.length - ended.length} still open.`,
  ];
  if (!calls.length) return `${lines[0]} Nothing to report.`;
  lines.push(`First audio: median ${secs(percentile(firstAudio, 50))}, p90 ${secs(percentile(firstAudio, 90))} (${firstAudio.length} calls measured).`);
  const trouble: [string, DigestCall[]][] = [
    [`No audio (the caller heard nothing): ${noAudio.length}`, noAudio],
    [`Stalls (5 s of silence after the caller spoke): ${stalls} in ${stalled.length} call${stalled.length === 1 ? '' : 's'}`, stalled],
    [`Answers past the 60 s limit: ${timeouts} in ${timedOut.length} call${timedOut.length === 1 ? '' : 's'}`, timedOut],
    [`Dropped before the end: ${dropped.length}`, dropped],
  ];
  for (const [text, list] of trouble) lines.push(list.length ? `${text} (${where(list)}).` : `${text}.`);
  if (!noAudio.length && !stalled.length && !timedOut.length && !dropped.length) lines.push('No empty lines, stalls, timeouts or drops.');
  return lines.join('\n');
}
