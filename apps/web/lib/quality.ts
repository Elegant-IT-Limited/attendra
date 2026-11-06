// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Quality page's line about the browser test calls it left out, with the count
 * the server sent, singular or plural: "1 browser test call this week is left out."
 * Null when there were none, so nothing is said about nothing.
 */
export function testCallsLeftOut(n: number): string | null {
  if (n <= 0) return null;
  return `${n} browser test call${n === 1 ? '' : 's'} this week ${n === 1 ? 'is' : 'are'} left out. Quality counts real phone calls only.`;
}
