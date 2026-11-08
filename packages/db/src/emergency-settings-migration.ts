// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm db:emergency-settings` (batch 1b, extended in batch 1e): the one place that still reads a vet clinic's older
// emergency fields (`emergencyHospital`, `moreEmergencyHospitals`, and the on-call routing an older clinic transferred
// emergencies to). It folds them into `emergencies`, the only source of the route, then removes them from the stored
// configuration. Nothing else in the engine reads them; a test fails if anything does.
import { ClinicConfig, type EmergencyHospital, emergencyHospitalsOf, type EmergencySettings, MORE_HOSPITALS_MAX } from '@attendra/core';
import { eq, sql } from 'drizzle-orm';
import { type Database, setClinicScope } from './client';
import { auditLogs, clinics } from './schema';

/** The keys the fold removes from a stored configuration. */
export const LEGACY_EMERGENCY_KEYS = ['emergencyHospital', 'moreEmergencyHospitals'] as const;

const same = (a: EmergencyHospital, b: EmergencyHospital) => a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && a.phone === b.phone;

/** What the fold does to one clinic, as counts only: never a name or a number. */
export interface EmergencyFold {
  /** `written`: a setting made from the old fields; `kept`: the clinic's own setting stays; `none`: nothing to make one from. */
  setting: 'written' | 'kept' | 'none';
  mode: EmergencySettings['mode'] | 'none';
  /** Hospitals in the setting after the fold: the mode's own, and the next choices. */
  hospitals: number;
  more: number;
  /** Old hospitals moved into `moreHospitals` of a setting the clinic already had. */
  moved: number;
  /** Old hospitals that could not be kept (over the limit, or a setting with no hospital to follow). */
  dropped: number;
  /** Old keys removed from the stored configuration. */
  removed: number;
}

/**
 * The clinic's configuration with its older emergency fields folded into `emergencies` and removed. A clinic without a
 * setting gets what its fields meant: an on-call line it transferred emergencies to is `handle` (its highest-priority
 * phone line, at any hour; its first hospital the backup, the rest next), a hospital alone is `refer` (the rest next).
 * A clinic with a setting keeps it; its old hospitals go into `moreHospitals` only while that is empty.
 */
export function foldLegacyEmergencies(config: ClinicConfig): { config: ClinicConfig; fold: EmergencyFold } {
  const legacy = [config.emergencyHospital, ...(config.moreEmergencyHospitals ?? [])].filter((h): h is EmergencyHospital => !!h);
  const removed = LEGACY_EMERGENCY_KEYS.filter((k) => config[k] !== undefined).length;
  const next: ClinicConfig = { ...config };
  for (const k of LEGACY_EMERGENCY_KEYS) delete next[k];
  const count = (e: EmergencySettings | undefined) => ({ hospitals: emergencyHospitalsOf(e).length, more: e?.moreHospitals?.length ?? 0 });

  if (config.emergencies) {
    const e = config.emergencies;
    const own = emergencyHospitalsOf(e);
    const fresh = legacy.filter((h) => !own.some((x) => same(x, h)));
    // a setting with no hospital of its own (handle with no backup) has none for more hospitals to follow
    const room = e.moreHospitals?.length || !own.length ? 0 : MORE_HOSPITALS_MAX;
    const moved = fresh.slice(0, room);
    const emergencies: EmergencySettings = moved.length ? { ...e, moreHospitals: moved } : e;
    return { config: { ...next, emergencies }, fold: { setting: 'kept', mode: e.mode, ...count(emergencies), moved: moved.length, dropped: fresh.length - moved.length, removed } };
  }

  const onCall = config.emergencyTransferEnabled
    ? [...config.routing].filter((r) => r.target === 'on_call' && /^tel:\+[1-9]\d{7,14}$/.test(r.uri)).sort((a, b) => b.priority - a.priority)[0]
    : undefined;
  const [first, ...rest] = legacy;
  const more = rest.slice(0, MORE_HOSPITALS_MAX);
  const withMore = more.length ? { moreHospitals: more } : {};
  const emergencies: EmergencySettings | undefined = onCall
    ? { mode: 'handle', number: onCall.uri.slice(4), ...(first ? { backupHospital: first, ...withMore } : {}) }
    : first ? { mode: 'refer', hospital: first, ...withMore } : undefined;
  if (!emergencies) return { config: next, fold: { setting: 'none', mode: 'none', hospitals: 0, more: 0, moved: 0, dropped: legacy.length, removed } };
  return { config: { ...next, emergencies }, fold: { setting: 'written', mode: emergencies.mode, ...count(emergencies), moved: 0, dropped: rest.length - more.length, removed } };
}

/**
 * Every vet clinic's fold, as counts per clinic id. `apply: false` (the default) changes nothing; `apply: true` writes
 * each clinic whose stored configuration changes, with an audit row.
 */
export async function writeEmergencySettings(db: Database, opts: { apply: boolean }): Promise<({ clinic: string; action: 'written' | 'would write' | 'unchanged' } & EmergencyFold)[]> {
  const rows = await db.select({ id: clinics.id, config: clinics.config }).from(clinics);
  const out: ({ clinic: string; action: 'written' | 'would write' | 'unchanged' } & EmergencyFold)[] = [];
  for (const row of rows) {
    const parsed = ClinicConfig.safeParse(row.config);
    if (!parsed.success || parsed.data.industry !== 'vet') continue;
    const { config, fold } = foldLegacyEmergencies(parsed.data);
    const changes = fold.setting === 'written' || fold.moved > 0 || fold.removed > 0;
    if (!changes) { out.push({ clinic: row.id, action: 'unchanged', ...fold }); continue; }
    if (!opts.apply) { out.push({ clinic: row.id, action: 'would write', ...fold }); continue; }
    await db.transaction(async (tx) => {
      // the audit row is the clinic's own: written with its clinic set (row-level security, migration 0051)
      await setClinicScope(tx, row.id);
      await tx.update(clinics).set({ config, configVersion: sql`${clinics.configVersion} + 1`, configUpdatedAt: new Date(), configUpdatedBy: 'provisioning' }).where(eq(clinics.id, row.id));
      await tx.insert(auditLogs).values({ clinicId: row.id, actor: 'provisioning', action: fold.setting === 'written' ? 'clinic.emergencies.updated' : 'clinic.emergencies.old_fields_removed', entity: 'clinic', entityId: row.id });
    });
    out.push({ clinic: row.id, action: 'written', ...fold });
  }
  return out;
}
