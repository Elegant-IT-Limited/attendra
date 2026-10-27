// SPDX-License-Identifier: AGPL-3.0-only
/** A clinic the person works at, with their role there in words ("Owner", "Front desk"), and the business it belongs to. */
export interface SwitcherClinic { id: string; name: string; role: string; organizationId?: string; organizationName?: string }

/** A business and its clinics, for the menu: a business with one clinic is just that clinic's row. */
export interface SwitcherGroup { id: string; name: string | null; clinics: SwitcherClinic[] }

/**
 * Groups the clinics by business, in the order given (the API sorts by business, then clinic). A business with two
 * or more clinics gets a header with its locations under it; one with a single clinic, or a clinic with no business
 * known, stays a row of its own with no header.
 */
export function groupClinics(clinics: SwitcherClinic[]): SwitcherGroup[] {
  const groups: SwitcherGroup[] = [];
  for (const c of clinics) {
    const last = groups.at(-1);
    if (c.organizationId && last?.id === c.organizationId) { last.clinics.push(c); continue; }
    groups.push({ id: c.organizationId ?? c.id, name: c.organizationName ?? null, clinics: [c] });
  }
  return groups.map((g) => (g.clinics.length > 1 ? g : { ...g, name: null }));
}

/** What the button says: "Lake View · Downtown" for a location of a business with several, else the clinic's name. */
export function switcherTitle(current: SwitcherClinic, clinics: SwitcherClinic[]): string {
  const siblings = current.organizationId ? clinics.filter((c) => c.organizationId === current.organizationId) : [];
  return siblings.length > 1 && current.organizationName && current.organizationName !== current.name ? `${current.organizationName} · ${current.name}` : current.name;
}
