// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "Now" for the test code itself. With E2E_CLOCK (playwright.config.ts) the demo API and every page run
 * E2E_CLOCK_OFFSET milliseconds from the real clock, but the test runner does not: a spec that reads the real
 * clock for "today", a clinic's hour or a two-step code disagrees with the app it checks. Every date a spec
 * reasons about comes from here; ids and timeouts may keep the real clock.
 */
export const testNow = () => Date.now() + Number(process.env.E2E_CLOCK_OFFSET ?? 0);
/** `new Date()`, on the suite's clock. */
export const testDate = (plusMs = 0) => new Date(testNow() + plusMs);
