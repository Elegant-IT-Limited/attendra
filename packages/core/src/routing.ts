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
