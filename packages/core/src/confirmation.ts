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

// "no text, thanks", "don't text me", "sin mensajes": the caller turns down the confirmation text, not the change
const NO_TEXT = /\b(no|not|don'?t|do not|without|sin)\b[^.?!]{0,25}\b(texts?|texting|messages?|sms|mensajes?|textos?)\b/g;
/** Whether the caller's answer to a read-back turns down the confirmation text ("yes, but no text"). */
export function declinesText(callerText: string): boolean {
  return new RegExp(NO_TEXT.source).test(normalise(callerText));
}
const NO_TEXT_CLAUSE = new RegExp(`(\\b(but|and|just|though|pero|y)\\b[\\s,]*)?${NO_TEXT.source}`);
/**
 * The part of the answer that is about the change, without the "no text" part: "yes please,
 * but no text, I don't need it" is "yes please". When the refusal comes first ("no text, but
 * yes, book it"), what follows it.
 */
export function withoutTextRefusal(callerText: string): string {
  const t = normalise(callerText);
  const m = NO_TEXT_CLAUSE.exec(t);
  if (!m) return t;
  const before = t.slice(0, m.index).replace(/[\s,;:-]+$/, '').trim();
  return before || t.slice(m.index + m[0].length).replace(/^([\s,;:.!-]|\b(please|thanks|thank you|por favor|gracias|but|pero)\b)+/, '').trim();
}

const GOODBYE = /\b(bye|goodbye|good bye|that'?s all|that is all|nothing else|no thanks|no thank you|have a (good|nice|great) (day|one)|adios|hasta luego|hasta pronto|nos vemos|eso es todo|nada mas|que (tenga|le vaya) (un )?(buen|bonito|lindo|excelente|feliz)? ?(dia|tarde|noche|bien)|chao|chau)\b/;
const NOTHING_MORE = /^(no|nope|nah|no gracias|that'?s it|thanks|thank you|gracias)\b/;
const ANYTHING_ELSE = /anything else|any other|something else|algo mas|otra cosa/;
const MORE_TO_SAY = /\b(but|also|one more|another|actually|wait|question|pero|tambien|una cosa mas|en realidad|ademas|espere|pregunta)\b|\?/;
// a caller who asks for the call to end, in so many words: "can you cut the call?", "please hang up", "cuelgue"
const HANG_UP = /\b(hang up|hangup|(cut|end|drop|close|stop|finish|disconnect)( the| this)? (call|line|phone)|you can go now|cuelgue|cuelga|(puede|puedes|podria|ya puede|ya puedes) colgar|(corte|cortar|termine|terminar|finalice|finalizar)( la| esta)? llamada)\b/;
const KEEP_ON = /\b(do ?n'?t|do not|please don'?t|no)\s+(hang up|cut|end|drop|disconnect)|\bno (me )?(cuelgue|cuelgues|cuelga|corte|cortes|termine|termines)\b/;
/** The caller asked, in so many words, for the call to end. */
export function askedToHangUp(lastCallerTurn: string): boolean {
  const t = normalise(lastCallerTurn).trim();
  return HANG_UP.test(t) && !KEEP_ON.test(t);
}
// a caller who is leaving the call themselves, whatever was asked: nobody is kept on the line for "anything else?"
const LEAVING = /\b(bye|goodbye|good bye|(have|got|need) to (go|run)|gotta go|talk (to you )?later|(i'?ll|i will|i'?m going to) (call|ring|phone) (you |u )?(back|again)( later| another time| tomorrow)?|call (you )?back later|(i'?ll|i will) get back to you|another time|adios|hasta luego|chao|chau|me tengo que ir|tengo que (irme|colgar)|hablamos (luego|despues|mas tarde|otro dia|manana)|((te|le|la|lo) )?(vuelvo a llamar|volvere a llamar)( luego| despues| mas tarde| otro dia| manana)?|((te|le|la|lo) )?(llamo|llamare) (luego|despues|mas tarde|otro dia|manana)|(despues |luego )?(te|le) (aviso|confirmo) (luego|despues|mas tarde))\b/;

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

/**
 * Whether the caller's words say the pet (or they) are new to the clinic: 'new' ("she's new", "he's not registered",
 * "es nueva"), 'on_file' when they say it may be on file after all ("she's not new", "he's been there before", "ya es
 * paciente"), or null when they say neither. In any language, like a hedge: a caller who switches language still means
 * it. "Not new" wins over "new" in the same words.
 */
export function newToClinic(callerText: string): 'new' | 'on_file' | null {
  const t = normalise(callerText);
  if (LANGUAGES.some((l) => PACKS[l].saysOnFile.test(t))) return 'on_file';
  if (LANGUAGES.some((l) => PACKS[l].saysNew.test(t))) return 'new';
  return null;
}

/**
 * Whether the caller describes a pet the way someone bringing a new one does: its age ("a year old", "tiene dos años")
 * or its sex ("a female", "es hembra"). With that and nothing said about being new, the assistant asks whether the pet is
 * new before any lookup (a test call, 2026-10-26: the details came first and the lookup found nothing). In any language.
 */
export function describesPet(callerText: string): boolean {
  const t = normalise(callerText);
  return LANGUAGES.some((l) => PACKS[l].describesPet.test(t));
}

/**
 * Whether a pet's "name" only points at one of the owner's pets ("the other one", "my cat", "la otra") with no name in
 * it: the caller said which pet, not what it is called, so there is nothing to look up. A name with such words in it
 * ("Little Bear", "Mi Amor") is still a name. In any language.
 */
export function pointsAtPet(petName: string): boolean {
  const t = normalise(petName).trim();
  return LANGUAGES.some((l) => PACKS[l].pointsAtPet.test(t));
}
