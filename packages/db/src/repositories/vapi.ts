// SPDX-License-Identifier: AGPL-3.0-only
import { VAPI_CALL_STALE_MS } from '@attendra/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { type Database, withClinic } from '../client';
import type { PhiCipher } from '../crypto';
import { vapiConcurrencyDays, vapiLiveCalls, vapiSecrets } from '../schema';

/**
 * Vapi as a location's backup engine (batch 6, migration 0056): each location's own secret, and the Vapi calls live at
 * the same moment across every location (Vapi's limit is per subscription).
 */

const secretContext = (clinicId: string) => `${clinicId}:vapi_secrets.secret`;
/** The keyed hash a request's secret is checked against: the deployment's data key, the location's id, the secret. */
export const vapiSecretHash = (cipher: PhiCipher, clinicId: string, secret: string) => cipher.hash(`vapi-secret:${clinicId}:${secret}`);

/** Keeps a location's secret (replacing one it had). */
export async function saveVapiSecret(db: Database, cipher: PhiCipher, clinicId: string, secret: string): Promise<void> {
  const row = { clinicId, secretEnc: cipher.encrypt(secret, secretContext(clinicId)), secretHash: vapiSecretHash(cipher, clinicId, secret) };
  await withClinic(db, clinicId, (tx) => tx.insert(vapiSecrets).values(row).onConflictDoUpdate({ target: vapiSecrets.clinicId, set: { secretEnc: row.secretEnc, secretHash: row.secretHash } }));
}

/** The location's secret, to send to Vapi again when its assistant is updated; null when it has none. */
export async function vapiSecretOf(db: Database, cipher: PhiCipher, clinicId: string): Promise<string | null> {
  const [row] = await withClinic(db, clinicId, (tx) => tx.select({ enc: vapiSecrets.secretEnc }).from(vapiSecrets).where(eq(vapiSecrets.clinicId, clinicId)));
  return row ? cipher.decrypt(row.enc, secretContext(clinicId)) : null;
}

/** The stored hash of the location's secret, for the voice service to check a request with; null when it has none. */
export async function vapiSecretHashOf(db: Database, clinicId: string): Promise<string | null> {
  const [row] = await withClinic(db, clinicId, (tx) => tx.select({ hash: vapiSecrets.secretHash }).from(vapiSecrets).where(eq(vapiSecrets.clinicId, clinicId)));
  return row?.hash ?? null;
}

/** Whether a presented secret is the location's, compared in constant time. */
export function vapiSecretMatches(cipher: PhiCipher, clinicId: string, presented: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(vapiSecretHash(cipher, clinicId, presented));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The UTC day a moment falls on: the day a peak is counted for. */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);

const liveSince = (at: Date) => new Date(at.getTime() - VAPI_CALL_STALE_MS);
async function liveCount(db: Pick<Database, 'select'>, at: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(vapiLiveCalls)
    .where(and(isNull(vapiLiveCalls.endedAt), sql`${vapiLiveCalls.startedAt} > ${liveSince(at)}`));
  return Number(row?.n ?? 0);
}

/**
 * A Vapi call is live (its first status message, or a tool call from one we had not heard of): counted once, the day's
 * peak raised, and `alert` true for the first time that day the live calls reach `alertAt` (only one process wins it).
 */
export async function vapiCallLive(db: Database, vapiCallId: string, at: Date, alertAt: number): Promise<{ live: number; peak: number; alert: boolean }> {
  return db.transaction(async (tx) => {
    await tx.insert(vapiLiveCalls).values({ vapiCallId, startedAt: at }).onConflictDoNothing();
    const live = await liveCount(tx, at);
    const day = utcDay(at);
    const [d] = await tx.insert(vapiConcurrencyDays).values({ day, peak: live })
      .onConflictDoUpdate({ target: vapiConcurrencyDays.day, set: { peak: sql`greatest(${vapiConcurrencyDays.peak}, ${live})` } })
      .returning({ peak: vapiConcurrencyDays.peak });
    let alert = false;
    if (live >= alertAt) {
      const won = await tx.update(vapiConcurrencyDays).set({ alertedAt: at }).where(and(eq(vapiConcurrencyDays.day, day), isNull(vapiConcurrencyDays.alertedAt))).returning({ day: vapiConcurrencyDays.day });
      alert = won.length > 0;
    }
    return { live, peak: d?.peak ?? live, alert };
  });
}

/** A Vapi call ended (its status, or its end-of-call report): no longer counted. */
export async function vapiCallEnded(db: Database, vapiCallId: string, at: Date): Promise<void> {
  await db.update(vapiLiveCalls).set({ endedAt: at }).where(and(eq(vapiLiveCalls.vapiCallId, vapiCallId), isNull(vapiLiveCalls.endedAt)));
}

/** Vapi calls live now and today's (UTC) peak, for the hosting layer and the alert. */
export async function vapiConcurrency(db: Database, at: Date): Promise<{ live: number; todayPeak: number; day: string; alertedAt: string | null }> {
  const day = utcDay(at);
  const [row] = await db.select({ peak: vapiConcurrencyDays.peak, alertedAt: vapiConcurrencyDays.alertedAt }).from(vapiConcurrencyDays).where(eq(vapiConcurrencyDays.day, day));
  return { live: await liveCount(db, at), todayPeak: row?.peak ?? 0, day, alertedAt: row?.alertedAt?.toISOString() ?? null };
}

/** One engine's share of a clinic's calls in a period (clinicCosts). Money in US dollars, from call_costs. */
export interface EngineCosts {
  /** 'gpt-live' | 'gpt-realtime' | 'vapi'; null for calls closed before migration 0045 recorded it. */
  engine: string | null;
  /** 'planner' | 'tools'; null before 0045. */
  flow: string | null;
  /** 'phone', or 'web' for browser test calls (never billed to the clinic). */
  channel: string;
  calls: number;
  /** Calls with a cost row: a call closed before its costs could be worked out has none, and adds no money. */
  costed: number;
  seconds: number;
  minutes: number;
  voiceUsd: number;
  modelUsd: number;
  telephonyUsd: number;
  textsUsd: number;
  totalUsd: number;
}

/**
 * A clinic's calls in [from, to), ended, per engine, flow and channel: how many, their length (start to end, as billing
 * counts it) and what they cost us (call_costs: the voice, the models, the phone line, the texts sent on them), and every
 * text the carrier took in the period. Counts and money only, for the hosting layer's margin page.
 */
export async function clinicCosts(db: Database, clinicId: string, from: Date, to: Date): Promise<{ engines: EngineCosts[]; texts: number }> {
  return withClinic(db, clinicId, async (tx) => {
    const rows = (await tx.execute(sql`
      select c.engine, c.voice_flow as flow, c.channel, count(*)::int as calls, count(k.call_id)::int as costed,
        coalesce(sum(ceil(extract(epoch from (c.ended_at - c.started_at)))), 0)::int as seconds,
        coalesce(sum(k.voice_usd), 0)::float8 as voice_usd, coalesce(sum(k.model_usd), 0)::float8 as model_usd,
        coalesce(sum(k.telephony_usd), 0)::float8 as telephony_usd, coalesce(sum(k.texts_usd), 0)::float8 as texts_usd,
        coalesce(sum(k.total_usd), 0)::float8 as total_usd
      from calls c left join call_costs k on k.call_id = c.id
      where c.clinic_id = ${clinicId} and c.ended_at is not null and c.started_at >= ${from} and c.started_at < ${to}
      group by c.engine, c.voice_flow, c.channel
      order by c.channel, c.engine nulls last, c.voice_flow nulls last`)).rows as { engine: string | null; flow: string | null; channel: string; calls: number; costed: number; seconds: number; voice_usd: number; model_usd: number; telephony_usd: number; texts_usd: number; total_usd: number }[];
    const [sms] = (await tx.execute(sql`
      select count(*)::int as texts from sms_messages
      where clinic_id = ${clinicId} and provider_sid is not null and sent_at >= ${from} and sent_at < ${to}`)).rows as [{ texts: number }];
    const usd = (n: number) => Math.round(Number(n) * 1e6) / 1e6;
    return {
      engines: rows.map((r) => ({
        engine: r.engine, flow: r.flow, channel: r.channel, calls: Number(r.calls), costed: Number(r.costed), seconds: Number(r.seconds), minutes: Math.round((Number(r.seconds) / 60) * 100) / 100,
        voiceUsd: usd(r.voice_usd), modelUsd: usd(r.model_usd), telephonyUsd: usd(r.telephony_usd), textsUsd: usd(r.texts_usd), totalUsd: usd(r.total_usd),
      })),
      texts: Number(sms.texts),
    };
  });
}
