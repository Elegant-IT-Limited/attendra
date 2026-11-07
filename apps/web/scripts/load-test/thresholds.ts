// SPDX-License-Identifier: AGPL-3.0-only
import { OPENING_NUDGE_MS, SILENCE_NUDGE_MS } from '@attendra/voice-engine';

/**
 * What a load test must meet to pass: every limit in one place. The times are the voice service's own, never a second
 * copy: a turn that runs past its first silence nudge is a stall (the caller spoke and heard nothing for that long), and
 * a call with no greeting by the opening nudge is one the service had to prod. docs/load-test.md says what each means.
 */
export const THRESHOLDS = {
  /** p90 of the time from the caller's last words to the assistant's next words, all turns. */
  turnP90Ms: SILENCE_NUDGE_MS[0],
  /** p90 of the time from the answer to the assistant's first audio (from db:call-stats; the API does not carry it). */
  firstAudioP90Ms: OPENING_NUDGE_MS,
  /** Calls that failed to start, never went live, or ended as dropped (the same test as the call_dropped alert). */
  droppedCalls: 0,
  /** Change streams that ended or failed while the test held them. */
  droppedStreams: 0,
  /** Answers of 429 to the dashboards: the per-session limit turned a page away. */
  rateLimited: 0,
  /** The busiest sample: every container's CPU together, as a share of the box's cores. */
  hostCpuShare: 0.7,
  /** Any one container's memory against its compose mem_limit, at its peak. */
  containerMemShare: 0.8,
} as const;
