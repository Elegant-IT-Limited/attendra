// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The clinic last opened in this browser, so the dashboard's home (after signing in, or
 * back from an account page) opens it again instead of the first one in the list. Used
 * only while the person still belongs to it.
 */
const KEY = 'attendra.lastClinic';

export function rememberClinic(clinicId: string) {
  try {
    localStorage.setItem(KEY, clinicId);
  } catch { /* storage off: home opens the first clinic, as before */ }
}

/** The clinic last opened in this browser, or null (none, or storage off). */
export function lastClinic(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // storage off
  }
}

/** The clinic to open: the last one, if it is still among the person's clinics, else the first. */
export function clinicToOpen<T extends { id: string }>(clinics: T[]): T | undefined {
  const last = lastClinic();
  return clinics.find((c) => c.id === last) ?? clinics[0];
}
