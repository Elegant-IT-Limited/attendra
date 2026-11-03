// SPDX-License-Identifier: AGPL-3.0-only
import type { TestCallAllowance } from '@attendra/api/contracts';

/** "15 minutes", "1 minute", "less than a minute": whole minutes, rounded down so the page never promises more. */
export function minutesText(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m < 1 ? 'less than a minute' : m === 1 ? '1 minute' : `${m} minutes`;
}

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
  if (limitIsTimeLeft(allowance)) return `You have ${minutesText(callSeconds)} of test calls left`;
  return `One test call can last up to ${minutesText(perCallSeconds)}`;
}
