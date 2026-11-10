// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Money that runs out stops calls: these tell an error that means "out of credit" from any other, so it pages
 * (openai_quota, vapi_credit_low) instead of reading as one more failed call.
 */

/** OpenAI's codes for a project or account with no credit left, or billing turned off. A rate limit is not one. */
const OPENAI_QUOTA_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active']);
const OPENAI_QUOTA_WORDS = /insufficient_quota|billing_hard_limit_reached|billing_not_active|exceeded your current quota/i;

/**
 * True when an error from OpenAI (an SDK error, a fetch error with the body in its message, or a realtime `error`
 * event's `error`) says the credit or quota is used up. Looks at `code` and `type`, nested `error`, and the message.
 */
export function isOpenAiQuotaError(e: unknown, depth = 0): boolean {
  if (e == null || depth > 3) return false;
  if (typeof e === 'string') return OPENAI_QUOTA_WORDS.test(e);
  if (typeof e !== 'object') return false;
  const o = e as { code?: unknown; type?: unknown; message?: unknown; error?: unknown };
  for (const v of [o.code, o.type]) if (typeof v === 'string' && OPENAI_QUOTA_CODES.has(v)) return true;
  if (typeof o.message === 'string' && OPENAI_QUOTA_WORDS.test(o.message)) return true;
  return o.error !== undefined && o.error !== e && isOpenAiQuotaError(o.error, depth + 1);
}

/**
 * Vapi's end reasons for a call it would not start for money (docs.vapi.ai/calls/call-ended-reason): no credit, a
 * subscription frozen after a failed payment, or no wallet. Vapi has no API to read the credit itself (2026-11-10),
 * so this is how we hear it ran out.
 */
const VAPI_CREDIT_ENDS = new Set([
  'call.start.error-subscription-insufficient-credits',
  'call.start.error-subscription-frozen',
  'call.start.error-subscription-wallet-does-not-exist',
]);

export const isVapiCreditEnd = (reason: string | undefined | null): boolean => !!reason && VAPI_CREDIT_ENDS.has(reason);

/** A Vapi call that ended because OpenAI's quota ran out (Vapi's `*-429-exceeded-quota` with an OpenAI provider). */
export const isVapiOpenAiQuotaEnd = (reason: string | undefined | null): boolean =>
  !!reason && /openai/i.test(reason) && /exceeded-quota/i.test(reason);
