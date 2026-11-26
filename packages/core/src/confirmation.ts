// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, LANGUAGES, normalise, PACKS, SENTENCE_WORDS } from './locales';
import { saysClockTime } from './readback';

/**
 * Did the caller clearly agree? Used by the agent before any write, on the caller's
 * own words since the read-back, never on the model's summary of them. Anything
 * hedged or mixed ("yes, actually no", "I think so?", "sí, pero espere")
 * is not a yes.
 *
 * A plain yes counts in English or Spanish at every clinic, whatever languages it offers: "Sí." at a clinic set to
 * English only is a yes (owner decision, 26 Nov, YES-ANY-LANG: the corpus heard it refused as no_clear_yes). Short,
 * ambiguous words count only as the whole answer. A hedge in any language blocks it, because a caller who switches
 * languages to say "wait" still means wait.
 */
export function isClearYes(callerTextSinceReadback: string, languages: readonly Language[]): boolean {
  // "is it booked now?" only checks on the change: neither a yes nor a doubt, so it is taken out first (a test call,
  // 2026-11-16: two plain answers with a check like that in them were refused, and the caller was asked for set words)
  const t = withoutDoneCheck(normalise(callerTextSinceReadback)).trim();
  if (!t) return false;
  const whole = t.replace(/[.,!¡?¿]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "can you confirm it?", "¿me lo puede confirmar?": asking for the change itself, said as a question
  if (languages.some((l) => CONFIRM_REQUEST[l].test(whole))) return true;
  const yes = LANGUAGES.some((l) => PACKS[l].yes.test(t) || PACKS[l].yesAlone.test(whole.replace(/^(?:so|and|then|entonces|pues|y)\s+/, '')));
  const hedge = LANGUAGES.some((l) => PACKS[l].hedge.test(t));
  return yes && !hedge;
}

/**
 * A caller checking that the change is done, not answering it: "is it booked now?", "are we all set?", "did it go
 * through?", "¿ya está?", "¿ya quedó?". With its own question mark. Never a doubt, never a yes. "He's" and "she's" are
 * there for "it's" as a transcriber may write it.
 */
const DONE_CHECK = /¿? ?\b(?:(?:so|and|then|entonces|asi que|y) )?(?:(?:are|is|was) (?:you|we|it|that|this|he|she)|(?:you|we|it|that|this|he|she) (?:are|is|was)|you'?re|we'?re|it'?s|that'?s|he'?s|she'?s)(?: all)? (?:done|finished|set|sorted|booked|moved|confirmed|through)(?: (?:with|now|then))?(?: (?:it|that|this|everything|your work|the work|my (?:visit|appointment|booking)))?\b ?[?.!]?|\bdid (?:it|that) go through\b ?[?.!]?|¿? ?\b(?:(?:entonces|asi que|y) )?(?:ya )?(?:esta|quedo|queda) (?:hech[oa]|list[oa]|confirmad[oa]|reservad[oa]|cambiad[oa])\b ?[?.!]?|¿ ?ya (?:esta|quedo) ?\?/g;
/** The caller's words (normalised) without a check that the change is done. */
export function withoutDoneCheck(normalisedText: string): string {
  // one space between words first: DONE_CHECK matches single spaces only (no unbounded repeats to backtrack on)
  return trimEdges(normalisedText.replace(/\s+/g, ' ').replace(DONE_CHECK, ' ').replace(/\s+/g, ' '), ' ,.;:', ' ,;:');
}

/** The text without these characters at its start and end: a loop, not a regex (`[…]+$` backtracks on long runs of spaces). */
function trimEdges(text: string, start: string, end: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && start.includes(text[a]!)) a++;
  while (b > a && end.includes(text[b - 1]!)) b--;
  return text.slice(a, b);
}

/** Asking for the change to be made, as a question: "can you confirm it?", "could you just book it please?", "¿me lo puede confirmar?". */
const CONFIRM_REQUEST: Record<Language, RegExp> = {
  en: /^(?:(?:can|could|will|would) you (?:please )?|please )?(?:just )?(?:go ahead and )?(?:confirm|book|finali[sz]e|do) (?:it|that|this|me)(?: for me)?(?: please| now| then)?$/,
  es: /^(?:(?:me )?(?:lo |la )?(?:puede|podria) (?:usted )?)?(?:confirmar(?:lo|la|me|melo|mela)?|confirmemelo|confirmemela|confirmelo|confirmela|reservar(?:lo|la)?|hacer(?:lo)?)(?: por favor| ya)?$/,
};

/**
 * The caller's answer to a question, from everything they said since it was asked, in pieces: the latest piece with
 * something in it besides checking the line is still up ("hello?", "are you there?", "um"), with those checks taken
 * out. "Yes." then "Hello, are you there?" is a yes, and so is "Yes, hello, are you there?" (a test call heard its
 * number question five times, 2026-11-03); "yes" then "wait, no", or "yes, is that Thursday?", is not. With nothing
 * left in any piece, the latest piece, as before.
 */
export function answerAcrossPieces(pieces: readonly string[], languages: readonly Language[]): string {
  void languages;
  for (let i = pieces.length - 1; i >= 0; i--) {
    // a check that the change is done ("is it booked now?") is not an answer either: the piece before it decides
    const rest = withoutDoneCheck(normalise(pieces[i]!).replace(CHECK_INS, ' ')).replace(/^[\s,.!?¿¡]+|[\s,]+$/g, '').replace(/\s+/g, ' ').trim();
    if (rest) return rest;
  }
  return pieces.at(-1) ?? '';
}
/** Checking the line is still up, in a piece of an answer (after `normalise`). Never "hmm": that is a doubt. */
const CHECK_INS = /[¿¡]?\b(?:hello|hey|hola|oiga|alo|are you (?:still )?there|you there|still there|can you hear me|sigue ahi|esta ahi|me escucha|me oye|um+|uh+|erm)\b[\s,.!?]*/g;

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
// "ya está bien, gracias" and "that's all, thanks" close a call too, the thanks with them (call quality R9, 2026-11-19)
const LEAVING = /\b(bye|goodbye|good bye|ya esta (?:bien|todo),? gracias|eso (?:es|seria) todo,? gracias|(?:that'?s|that is) all,? (?:thanks|thank you)|(?:no,? )?(?:it'?s|that'?s) (?:fine|all),? (?:thanks|thank you)|(have|got|need) to (go|run)|gotta go|talk (to you )?later|(i'?ll|i will|i'?m going to) (call|ring|phone) (you |u )?(back|again)( later| another time| tomorrow)?|call (you )?back later|(i'?ll|i will) get back to you|another time|adios|hasta luego|chao|chau|me tengo que ir|tengo que (irme|colgar)|hablamos (luego|despues|mas tarde|otro dia|manana)|((te|le|la|lo) )?(vuelvo a llamar|volvere a llamar)( luego| despues| mas tarde| otro dia| manana)?|((te|le|la|lo) )?(llamo|llamare) (luego|despues|mas tarde|otro dia|manana)|(despues |luego )?(te|le) (aviso|confirmo) (luego|despues|mas tarde))\b/;

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

/**
 * Whether the caller asks, in their own words, to be sent a text: "can you send me the text?", "you can send me text",
 * "text me the details", "¿me lo puede mandar por mensaje?". Asking for it is their consent (call quality Q2,
 * 2026-11-18: a caller asked three times and heard "I can't send it right now" each time). "Don't text me" and "I
 * didn't get the text" are not asking.
 */
export function asksForText(callerText: string): boolean {
  const t = normalise(callerText).replace(/\s+/g, ' ');
  if (new RegExp(NO_TEXT.source).test(t)) return false;
  return ASKS_TEXT.some((p) => p.test(t));
}
const ASKS_TEXT = [
  /\btext (?:me|it|that|this|them|those)\b/,
  /\bsend (?:me |it |that |this |them |those )?(?:to me )?(?:a |the |by |in a |over )?(?:text|message|sms)\b/,
  /\b(?:send|text) (?:me |it |that )?(?:the )?(?:details|info|information|address|hours|directions)(?: by| in a| over)? (?:text|message|sms)\b/,
  /\b(?:me )?(?:lo |la |los |las )?(?:puede|podria|pueden|podrian)? ?(?:mandar|enviar|mande|envie|mandame|enviame|mandeme|envieme|mandarme|enviarme)(?:lo|la|los|las)?\b[^.?!]{0,30}\b(?:mensaje|texto|sms)\b/,
];

/**
 * isClearYes for a read-back with a time: an answer that names the time offered, with nothing that hedges it, is a yes
 * too ("9:20", "yes, 9:20", "okay, 9:20 is fine"; call quality Q3, 2026-11-18). A question or "but" still is not.
 */
export function isClearYesTo(answer: string, languages: readonly Language[], when: { start: Date; timeZone: string } | null): boolean {
  if (isClearYes(answer, languages)) return true;
  if (!when) return false;
  const t = withoutDoneCheck(normalise(answer)).trim();
  if (!t || LANGUAGES.some((l) => PACKS[l].hedge.test(t))) return false;
  return t.split(/\s+/).length <= 8 && saysClockTime(t, when.start, when.timeZone);
}

/** Short words heard in each language on their own, besides its sentence words: what a voice in the room says. */
const FRAGMENT_WORDS: Record<Language, Set<string>> = {
  en: new Set([...SENTENCE_WORDS.en, 'great', 'right', 'sorry', 'hey', 'wait', 'okay', 'ok', 'cool', 'nice', 'really', 'what', 'who', 'come', 'here', 'go', 'stop']),
  es: new Set([...SENTENCE_WORDS.es, 'excelente', 'bueno', 'oye', 'mira', 'listo', 'perfecto', 'claro', 'vale', 'quien', 'momento', 'vamos', 'ven', 'dime', 'oiga', 'llamada', 'inmovil']),
};

/**
 * A stray fragment, not the caller's turn (call quality Q5, 2026-11-18: "Excelente" and "Quiero" from the room were
 * acted on during an English call): one or two words, all of them another language's and none the call's own, and not a
 * yes, a no, a number or a request to end the call ("hang up" is always heard). The same fragment said again is the
 * caller's (`before`: the last fragment set aside, normalised). Background voices on a phone call are this.
 */
export function strayFragment(turn: string, current: Language, before: string | null = null): boolean {
  const text = normalise(turn).replace(/[.,!?¿¡]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean);
  if (!words.length || words.length > 2 || /\d/.test(text)) return false;
  if (before !== null && text === before) return false;
  if (askedToHangUp(text) || saidGoodbye(text)) return false;
  if (words.some((w) => FRAGMENT_WORDS[current].has(w))) return false;
  const own = PACKS[current];
  if (own.yes.test(text) || own.yesAlone.test(text) || own.hedge.test(text)) return false;
  return LANGUAGES.some((code) => code !== current && words.every((w) => FRAGMENT_WORDS[code].has(w)));
}
/** A fragment as strayFragment compares it with the next one. */
export const fragmentKey = (turn: string) => normalise(turn).replace(/[.,!?¿¡]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Only a greeting or "how are you?", nothing asked yet: "Hi, how are you?", "hello, how's it going?", "hola, ¿cómo está?"
 * (call quality Q10, 2026-11-18: it was answered with the clock time and the opening hours). Answered in kind.
 */
export function isSmallTalk(callerText: string): boolean {
  const t = normalise(callerText).replace(/[¿?¡!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t !== '' && SMALL_TALK.test(t);
}
const SMALL_TALK = /^(?:(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening)|hola|buenas|buenos dias|buenas tardes|buenas noches|alo|oiga)(?: there| ivy)? ?)*(?:how are you(?: doing)?(?: today)?|how'?s it going|how are things|how'?s your day|how do you do|you doing ok|como esta(?:s|n)?(?: usted)?|que tal|como le va|como va todo)? ?(?:today|hoy)?$/;

