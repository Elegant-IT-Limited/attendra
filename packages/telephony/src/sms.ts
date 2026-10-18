// SPDX-License-Identifier: AGPL-3.0-only
import { asE164, type Language, type Messenger, PACKS, type TextRefusal, type TextRequest, type TextResult } from '@attendra/core';
import { type Database, type PhiCipher, phoneKey, schema, withClinic } from '@attendra/db';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';

/**
 * SMS goes out from fixed templates only. A carrier message is outside the BAA
 * perimeter of most setups, so the text says when and where, never why: no visit
 * reason, no provider specialty, no medication. Each language pack has its own
 * wording of the same template; English is the default.
 */
export const TEMPLATES = PACKS.en.sms;

/** A template's text in the language the call was held in. */
export const renderSms = (template: keyof typeof TEMPLATES, vars: Record<string, string>, language: Language = 'en') => PACKS[language].sms[template](vars);

/** Texts to one number from one clinic in 24 hours, across calls and jobs. */
export const MAX_TEXTS_PER_NUMBER_PER_DAY = 8;
/** Texts from one clinic in 24 hours, unless ATTENDRA_SMS_DAILY_CAP says otherwise. */
export const DEFAULT_SMS_DAILY_CAP = 500;
/** Twilio: the number replied STOP to this sender. */
const OPTED_OUT = 21610;

/** The one-way key of a number for one clinic. Texts, opt-outs and replies all use it. */
export const smsNumberHash = (cipher: PhiCipher, clinicId: string, number: string) => cipher.hash(`${clinicId}|${number.replace(/\D/g, '').slice(-10)}`);

export interface SmsSender {
  send(input: { from: string; to: string; body: string; statusCallback?: string }): Promise<{ sid: string }>;
}

/** Twilio Messaging, behind a two-line interface so tests never reach the network. */
export function twilioSender(client: { messages: { create(p: { from: string; to: string; body: string; statusCallback?: string }): Promise<{ sid: string }> } }): SmsSender {
  return { send: ({ from, to, body, statusCallback }) => client.messages.create({ from, to, body, ...(statusCallback ? { statusCallback } : {}) }) };
}

export interface MessengerOptions {
  /** Who the audit rows name. */
  actor?: string;
  /** Texts one clinic may send in 24 hours. */
  dailyCap?: number;
  /** Where Twilio reports delivery for this clinic's texts; none, and the status stays "sent". */
  statusCallback?: (clinicId: string) => string | undefined;
  log?: { warn(obj: object, msg: string): void };
}

/**
 * Sends a template, or says why not. Never throws: a booking stands and a job decides
 * whether to retry. At most once per idempotency key: the row is claimed before
 * sending, and a key that failed or was refused can be tried again. A null sender
 * means texting is not set up here; the refusal is still recorded, so staff see it.
 */
export class TwilioMessenger implements Messenger {
  constructor(
    private readonly db: Database,
    private readonly cipher: PhiCipher,
    private readonly sender: SmsSender | null,
    private readonly fromNumberFor: (clinicId: string) => string,
    private readonly options: MessengerOptions = {},
  ) {}

  /** Whether this number replied STOP to this clinic (or the carrier said so). */
  async optedOut(clinicId: string, to: string): Promise<boolean> {
    const { smsOptOuts } = schema;
    const toHash = smsNumberHash(this.cipher, clinicId, to);
    const [row] = await withClinic(this.db, clinicId, (tx) => tx.select({ status: smsOptOuts.status }).from(smsOptOuts).where(and(eq(smsOptOuts.clinicId, clinicId), eq(smsOptOuts.toHash, toHash))));
    return row?.status === 'opted_out';
  }

  async sendTemplate(clinicId: string, input: TextRequest): Promise<TextResult> {
    const { smsMessages, smsOptOuts, auditLogs } = schema;
    const actor = this.options.actor ?? 'voice-agent';
    const about = input.about ?? {};
    const audit = (action: string, entityId: string) => ({ clinicId, actor, action, entity: 'sms', entityId, ...(about.callId ? { callId: about.callId } : {}) });
    let from: string | null;
    try { from = this.fromNumberFor(clinicId); } catch { from = null; }
    const to = asE164({ phoneNumbers: from ? [from] : [] }, input.to ?? '');
    const toHash = smsNumberHash(this.cipher, clinicId, to);
    const where = and(eq(smsMessages.clinicId, clinicId), eq(smsMessages.idempotencyKey, input.idempotencyKey));

    const claimed = await withClinic(this.db, clinicId, async (tx) => {
      const fields = {
        template: input.template, toHash, kind: input.kind ?? 'auto', language: input.language ?? 'en',
        callId: about.callId ?? null, patientId: about.patientId ?? null, taskId: about.taskId ?? null, appointmentId: about.appointmentId ?? null,
        consentAtMs: input.consentAtMs ?? null,
      };
      const [row] = await tx.insert(smsMessages).values({ clinicId, idempotencyKey: input.idempotencyKey, ...fields }).onConflictDoNothing().returning({ id: smsMessages.id });
      if (row) return { id: row.id };
      const [existing] = await tx.select().from(smsMessages).where(where);
      if (!existing) return null;
      if (existing.status !== 'failed' && existing.status !== 'not_sent') return { already: existing.id };
      await tx.update(smsMessages).set({ ...fields, status: 'queued', failureReason: null, errorCode: null }).where(where);
      return { id: existing.id };
    });
    if (!claimed) return { status: 'not_sent', reason: 'carrier', messageId: null };
    if ('already' in claimed) return { status: 'already', messageId: claimed.already! };
    const id = claimed.id;

    const refuse = async (reason: TextRefusal, status: 'not_sent' | 'failed' = 'not_sent', errorCode: string | null = null): Promise<TextResult> => {
      await withClinic(this.db, clinicId, async (tx) => {
        await tx.update(smsMessages).set({ status, failureReason: reason, errorCode }).where(eq(smsMessages.id, id));
        await tx.insert(auditLogs).values(audit(`sms.not_sent.${reason}`, id));
      });
      return { status: 'not_sent', reason, messageId: id };
    };

    // a test call never texts anyone: the number a tester reads out may be a real patient's
    if (input.testCall) return refuse('test_call');
    if (!/^\+[1-9]\d{7,14}$/.test(to)) return refuse('no_number');
    if (!this.sender || !from) return refuse('texting_off');

    const day = new Date(Date.now() - 24 * 3600_000);
    const counted = (extra: ReturnType<typeof eq>) => and(eq(smsMessages.clinicId, clinicId), ne(smsMessages.status, 'not_sent'), ne(smsMessages.id, id), gt(smsMessages.createdAt, day), extra);
    const standing = await withClinic(this.db, clinicId, async (tx) => {
      const [opt] = await tx.select({ status: smsOptOuts.status }).from(smsOptOuts).where(and(eq(smsOptOuts.clinicId, clinicId), eq(smsOptOuts.toHash, toHash)));
      const [toNumber] = await tx.select({ n: sql<number>`count(*)::int` }).from(smsMessages).where(counted(eq(smsMessages.toHash, toHash)));
      const [clinic] = await tx.select({ n: sql<number>`count(*)::int` }).from(smsMessages).where(counted(eq(smsMessages.clinicId, clinicId)));
      return { optedOut: opt?.status === 'opted_out', toNumber: toNumber!.n, clinic: clinic!.n };
    });
    if (standing.optedOut) return refuse('opted_out');
    const cap = this.options.dailyCap ?? DEFAULT_SMS_DAILY_CAP;
    if (standing.toNumber >= MAX_TEXTS_PER_NUMBER_PER_DAY) return refuse('rate_limited');
    if (standing.clinic >= cap) {
      this.options.log?.warn({ clinic_id: clinicId, cap }, 'the clinic reached its daily text limit');
      return refuse('rate_limited');
    }
    if (standing.clinic + 1 === Math.ceil(cap * 0.8)) this.options.log?.warn({ clinic_id: clinicId, cap }, 'the clinic has used 80% of its daily text limit');

    try {
      const statusCallback = this.options.statusCallback?.(clinicId);
      const { sid } = await this.sender.send({ from, to, body: renderSms(input.template, input.vars, input.language), ...(statusCallback ? { statusCallback } : {}) });
      await withClinic(this.db, clinicId, async (tx) => {
        await tx.update(smsMessages).set({ status: 'sent', providerSid: sid, sentAt: new Date() }).where(eq(smsMessages.id, id));
        await tx.insert(auditLogs).values(audit(`sms.sent.${input.template}`, sid));
      });
      return { status: 'sent', messageId: id };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === OPTED_OUT) {
        await withClinic(this.db, clinicId, (tx) => tx.insert(smsOptOuts).values({ clinicId, toHash, status: 'opted_out', source: 'carrier' })
          .onConflictDoUpdate({ target: [smsOptOuts.clinicId, smsOptOuts.toHash], set: { status: 'opted_out', source: 'carrier', at: new Date() } }));
        return refuse('opted_out', 'not_sent', String(code));
      }
      return refuse('carrier', 'failed', typeof code === 'number' || typeof code === 'string' ? String(code) : null);
    }
  }
}

/**
 * A number's standing with a clinic after STOP or START (or a carrier refusal, or
 * staff). The latest wins. Audited with the first characters of the hash, never the number.
 */
export async function recordSmsStanding(db: Database, cipher: PhiCipher, clinicId: string, number: string, status: 'opted_out' | 'opted_in', source: 'keyword' | 'carrier' | 'staff', actor = 'sms') {
  const { smsOptOuts, auditLogs } = schema;
  const toHash = smsNumberHash(cipher, clinicId, number);
  await withClinic(db, clinicId, async (tx) => {
    await tx.insert(smsOptOuts).values({ clinicId, toHash, status, source })
      .onConflictDoUpdate({ target: [smsOptOuts.clinicId, smsOptOuts.toHash], set: { status, source, at: new Date() } });
    await tx.insert(auditLogs).values({ clinicId, actor, action: status === 'opted_out' ? 'sms.opt_out' : 'sms.opt_in', entity: 'sms', entityId: toHash.slice(0, 8) });
  });
}

/**
 * A reply of C to a reminder: the next visit within 7 days that had a reminder, for
 * whoever has this number on file, is marked confirmed. Null when there is none.
 */
export async function confirmByReply(db: Database, cipher: PhiCipher, clinicId: string, from: string, now = new Date()) {
  const { appointments, patients, auditLogs } = schema;
  return withClinic(db, clinicId, async (tx) => {
    const people = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, cipher.hash(phoneKey(clinicId, from)))));
    if (!people.length) return null;
    const [next] = await tx.select({ id: appointments.id, patientId: appointments.patientId, startsAt: appointments.startsAt }).from(appointments)
      .where(and(
        eq(appointments.clinicId, clinicId), eq(appointments.status, 'booked'), inArray(appointments.patientId, people.map((p) => p.id)),
        gt(appointments.startsAt, now), lte(appointments.startsAt, new Date(now.getTime() + 7 * 86_400_000)),
        isNotNull(appointments.reminderSentAt), isNull(appointments.confirmedAt),
      ))
      .orderBy(asc(appointments.startsAt)).limit(1);
    if (!next) return null;
    await tx.update(appointments).set({ confirmedAt: now, confirmedVia: 'text' }).where(eq(appointments.id, next.id));
    await tx.insert(auditLogs).values({ clinicId, actor: 'sms', action: 'appointment.confirmed.text', entity: 'appointment', entityId: next.id });
    return next;
  });
}
