// SPDX-License-Identifier: AGPL-3.0-only
import { normalise } from './locales/types';

/**
 * A caller who says they are returning a call from this number ("I had a missed call from you",
 * "someone called me", "returning your call"), in English and Spanish. Attendra never calls
 * out, so the call they got did not come from the assistant: the number may be spoofed by
 * someone else's calls, or had an earlier owner (several such callers in one week, 2026-10).
 * They are told so plainly and offered a message, never asked for a pet. Matched on the whole
 * caller turn after `normalise` (lower case, no accents).
 */
const RETURNING: RegExp[] = [
  /\bmissed (a )?calls?\b/,
  /\b(i |we )?(got|had|have|received|saw) (a |an |two |some |several )?(missed )?(call|calls|voicemail|message)s? from (this|that|your|you)\b/,
  /\b(someone|somebody|you|you guys|this number|your office|your clinic) (just )?(called|phoned|rang|tried to call|tried calling|called me|phoned me)\b/,
  // "calling you back", never "calling back about my refill": a client told to call back is not returning a missed call
  /\b(calling|ringing|phoning) (you|you guys|you all|y'?all) back\b/,
  /\breturn(ing)? (your|a|the|this) call\b/,
  /\bwho (just )?called( me)?( from this number)?\b/,
  /\bwhy (did )?(you|someone) call(ed)? me\b/,
  // Spanish
  /\bllamada(s)? perdida(s)?\b/,
  /\b(me |nos )?(llamaron|llamo|han llamado|llamaste|llamasteis) (de |desde )?(este|ese|su|tu) (numero|telefono|oficina|clinica)\b/,
  /\b(alguien|ustedes|usted|vosotros) (me |nos )?(llamo|llamaron|ha llamado|han llamado|marco|marcaron)\b/,
  /\b(estoy |le estoy |les estoy )?(devolviendo|regresando) (la |una |su |tu )?llamada\b/,
  /\btengo una llamada (perdida )?de (este|ese|su) numero\b/,
  /\b(quien|quienes) (me )?(llamo|llamaron)\b/,
];

export function isReturningCall(text: string): boolean {
  const t = normalise(text);
  return RETURNING.some((p) => p.test(t));
}
