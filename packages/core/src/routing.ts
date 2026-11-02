// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig, TransferTarget } from './clinic';
import { isOpen } from './hours';
import { callingCode, samePhone } from './phones';


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

/**
 * Where a VIP caller goes, if this caller is one and someone can take them now: the
 * front desk's number for this moment. Null for anyone else, or when the front desk
 * takes no transfers now (the assistant answers, as for any caller). Numbers are
 * compared as E.164, so +1 (303) 555-0100 and 3035550100 match.
 */
export function vipRoute(clinic: ClinicConfig, from: string | null, at: Date): { name: string; uri: string } | null {
  if (!from || from.replace(/\D/g, '').length < 7) return null;
  const vip = clinic.vipCallers?.find((v) => samePhone(v.phone, from, clinic));
  if (!vip) return null;
  const route = resolveTransfer(clinic, 'front_desk', at);
  return route.ok ? { name: vip.name, uri: route.uri } : null;
}

// +1 area codes outside the US and Canada (the Caribbean and Bermuda), where premium-rate
// text fraud is common, plus premium and toll-free codes no text should go to
const NANP_NOT_TEXTED = new Set(['242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784', '809', '829', '849', '868', '869', '876', '900',
  '800', '833', '844', '855', '866', '877', '888']);

/**
 * Whether a text may go to this number from this clinic: a number in the clinic's own
 * country, and in North America a US or Canadian one that is not premium or toll-free.
 * Texts to anywhere else are how texting fraud runs up a bill, so they never go.
 */
export function textableNumber(clinic: { phoneNumbers: string[] }, e164: string): boolean {
  if (!inClinicCountry(clinic, e164)) return false;
  return callingCode(e164) !== '1' || !NANP_NOT_TEXTED.has(e164.slice(2, 5));
}

/** Whether a number is in the same country as the clinic's own first number. */
export function inClinicCountry(clinic: { phoneNumbers: string[] }, e164: string): boolean {
  const code = callingCode(e164);
  return !!code && code === callingCode(clinic.phoneNumbers[0] ?? '');
}

/** The last four digits of a number, for an audit row: enough to recognise it, not to ring it. */
export const lastFour = (number: string) => number.replace(/\D/g, '').slice(-4);
