// SPDX-License-Identifier: AGPL-3.0-only
import { type EmergencyRoute, normalise } from '@attendra/core';

/**
 * An animal's emergency on a call, as a small state machine in code (batch 1b; FRIDAY notes, Vetra call 29b3d0a6):
 *
 *   flagged ──(the question said)──► asked ──yes / "not sure"──► escalated ──(a clear no later)──► cleared
 *                                      │                                                              ▲
 *                                      ├── a clear no ("no, not now", "a regular checkup") ───────────┘
 *                                      └── a bare "it's not an emergency": one question about the sign, then the same
 *
 * One question after a red flag; the route (a hospital, or a live transfer) only on a yes or "not sure"; a clear no
 * books as usual with a note for the staff and one line on what to do if it comes back. The voice model only says the
 * lines it is handed: it cannot skip the question, repeat the hospital or lift the state itself. A person in danger is
 * not this machine: they hear the public emergency number at once, whatever the clinic's setting.
 */
export type EmergencyStage = 'flagged' | 'asked' | 'escalated' | 'cleared';

/** How the call's emergency ended, for the Calls page: put through, sent to a hospital (and texted), an urgent request, or cleared by the caller. */
export const EMERGENCY_RESULTS = ['transferred', 'hospital_said', 'hospital_texted', 'urgent_request', 'cleared'] as const;
export type EmergencyResult = (typeof EMERGENCY_RESULTS)[number];

export interface EmergencyCase {
  stage: EmergencyStage;
  /** The red flag's kind ('pet_breathing'), 'general' for the bare word, 'borderline' for a sign that may be mild. */
  kind: string;
  /** The words that raised it, as said ("ate some chocolate"), for the staff note. */
  sign: string;
  pet: { name: string | null; species: string | null } | null;
  /** When a line was handed to the voice, and when the voice then said it: the caller's answer is what comes after. */
  sentAtMs: number;
  saidAtMs: number | null;
  /** The one question about the sign was asked (after a bare "it's not an emergency"). */
  signAsked: boolean;
  route: EmergencyRoute | null;
  /** A transfer is on its way, or failed. */
  transfer: 'none' | 'sent' | 'failed';
}

/** The caller's answer to the question, or to the question about the sign. Null: no answer in these words. */
export type EmergencyAnswer = 'yes' | 'unsure' | 'clear_no' | 'bare_not' | null;

// accents folded and lower case (normalise): "sí" is "si"
const UNSURE = /\b(?:not sure|i'?m not sure|i don'?t know|i dunno|dunno|maybe|possibly|i guess|hard to say|no (?:se|lo se)|no estoy segur[oa]|quizas|tal vez|a lo mejor)\b/;
const YES = /^(?:yes|yeah|yep|yup|ya|i think so|it is|(?:she|he|it|they) (?:is|are|still)|please help|help|right now|si|claro|creo que si|ahora mismo|necesito ayuda|ayuda)\b|\b(?:still (?:is|can'?t|cannot|not|having|swelling|bleeding)|getting worse|worse now|sigue (?:igual|mal|sin)|peor)\b/;
/** "It's not an emergency", alone: it denies the word, not the sign. */
const NOT_AN_EMERGENCY = /\b(?:(?:it'?s|its|it is|this is|that'?s) not an? emergency|not an? emergency|isn'?t an emergency|no emergency|not urgent|no es (?:una )?emergencia|no es urgente)\b/;
/** The sign is gone, said as a negative: "not now", "not swelling now", "no longer", "he's not hurt", "ya no". Never a doubt by its own words. */
const GONE = /\b(?:not (?:now|right now|anymore|any more|at the moment)|not \w+(?:ing)? (?:now|anymore|any more)|no longer|no symptoms|(?:she|he|it|they)(?:'?s| is| are|'?re) not (?:hurt|injured|in danger|bleeding|sick)|(?:she|he|it|they) (?:isn'?t|aren'?t) (?:hurt|injured|in danger)|false alarm|ya no|no tiene sintomas|falsa alarma)\b/;
/** The pet is fine now, said as a positive: these count only when not doubted, hoped or asked ("I hope she's fine", "no está bien"). */
const FINE = /\b(?:(?:she|he|it|they)(?:'?s| is| are|'?re|'?ve| has| have) (?:been )?(?:totally |completely |perfectly )?(?:fine|ok|okay|alright|all right|safe|better|normal|good|breathing (?:fine|normally|ok|okay)|doing (?:fine|well|ok|okay|great))|(?:fine|ok|okay|better|normal) now|seems? (?:fine|ok|okay|normal)|stopped|went away|gone now|it'?s fine|ya esta bien|esta bien(?: ahora)?|ya paso|se le paso|(?:el|ella) (?:ya )?esta bien)\b/;
/** The call is routine: "a regular checkup", "just want an appointment", "una revisión". A no to the question, never after a route. */
const ROUTINE = /\b(?:regular|routine|check ?-?up|checkup|vaccin\w*|booster|appointment|just want|revision|chequeo|consulta normal|cita|vacuna\w*)\b/;

/** Before the words in the same clause: a no, a doubt or a wish ("I don't think he's okay", "I hope she's fine", "no está bien"). */
const DOUBT_BEFORE = /\b(?:no|not|never|nunca|hope|hoping|ojala|espero|if|si|whether|maybe|quizas|tal vez|think|creo)\b|n'?t\b/;
/** Where a clause starts again: what comes before it does not change it. */
const CLAUSE = /[.,;:!]|\b(?:but|pero|and now|y ahora)\b/g;

/** Said plainly at least once: not inside a question, and not after a no, a doubt or a wish in the same clause. */
function stated(raw: string, t: string, re: RegExp): boolean {
  if (/[?¿]/.test(raw)) return false;
  for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
    const before = t.slice(0, m.index);
    let start = 0;
    for (const c of before.matchAll(CLAUSE)) start = c.index + c[0].length;
    if (!DOUBT_BEFORE.test(before.slice(start))) return true;
  }
  return false;
}

/**
 * Sorts the caller's words after the question. "Not sure" first (it routes, like a yes); then a yes, unless they also
 * say plainly the sign is gone; a bare "it's not an emergency" only when nothing in it says the sign is gone or the call
 * is routine; then a clear no. `afterRoute`: the route was already said, so only a plain retraction counts ("he's fine
 * now", "not swelling anymore"); "I'd like an appointment for him" is not one, and a plain "no" may answer "Shall I
 * text you the address?".
 */
export function answerTo(words: string, afterRoute = false): EmergencyAnswer {
  const raw = words.trim();
  const t = normalise(raw).replace(/[¿?¡!.,;:]+/g, (p) => (p.includes(',') || p.includes('.') ? ', ' : ' ')).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const question = /[?¿]/.test(raw);
  const gone = !question && GONE.test(t);
  const fine = stated(raw, t, FINE);
  const bare = NOT_AN_EMERGENCY.test(t);
  if (afterRoute) return gone || fine ? 'clear_no' : bare && !question ? 'bare_not' : null;
  if (UNSURE.test(t)) return 'unsure';
  const routine = !question && ROUTINE.test(t);
  // a plain "no" to "Is this still an emergency right now?" (not Spanish "no está bien", which says the pet is not fine)
  const no = !question && /^(?:no|nope|nah)\b(?! (?:esta|es|se|estoy|puede|respira|come|para)\b)/.test(t);
  if (YES.test(t) && !gone && !fine) return 'yes';
  if (bare && !gone && !fine && !routine) return 'bare_not';
  if (gone || fine || routine || no || bare) return 'clear_no';
  return null;
}
/** Clearly in the past: "last week", "a few days ago", "hace unos días". Yesterday and this morning are not: still asked. */
const PAST = /\b(?:last (?:week|month|year)|(?:a few |couple of |two |three |several )?(?:days|weeks|months|years) ago|the other (?:week|month)|la semana pasada|el mes pasado|el ano pasado|hace (?:unos? |dos |tres |varios )?(?:dias|semanas|meses|anos))\b/;
/** Said fine now, in the same words: "she's totally fine now", "no symptoms at all", "está bien". */
const FINE_NOW = /\b(?:(?:she|he|it|they)(?:'?s| is| are|'?re|'?ve| has| have) (?:been )?(?:totally |completely |perfectly |absolutely )?(?:fine|ok|okay|alright|all right|normal|good|great)|(?:fine|ok|okay|normal) now|no symptoms|ya esta bien|esta (?:muy )?bien|no tiene (?:ningun )?sintomas?)\b/;

/**
 * The red flag was in the past and the caller says the pet is fine now, in the same breath: "my dog ate some chocolate
 * last week, she's totally fine now, I just want a checkup" is a clear no already, not a question to ask.
 */
export function pastAndFineNow(text: string): boolean {
  const t = normalise(text);
  return PAST.test(t) && FINE_NOW.test(t);
}

/**
 * The assistant's last question is ours (the emergency question, the one about the sign, or how bad a sign is): only then
 * are the caller's words an answer to it. A "yes" to "is the profile under the number ending 0172?" asked since is not a
 * yes to danger (a test run held a call on it).
 */
const OUR_QUESTION = /emergenc|still having that problem|sigue con ese problema|severe or nonstop|grave o no para/;
export function lastQuestionIsOurs(lastAgentWords: string): boolean {
  const questions = normalise(lastAgentWords).match(/[^.!?]*[?]/g) ?? [];
  return OUR_QUESTION.test(questions.at(-1) ?? '');
}

/** The note on the booking and the request, for the team: what the owner reported, in their words. */
export const staffNote = (sign: string) => `Owner reported "${sign.trim()}" earlier on this call.`;

/**
 * Signs that may be mild (plan 1.8: bleeding, vomiting, limping, not eating), when no red flag was said: one question
 * about how bad it is; heavy or nonstop routes like a red flag, otherwise the soonest sick visit.
 */
export const BORDERLINE = /\b(?:bleeding|bleeds|blood|vomit(?:s|ed|ing)?|threw up|throwing up|been sick|limping|limps|lame|not eating|won'?t eat|stopped eating|off (?:his|her|its) food|diarrh(?:o)?ea|sangra(?:ndo)?|sangre|vomit(?:a|o|ando)|cojea(?:ndo)?|no come|no quiere comer|diarrea)\b/;
/** Heavy or nonstop, in the caller's words about the sign. */
export const SEVERE = /\b(?:a lot|lots|heavy|heavily|badly|nonstop|non-stop|won'?t stop|keeps (?:vomiting|throwing up|bleeding)|all (?:day|night)|every (?:hour|few minutes)|can'?t stop|really bad|severe|mucho|muchisimo|sin parar|no para|todo el dia|toda la noche|grave)\b/;
/** Mild, in the caller's words about the sign: once, a little, it stopped. */
export const MILD = /\b(?:once|just once|one time|a little|a bit|not much|not really|mild|small|stopped|it'?s stopped|seems fine|una vez|solo una vez|un poco|poquito|leve|ya paro|ya se le paso)\b/;
