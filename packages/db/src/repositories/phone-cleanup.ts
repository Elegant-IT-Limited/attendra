// SPDX-License-Identifier: AGPL-3.0-only
import { asE164, ClinicConfig, isE164, withPhonesAsE164 } from '@attendra/core';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, clinics, patients, tasks } from '../schema';

/** What the phone clean-up found, or changed: counts only, never a number. */
export interface PhoneCleanup {
  clinics: number;
  /** Clinics whose settings hold a number not in E.164 (VIP callers, hospitals, transfers, providers). */
  settings: number;
  /** Patient and pet records whose phone is not in E.164 but can be read as one. */
  records: number;
  /** Requests whose callback number is not in E.164 but can be read as one. */
  requests: number;
  /** Stored numbers that cannot be read as a whole number: left as they are, for staff. */
  unreadable: number;
  /** Numbers stored on records in more than one form ("5065550142" and "+15065550142"), before the clean-up. */
  storedTwice: number;
}

/**
 * Every stored number in the one form, E.164 (2026-11): patients' and pets' phones,
 * requests' callback numbers and each clinic's settings. The keyed lookups stay as they
 * are, since they are made from a number's last digits, which E.164 does not change.
 * A number that cannot be read whole is left as given. Without `apply`, a dry run that
 * changes nothing. Safe to run again.
 */
export async function normalisePhones(db: Database, cipher: PhiCipher, opts: { apply: boolean }): Promise<PhoneCleanup> {
  const rows = await db.select({ id: clinics.id, config: clinics.config }).from(clinics);
  const out: PhoneCleanup = { clinics: rows.length, settings: 0, records: 0, requests: 0, unreadable: 0, storedTwice: 0 };
  for (const row of rows) {
    const parsed = ClinicConfig.safeParse(row.config);
    if (!parsed.success) continue;
    const config = parsed.data;
    const fixed = withPhonesAsE164(config);
    if (JSON.stringify(fixed) !== JSON.stringify(config)) {
      out.settings++;
      if (opts.apply && ClinicConfig.safeParse(fixed).success) {
        await db.update(clinics).set({ config: fixed, configVersion: sql`${clinics.configVersion} + 1`, configUpdatedAt: new Date(), configUpdatedBy: 'provisioning' }).where(eq(clinics.id, row.id));
      }
    }
    await withClinic(db, row.id, async (tx) => {
      const phoneCtx = phiContext(row.id, 'patients.phone');
      const forms = new Map<string, Set<string>>();
      for (const p of await tx.select({ id: patients.id, phoneEnc: patients.phoneEnc }).from(patients).where(eq(patients.clinicId, row.id))) {
        if (!p.phoneEnc) continue;
        const stored = cipher.decrypt(p.phoneEnc, phoneCtx);
        const e164 = asE164(config, stored);
        if (!isE164(e164)) { out.unreadable++; continue; }
        forms.set(e164, new Set([...(forms.get(e164) ?? []), stored]));
        if (e164 === stored) continue;
        out.records++;
        if (!opts.apply) continue;
        // the keyed hashes come from the last digits, the same in both forms: only the stored number changes
        await tx.update(patients).set({ phoneEnc: cipher.encrypt(e164, phoneCtx) }).where(and(eq(patients.clinicId, row.id), eq(patients.id, p.id)));
        await tx.insert(auditLogs).values({ clinicId: row.id, actor: 'system', action: 'patient.phone.normalised', entity: 'patient', entityId: p.id });
      }
      out.storedTwice += [...forms.values()].filter((f) => f.size > 1).length;

      const detailsCtx = phiContext(row.id, 'tasks.details');
      for (const t of await tx.select({ id: tasks.id, detailsEnc: tasks.detailsEnc }).from(tasks).where(eq(tasks.clinicId, row.id))) {
        const details = JSON.parse(cipher.decrypt(t.detailsEnc, detailsCtx)) as Record<string, unknown>;
        let changed = false;
        for (const k of ['callback_number', 'phone']) {
          const v = details[k];
          if (typeof v !== 'string' || !v.trim()) continue;
          const e164 = asE164(config, v);
          if (!isE164(e164)) { out.unreadable++; continue; }
          if (e164 !== v) { details[k] = e164; changed = true; }
        }
        if (!changed) continue;
        out.requests++;
        if (opts.apply) await tx.update(tasks).set({ detailsEnc: cipher.encrypt(JSON.stringify(details), detailsCtx) }).where(and(eq(tasks.clinicId, row.id), eq(tasks.id, t.id)));
      }
    });
  }
  return out;
}
