// SPDX-License-Identifier: AGPL-3.0-only
import type { Me } from '@attendra/api/contracts';

interface InvitationShape {
  clinicName: string;
  organizationName: string;
  role: string;
  locations: { id: string; name: string }[];
  allLocations: boolean;
}

/** The role's name, as /me serves it (one source with the permissions). */
export const roleName = (role: string, roles: Me['roles'] | undefined) => roles?.find((r) => r.id === role)?.label ?? role;

/**
 * What an invitation says, the same on the banner, the invitation page and the email:
 * "Maple Street invited you as Front desk." / "Maple Vets invited you as Front desk at 3
 * locations: North, South and West." / "Maple Vets invited you as Owner, for every location."
 */
export function invitationLine(i: InvitationShape, roles: Me['roles'] | undefined): string {
  const role = roleName(i.role, roles);
  if (i.role === 'owner') return `${i.organizationName} invited you as ${role}, for every location.`;
  if (i.locations.length > 1) return `${i.organizationName} invited you as ${role} at ${i.locations.length} locations: ${listOf(i.locations.map((l) => l.name))}.`;
  return `${i.clinicName} invited you as ${role}.`;
}

const listOf = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
