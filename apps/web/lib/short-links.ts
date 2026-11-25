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
