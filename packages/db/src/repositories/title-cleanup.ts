// SPDX-License-Identifier: AGPL-3.0-only
import { bareName, ClinicConfig } from '@attendra/core';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { clinics } from '../schema';

export interface TitleCleanup {
  clinics: number;
  /** Clinics whose settings change. */
  settings: number;
  /** Providers whose name had a title typed before it ("Dr. Elena Ruiz"), now stored without it. */
  stripped: number;
  /** People at a clinic for animals with no title set, now "dr" ("none" when the typed title was Mr, Mrs, Ms or Miss). */
  titled: number;
}

const NOT_A_DOCTOR = /^\s*(?:mr|mrs|ms|miss)\.?\s+/i;

/**
 * "Dr." is built in (2026-11): names are stored without a title, and each person has a title choice. Once per clinic:
 * a name typed with a title loses it (and its Spanish name too), and a person at a vet clinic without a title gets "dr",
 * or "none" when what was typed was Mr, Mrs, Ms or Miss. Rooms are left alone. Counts only; `apply` writes. Safe to run again.
 */
export async function cleanTitles(db: Database, opts: { apply: boolean }): Promise<TitleCleanup> {
  const rows = await db.select({ id: clinics.id, config: clinics.config }).from(clinics);
  const out: TitleCleanup = { clinics: rows.length, settings: 0, stripped: 0, titled: 0 };
  for (const row of rows) {
    const parsed = ClinicConfig.safeParse(row.config);
    if (!parsed.success) continue;
    const config = parsed.data;
    let changed = false;
    const providers = config.providers.map((p) => {
      const name = bareName(p.name);
      const names = p.names ? Object.fromEntries(Object.entries(p.names).map(([l, n]) => [l, n ? bareName(n) : n])) : undefined;
      const stripped = name !== p.name.trim() || JSON.stringify(names) !== JSON.stringify(p.names);
      const title = p.kind === 'person' && !p.title && config.industry === 'vet' ? (NOT_A_DOCTOR.test(p.name) ? 'none' as const : 'dr' as const) : p.title;
      if (stripped) out.stripped++;
      if (title !== p.title) out.titled++;
      if (!stripped && title === p.title) return p;
      changed = true;
      return { ...p, name, ...(names ? { names } : {}), ...(title ? { title } : {}) };
    });
    if (!changed) continue;
    out.settings++;
    if (opts.apply) {
      await db.update(clinics).set({ config: { ...config, providers }, configVersion: sql`${clinics.configVersion} + 1`, configUpdatedAt: new Date(), configUpdatedBy: 'provisioning' }).where(eq(clinics.id, row.id));
    }
  }
  return out;
}
