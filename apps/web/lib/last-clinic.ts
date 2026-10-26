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

/** The clinic to open: the last one, if it is still among the person's clinics, else the first. */
export function clinicToOpen<T extends { id: string }>(clinics: T[]): T | undefined {
  let last: string | null = null;
  try {
    last = localStorage.getItem(KEY);
  } catch { /* storage off */ }
  return clinics.find((c) => c.id === last) ?? clinics[0];
}
