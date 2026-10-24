// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, LANGUAGES, normalise, PACKS } from './locales';

/**
 * Did the caller clearly agree? Used by the agent before any write, on the caller's
 * own words since the read-back, never on the model's summary of them. Anything
 * hedged or mixed ("yes, actually no", "I think so?", "sí, pero espere")
 * is not a yes.
 *
 * A yes counts only in the languages the clinic offers: a word that means yes in
 * another language ("sí", "vale") is ordinary text at an English clinic. Short,
 * ambiguous words count only as the whole answer. A hedge in any language blocks it,
 * because a caller who switches languages to say "wait" still means wait.
 */
export function isClearYes(callerTextSinceReadback: string, languages: readonly Language[]): boolean {
  const t = normalise(callerTextSinceReadback).trim();
  if (!t) return false;
  const whole = t.replace(/[.,!¡]+/g, ' ').replace(/\s+/g, ' ').trim();
  const yes = languages.some((l) => PACKS[l].yes.test(t) || PACKS[l].yesAlone.test(whole));
  const hedge = LANGUAGES.some((l) => PACKS[l].hedge.test(t));
  return yes && !hedge;
}

const GOODBYE = /\b(bye|goodbye|good bye|that'?s all|that is all|nothing else|no thanks|no thank you|have a (good|nice|great) (day|one)|adios|hasta luego|eso es todo|nada mas|chao|chau)\b/;
const NOTHING_MORE = /^(no|nope|nah|no gracias|that'?s it|thanks|thank you|gracias)\b/;
const ANYTHING_ELSE = /anything else|any other|something else|algo mas|otra cosa/;
const MORE_TO_SAY = /\b(but|also|one more|another|actually|wait|question|pero|tambien|espere|pregunta)\b|\?/;
// a caller who asks for the call to end, in so many words: "can you cut the call?", "please hang up", "cuelgue"
const HANG_UP = /\b(hang up|hangup|(cut|end|drop|close|stop|finish|disconnect)( the| this)? (call|line|phone)|you can go now|cuelgue|cuelga|corte la llamada|termine la llamada)\b/;
const KEEP_ON = /\b(do ?n'?t|do not|please don'?t|no)\s+(hang up|cut|end|drop|disconnect)|\bno cuelgue\b/;
/** The caller asked, in so many words, for the call to end. */
export function askedToHangUp(lastCallerTurn: string): boolean {
  const t = normalise(lastCallerTurn).trim();
  return HANG_UP.test(t) && !KEEP_ON.test(t);
}
// a caller who is leaving the call themselves, whatever was asked: nobody is kept on the line for "anything else?"
const LEAVING = /\b(bye|goodbye|good bye|(have|got|need) to (go|run)|gotta go|talk (to you )?later|(i'?ll|i will|i'?m going to) (call|ring|phone) (you |u )?(back|again)( later| another time| tomorrow)?|call (you )?back later|another time|adios|hasta luego|chao|chau|me tengo que ir|(te |le )?(llamo|llamar[eé]) (luego|despu[eé]s|m[aá]s tarde|otro d[ií]a))\b/;

/**
 * May the call end? Two steps, like a front desk: the assistant has asked whether
 * there is anything else, and the caller's own last words answer no or say goodbye.
 * Read on what was said, never on the model's view of it: "I'm done" in the middle of
 * giving a phone number ends nothing, and a goodbye before the question is answered
 * with the question. A caller who says they have to go, or says goodbye themselves, is
 * let go without the question.
 */
export function saidGoodbye(lastCallerTurn: string, lastAgentTurns = ''): boolean {
  const t = normalise(lastCallerTurn).trim();
  if (askedToHangUp(t)) return true;
  // "bye, but one more thing" has more to say; "I'll call back another time, goodbye" is leaving: the goodbye comes last
  const more = MORE_TO_SAY.exec(t);
  // the last way of leaving counts: "I'll call back another time, goodbye" leaves after "another"
  const leaving = [...t.matchAll(new RegExp(LEAVING.source, 'g'))].at(-1);
  if (leaving && (!more || leaving.index > more.index) && !t.includes('?')) return true;
  if (more) return false;
  return ANYTHING_ELSE.test(normalise(lastAgentTurns)) && (GOODBYE.test(t) || NOTHING_MORE.test(t));
}
