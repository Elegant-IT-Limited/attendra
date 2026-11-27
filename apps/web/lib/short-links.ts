// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The short addresses a person types or bookmarks (QA-1109-2) and the clinic page each opens: /calls is
 * /c/<clinic>/calls. Today is the clinic's home. Only the main pages, by the names the menu uses.
 */
export const SHORT_PAGES: Readonly<Record<string, string>> = {
  today: '', calls: 'calls', schedule: 'schedule', requests: 'requests', patients: 'patients', texts: 'texts',
  doctors: 'doctors', team: 'team', settings: 'settings', quality: 'quality', audit: 'audit',
};

/** The clinic page a short address opens, in this clinic. */
export const clinicPathOf = (clinicId: string, short: string) => `/c/${clinicId}${SHORT_PAGES[short] ? `/${SHORT_PAGES[short]}` : ''}`;

/**
 * Where a short address goes, for what /me answered: signed out (401), sign-in, which comes back to it; a password to
 * change or two-step sign-in to set up first (403), the home page, which takes them through it and then to the page
 * (`next`, kept for after); signed in, the page in the clinic last opened here, else the first; no clinic yet, home;
 * the server failing, `failed` (the page says so, with Try again).
 */
export function shortLinkStep(short: string, status: number, clinics: { id: string }[] = [], lastClinic: string | null = null):
  { go: string; next?: string } | { failed: true } {
  if (status === 401) return { go: `/sign-in?next=${encodeURIComponent(`/${short}`)}` };
  if (status >= 500) return { failed: true };
  if (status >= 400) return { go: '/', next: `/${short}` };
  const clinic = clinics.find((c) => c.id === lastClinic) ?? clinics[0];
  return { go: clinic ? clinicPathOf(clinic.id, short) : '/' };
}
