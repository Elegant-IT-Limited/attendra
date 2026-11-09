// SPDX-License-Identifier: AGPL-3.0-only
import type { TestCallAllowance } from '@attendra/api/contracts';

/** "15 minutes", "1 minute", "less than a minute": whole minutes, rounded down so the page never promises more. */
export function minutesText(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m < 1 ? 'less than a minute' : m === 1 ? '1 minute' : `${m} minutes`;
}

/**
 * The clinic's test-call time left, the one way every page writes it: "128 min 41 s left", "15 min left", "41 s left".
 * Whole seconds, rounded down, so it never promises more than the server gives. The cloud's setup page says the same.
 */
export function testTimeLeft(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${[m ? `${m} min` : '', r || !m ? `${r} s` : ''].filter(Boolean).join(' ')} left`;
}

/** The line under the Test call button: the clinic's test time left, from the API's allowance. */
export const testTimeLeftLine = (seconds: number) => (seconds <= 0 ? 'No test-call time left.' : `Test calls: ${testTimeLeft(seconds)}`);

type Limits = Pick<TestCallAllowance, 'perCallSeconds' | 'callSeconds'>;

/** The clinic's test time left is shorter than one call, so that is what the next call gets. */
export function limitIsTimeLeft(allowance: Limits | undefined): boolean {
  return allowance?.perCallSeconds != null && allowance.callSeconds != null && allowance.callSeconds < allowance.perCallSeconds;
}

/**
 * What the Test call page says before a call, from the API's allowance only: the voice service's limit for
 * one call, or the clinic's test time left when that is less. No number of its own.
 */
export function testCallLimitLabel(allowance: Limits | undefined): string {
  const { perCallSeconds, callSeconds } = allowance ?? { perCallSeconds: null, callSeconds: null };
  if (perCallSeconds === null || callSeconds === null) return 'A test call stops on its own at its time limit.';
  if (limitIsTimeLeft(allowance)) return `Test calls: ${testTimeLeft(callSeconds)}`;
  return `One test call can last up to ${minutesText(perCallSeconds)}`;
}
