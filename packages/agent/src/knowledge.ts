// SPDX-License-Identifier: AGPL-3.0-only
import { normalise } from '@attendra/core';

/**
 * Answers from the clinic's own FAQ, by word overlap. It is deliberately simple for
 * v0.1: a clinic's FAQ is a few dozen entries, the answer must be the clinic's
 * words, not a model's paraphrase of the internet, and a miss is safe (the agent
 * offers a callback). pgvector retrieval over longer documents is on the roadmap.
 */
const STOP = new Set([
  'the', 'a', 'an', 'do', 'you', 'i', 'my', 'is', 'are', 'what', 'how', 'can', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'your', 'me', 'we', 'it', 'if', 'there',
  'que', 'los', 'las', 'una', 'por', 'para', 'con', 'como', 'donde', 'cuando', 'ustedes', 'tienen', 'mi', 'mis',
].map(normalise));
// any script: letters, marks and digits make a word; Latin accents are dropped so "cita" meets "cíta"
// a light stem, so "parking" meets "park" and "located" meets "location"
const stem = (w: string) => (w.length > 5 ? w.replace(/(ing|ies|ied|ed|es|s)$/, '') : w.length > 4 ? w.replace(/s$/, '') : w);
const words = (s: string) => normalise(s).replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

/**
 * An answer that only says the clinic's website has none ("The website does not specify payment methods…"), saved by a
 * website import before it left such questions out (note 49 B5; the cloud's importer has the same words): never said to
 * a caller. The question is treated as not answered.
 */
const NON_ANSWER = /\b(?:the |this )?(?:website|web site|site|page|text)\b[^.]{0,40}\b(?:does not|doesn'?t|did not|didn'?t|is not|isn'?t|has no|gives no|provides no)\b[^.]{0,20}\b(?:specify|specified|provide|provided|mention|mentioned|say|state|stated|list|listed|include|included|contain|give|clear|available|information|details?)\b|\bno (?:information|details) (?:is |are )?(?:given|provided|available|listed|stated|mentioned)\b|\bnot (?:specified|mentioned|stated|provided|listed) (?:on|in) the (?:website|site|page)\b|\b(?:el sitio|la pagina|el sitio web)\b[^.]{0,40}\bno (?:especifica|menciona|indica|dice|incluye|proporciona)\b/i;
export const isNonAnswer = (answer: string) => NON_ANSWER.test(normalise(answer));

/**
 * Words that say a question is about the clinic's offer in general, not what it asks about: "Do you offer boarding
 * services?" is about boarding. A test call asked about boarding and grooming and heard "it isn't listed among the
 * services", from the clinic's broad "What services do you offer?", though it had a common question for each (note 52
 * B1): the broad one shared "offer" and "services" with the question and won the tie, being first. These count a
 * quarter of a topic word.
 */
const GENERIC = new Set(['offer', 'offers', 'offered', 'provide', 'provides', 'service', 'services', 'have', 'has', 'available', 'any', 'clinic', 'practice',
  'pet', 'pets', 'animal', 'animals', 'ofrecen', 'ofrece', 'servicio', 'servicios', 'clinica', 'mascota', 'mascotas'].map(normalise).map(stem));
const weight = (w: string) => (GENERIC.has(w) ? 0.25 : 1);

/**
 * The clinic's common questions that answer this one, best first: each by the weight of the question's words it shares
 * (generic words count little), a tie going to the one whose own question has fewer other words (the more specific).
 * Every common question that covers a topic word the ones before it do not is kept, so "boarding and grooming?" gets
 * both answers. A saved non-answer is never one.
 */
export function answersFromFaqs<T extends { id: string; question: string; answer: string }>(faqs: T[], question: string): T[] {
  const asked = new Set(words(question));
  // a question about a thing ("laser therapy") is answered only by a common question about that thing: one sharing only
  // "offer" or "services" with it is not an answer (call quality Q6, 2026-11-18: "Do you do laser therapy?" got the
  // grooming answer). A question with nothing but those words ("what services do you offer?") still gets the broad one
  const aboutAThing = [...asked].some((w) => !GENERIC.has(w));
  const scored = faqs.filter((f) => !isNonAnswer(f.answer)).map((faq, order) => {
    const own = [...new Set(words(faq.question))];
    const shared = own.filter((w) => asked.has(w));
    return { faq, order, shared, score: shared.reduce((t, w) => t + weight(w), 0), extra: own.length - shared.length };
  }).filter((x) => x.shared.length > 0 && (!aboutAThing || x.shared.some((w) => !GENERIC.has(w))));
  scored.sort((a, b) => b.score - a.score || a.extra - b.extra || a.order - b.order);
  const out: T[] = [];
  const covered = new Set<string>();
  for (const x of scored) {
    const topics = x.shared.filter((w) => !GENERIC.has(w));
    // the first answer always; another only for a topic word not answered yet (never a second "services" answer)
    if (out.length && !topics.some((w) => !covered.has(w))) continue;
    // a broad answer, sharing only generic words, never stands beside a specific one
    if (out.length && !topics.length) continue;
    out.push(x.faq);
    for (const w of topics) covered.add(w);
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Whether a question asks if the clinic does or offers a thing ("Do you do laser therapy?", "Do you offer acupuncture?",
 * "¿Hacen terapia láser?"), as opposed to whether it has one ("Do you have parking?") or takes one (insurance).
 */
export function asksIfOffered(question: string): boolean {
  const t = normalise(question);
  return /\b(?:do|does|can|will) (?:you|you guys|the clinic|your clinic|y'?all) (?:also |even |ever )?(?:do|offer|provide|perform|carry out)\b|\b(?:is|are) (?:\w+ ){1,3}(?:offered|available) (?:here|there|at the clinic)\b|\b(?:hacen|ofrecen|realizan|ofrece|hace|realiza|dan) (?:\w+ )?(?:terapia|tratamiento|servicio|cirugia|acupuntura|\w+)/.test(t);
}

/** The best common question for this one, or null (answersFromFaqs' first). */
export function answerFromFaqs<T extends { id: string; question: string; answer: string }>(faqs: T[], question: string): T | null {
  return answersFromFaqs(faqs, question)[0] ?? null;
}

/**
 * The words that ask for a visit, never say what it is for ("book", "appointment", "cita"): a visit the clinic does not
 * offer is matched to its common questions and its own visits by the rest ("grooming", "laser therapy").
 */
const ASKING = new Set([
  'book', 'booking', 'appointment', 'appointments', 'visit', 'visits', 'schedule', 'make', 'need', 'needs', 'want', 'wants', 'like', 'would', 'could',
  'please', 'get', 'see', 'come', 'bring', 'him', 'her', 'his', 'them', 'they', 'she', 'he', 'have', 'has', 'also', 'too', 'another', 'one', 'some',
  'hola', 'cita', 'citas', 'visita', 'visitas', 'reservar', 'agendar', 'programar', 'hacer', 'quiero', 'quisiera', 'necesito', 'necesita', 'puedo', 'tambien', 'otra', 'otro',
].map(normalise).map(stem));

/** What the caller asked for without the words that only ask for a visit, as they said it ("grooming for Biscuit"). */
const withoutAsking = (text: string) => normalise(text).replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !ASKING.has(stem(w))).join(' ');

/** The words of what the caller asked for, as the clinic's common questions and visit names are read: no stop words, no "book" or "appointment". */
export const askedTopicWords = (text: string) => words(withoutAsking(text));

/** The words of a visit's name or description, for how close it is to what the caller asked for. */
export const nameWords = (text: string) => words(text);

/**
 * The clinic's own answer for something the caller asked to book that is none of its visits ("Can I book grooming for
 * Biscuit?" with a common question about grooming): the best common question that shares a word about the thing itself,
 * never only "services" or "appointment". Null when none does: then the clinic's visits are offered instead (2026-11-16).
 */
export function answerForAsked<T extends { id: string; question: string; answer: string }>(faqs: T[], asked: string): T | null {
  const topic = askedTopicWords(asked);
  if (!topic.length) return null;
  const best = answersFromFaqs(faqs, withoutAsking(asked))[0];
  if (!best) return null;
  const own = new Set(words(best.question));
  return topic.some((w) => own.has(w) && !GENERIC.has(w)) ? best : null;
}
