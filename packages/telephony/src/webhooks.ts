// SPDX-License-Identifier: AGPL-3.0-only
import twilio from 'twilio';

/**
 * Whether a request really came from Twilio: the X-Twilio-Signature header against
 * the full URL Twilio called and the form fields, signed with the auth token.
 */
export function twilioSignatureValid(url: string, params: Record<string, string>, authToken: string, signature: string | undefined): boolean {
  if (!signature || !authToken) return false;
  try { return twilio.validateRequest(authToken, signature, url, params); } catch { return false; }
}

/** Reply keywords, matched on the whole message, any case. */
const STOP = /^(stop|stopall|unsubscribe|cancel|end|quit|alto|parar)$/i;
const START = /^(start|yes|unstop|iniciar)$/i;
const CONFIRM = /^(c|confirm|confirmar|si|sí|s)$/i;

export type SmsKeyword = 'stop' | 'start' | 'confirm' | 'other';
export function smsKeyword(body: string): SmsKeyword {
  const t = body.trim().replace(/[.!]+$/, '');
  return STOP.test(t) ? 'stop' : START.test(t) ? 'start' : CONFIRM.test(t) ? 'confirm' : 'other';
}

/** TwiML with nothing to say, or one message. */
export const twiml = (message?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</Message>` : ''}</Response>`;

/** Where Twilio reports a text's delivery: the voice service, with the clinic in the query. */
export const smsStatusUrl = (publicUrl: string, clinicId: string) => `${publicUrl.replace(/\/+$/, '')}/webhooks/twilio/sms-status?clinic=${encodeURIComponent(clinicId)}`;
