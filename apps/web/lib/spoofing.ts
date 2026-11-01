// SPDX-License-Identifier: AGPL-3.0-only
import type { CallSummary } from '@attendra/api/contracts';

export const SPOOFING_DOC = 'https://github.com/Elegant-IT-Limited/attendra/blob/main/docs/caller-id-spoofing.md';
/** Of the last 30 phone calls, this many short first calls from new numbers is the sign the number is being spoofed elsewhere. */
export const SPOOFED_SIGN = 5;
/**
 * Of the last 30 phone calls, how many were a number's first call and lasted 20 seconds or less: callers returning a
 * missed call that never came from here, who hang up on the greeting (a test clinic, 2026-10).
 */
export const shortFirstCalls = (calls: Pick<CallSummary, 'channel' | 'firstCall' | 'voiceSeconds'>[]) =>
  calls.filter((c) => c.channel === 'phone').slice(0, 30).filter((c) => c.firstCall && (c.voiceSeconds ?? 0) <= 20).length;
