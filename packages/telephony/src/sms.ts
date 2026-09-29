// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, type Messenger, PACKS } from '@attendra/core';
import { type Database, type PhiCipher, schema, withClinic } from '@attendra/db';
import { and, eq } from 'drizzle-orm';

/**
 * SMS goes out from fixed templates only. A carrier message is outside the BAA
 * perimeter of most setups, so the text says when and where, never why: no visit
 * reason, no provider specialty, no medication. Each language pack has its own
 * wording of the same two templates; English is the default.
 */
export const TEMPLATES = PACKS.en.sms;

/** A template's text in the language the call was held in. */
export const renderSms = (template: keyof typeof TEMPLATES, vars: Record<string, string>, language: Language = 'en') => PACKS[language].sms[template](vars);

export interface SmsSender {
  send(input: { from: string; to: string; body: string }): Promise<{ sid: string }>;
}

/** Twilio Messaging, behind a two-line interface so tests never reach the network. */
export function twilioSender(client: { messages: { create(p: { from: string; to: string; body: string }): Promise<{ sid: string }> } }): SmsSender {
  return { send: ({ from, to, body }) => client.messages.create({ from, to, body }) };
}

export class TwilioMessenger implements Messenger {
  constructor(
    private readonly db: Database,
    private readonly cipher: PhiCipher,
    private readonly sender: SmsSender,
    private readonly fromNumberFor: (clinicId: string) => string,
  ) {}

  /**
   * At most once per idempotency key: a retried booking confirmation is not a second
   * text. The row is claimed before sending and marked sent or failed after, and a
   * failed send can be retried with the same key.
   */
  async sendTemplate(clinicId: string, input: { to: string; template: keyof typeof TEMPLATES; vars: Record<string, string>; idempotencyKey: string; language?: Language }) {
    const { smsMessages, auditLogs } = schema;
    const where = and(eq(smsMessages.clinicId, clinicId), eq(smsMessages.idempotencyKey, input.idempotencyKey));
    const claimed = await withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.insert(smsMessages).values({
        clinicId, template: input.template, idempotencyKey: input.idempotencyKey,
        toHash: this.cipher.hash(`${clinicId}|${input.to.replace(/\D/g, '').slice(-10)}`),
      }).onConflictDoNothing().returning({ id: smsMessages.id });
      if (row) return row.id;
      const [existing] = await tx.select().from(smsMessages).where(where);
      return existing?.status === 'failed' ? existing.id : null;
    });
    if (!claimed) return;
    try {
      const { sid } = await this.sender.send({ from: this.fromNumberFor(clinicId), to: input.to, body: renderSms(input.template, input.vars, input.language) });
      await withClinic(this.db, clinicId, async (tx) => {
        await tx.update(smsMessages).set({ status: 'sent' }).where(where);
        await tx.insert(auditLogs).values({ clinicId, actor: 'voice-agent', action: `sms.sent.${input.template}`, entity: 'sms', entityId: sid });
      });
    } catch (err) {
      await withClinic(this.db, clinicId, (tx) => tx.update(smsMessages).set({ status: 'failed' }).where(where));
      throw err;
    }
  }
}
