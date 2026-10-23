// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, PACKS } from './locales';

/** Every text the assistant and the team can send, by template name. */
export type SmsTemplateName = keyof (typeof PACKS)['en']['sms'];
export const SMS_TEMPLATE_NAMES = Object.keys(PACKS.en.sms) as SmsTemplateName[];

/**
 * A text in the language the call was held in, with the clinic's own words when it set
 * any: a few words after its name ("Zaru: Find our clinic here: …") and one line before
 * "Reply STOP". Everything else is fixed: the name first, the facts from the settings,
 * and the opt-out last, as the carriers registered it.
 */
export function renderText(template: SmsTemplateName, vars: Record<string, string>, language: Language = 'en', wording?: { label?: string; extra?: string }): string {
  let body = PACKS[language].sms[template](vars);
  const label = wording?.label?.trim();
  const extra = wording?.extra?.trim();
  const lead = `${vars.clinic}: `;
  if (label && body.startsWith(lead)) body = `${lead}${label}${/[:.!?]$/.test(label) ? '' : ':'} ${body.slice(lead.length)}`;
  if (extra) {
    const stop = body.search(/ (Reply|Responda) STOP\b/);
    if (stop >= 0) body = `${body.slice(0, stop)} ${extra}${/[.!?]$/.test(extra) ? '' : '.'}${body.slice(stop)}`;
  }
  return body;
}

/** Text segments a body takes: 160 characters (153 when split) in the plain alphabet, 70 (67) once any other character is in it. */
export function smsSegments(body: string): number {
  const gsm = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(body);
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return body.length <= one ? 1 : Math.ceil(body.length / many);
}
