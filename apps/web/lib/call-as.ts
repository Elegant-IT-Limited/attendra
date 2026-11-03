// SPDX-License-Identifier: AGPL-3.0-only
import type { CallAs } from '@attendra/api/contracts';
import { PHONE_NUMBERS_ONLY } from '@attendra/core';

export type { CallAs };

/** Today's browser test call: no caller ID. */
export const NO_CALLER_ID: CallAs = { kind: 'none' };

/** Why the API refused a "Call as" choice, said plainly. */
export const CALL_AS_FAILURES: Record<string, string> = {
  invalid_request: `That number could not be used. ${PHONE_NUMBERS_ONLY}`,
  not_found: 'That number is no longer in this clinic\'s records. Pick another, or type it.',
  forbidden: 'Your role cannot start a test call as a number from the records. Type the number instead.',
};

/** The badge on a browser test call, on the calls list and the call's page: the last four digits come from the server. */
export const testCallBadge = (calledAsLast4: string | null | undefined) =>
  calledAsLast4 ? `Browser test, called as …ending ${calledAsLast4}` : 'Browser test';
