// SPDX-License-Identifier: AGPL-3.0-only
import { bookableProviders, ClinicConfig, visitTypeCoverage } from '@attendra/core';
import type { Database } from '../client';
import { clinics } from '../schema';

/**
 * One clinic's visit types, by their place in Settings (1 is the first): never a name or an id, which are the
 * clinic's own words. `vets` counts the providers a caller can be offered, rooms included.
 */
export interface ClinicVisitTypeCoverage {
  clinicId: string;
  industry: string;
  vets: number;
  /** For each visit type in Settings' order, how many of them do it. */
  perType: number[];
  /** The places (1-based) of the visit types nobody does: nobody can book them. */
  noVet: number[];
}

/** Counts per clinic, from the settings as they are. Read-only (2026-11-15): there is nothing to apply. */
export function coverageOf(clinicId: string, config: ClinicConfig): ClinicVisitTypeCoverage {
  const perType = visitTypeCoverage(config).map((c) => c.providers);
  return {
    clinicId, industry: config.industry ?? 'clinic', vets: bookableProviders(config.providers).length, perType,
    noVet: perType.flatMap((n, i) => (n ? [] : [i + 1])),
  };
}

/** Every clinic whose settings load; one that doesn't is counted, never guessed at. */
export async function visitTypeCoverageReport(db: Database): Promise<{ clinics: ClinicVisitTypeCoverage[]; unreadable: number }> {
  const rows = await db.select({ id: clinics.id, config: clinics.config }).from(clinics).orderBy(clinics.id);
  const out: ClinicVisitTypeCoverage[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const parsed = ClinicConfig.safeParse(row.config);
    if (parsed.success) out.push(coverageOf(row.id, parsed.data));
    else unreadable++;
  }
  return { clinics: out, unreadable };
}

/** The printout: clinic ids and counts only. */
export function formatVisitTypeCoverage(r: { clinics: ClinicVisitTypeCoverage[]; unreadable: number }): string[] {
  const lines = r.clinics.map((c) => [`clinic ${c.clinicId}`, c.industry, `vets ${c.vets}`, `visit types ${c.perType.length}`,
    `vets per type ${c.perType.map((n, i) => `#${i + 1}=${n}`).join(' ') || 'none'}`,
    c.noVet.length ? `no vet for ${c.noVet.length}: ${c.noVet.map((i) => `#${i}`).join(' ')}` : 'every type has a vet'].join(' · '));
  const short = r.clinics.filter((c) => c.noVet.length);
  lines.push(`visit-type coverage: ${short.length} of ${r.clinics.length} clinics have a type no vet does (${short.reduce((n, c) => n + c.noVet.length, 0)} types)`
    + `${r.unreadable ? ` · ${r.unreadable} clinics' settings did not load` : ''} (dry run, nothing written)`);
  return lines;
}
