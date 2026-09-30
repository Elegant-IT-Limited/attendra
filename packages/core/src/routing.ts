// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig, TransferTarget } from './clinic';
import { isOpen } from './hours';

export type TransferResolution =
  | { ok: true; uri: string }
  | { ok: false; reason: 'no_rule' | 'closed' };

/**
 * Which number a transfer goes to right now. Rules are matched by target and by
 * whether the clinic is open; the highest priority wins. "closed" means a rule
 * exists but only for the other half of the day, so the agent should offer a
 * callback instead of dead air.
 */
export function resolveTransfer(clinic: ClinicConfig, target: TransferTarget, at: Date): TransferResolution {
  const rules = clinic.routing.filter((r) => r.target === target);
  if (!rules.length) return { ok: false, reason: 'no_rule' };
  const open = isOpen(clinic, at);
  const live = rules
    .filter((r) => r.when === 'always' || (r.when === 'open') === open)
    .sort((a, b) => b.priority - a.priority);
  const pick = live[0];
  return pick ? { ok: true, uri: pick.uri } : { ok: false, reason: 'closed' };
}

// ITU country calling codes that are one or two digits long; every other code is three
const ONE_DIGIT = ['1', '7'];
const TWO_DIGITS = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98']);

/** The country calling code of an E.164 number: "1" for +13035550100, "880" for +8801000000100. */
export function callingCode(e164: string): string | null {
  const digits = /^\+(\d{8,15})$/.exec(e164.replace(/^tel:/, ''))?.[1];
  if (!digits) return null;
  if (ONE_DIGIT.includes(digits[0]!)) return digits[0]!;
  return TWO_DIGITS.has(digits.slice(0, 2)) ? digits.slice(0, 2) : digits.slice(0, 3);
}

/** Whether a number is in the same country as the clinic's own first number. */
export function inClinicCountry(clinic: { phoneNumbers: string[] }, e164: string): boolean {
  const code = callingCode(e164);
  return !!code && code === callingCode(clinic.phoneNumbers[0] ?? '');
}

/** The last four digits of a number, for an audit row: enough to recognise it, not to ring it. */
export const lastFour = (number: string) => number.replace(/\D/g, '').slice(-4);
