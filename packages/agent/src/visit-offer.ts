// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, type Language, localName, normalise, type VisitType } from '@attendra/core';
import { askedTopicWords, nameWords } from './knowledge';

/**
 * A visit the caller asks for that is none of the clinic's (grooming, a boarding stay, laser therapy; 2026-11-16). The
 * prompt only listed the visit types and find_slots refused `unknown_visit_type`, with no rule for what the caller hears:
 * the refusal now carries the answer (the clinic's own common question when one covers it, else its visits, the closest
 * first, in the caller's language), the same on the planner path and the tools path. find_slots takes this value for it,
 * since on the tools path its visit_type_id lists only the clinic's own ids.
 */
export const NOT_OFFERED_VISIT = 'not_offered';

/** The rule for both paths, said once (the planner's instructions and the tools path's voice lines). */
export const VISIT_TYPES_RULE = 'Visits: a caller who asks to book something that is none of the clinic\'s visit types (grooming, a boarding stay, laser therapy) is never booked, and never looked for, as another visit in its place: call find_slots with visit_type_id not_offered, and say what it returns (the clinic\'s own answer when it has one, or the visits it books, the closest first, with a request for the team offered). Asked only whether the clinic offers it, look in get_clinic_info first: the clinic\'s own answer, from a common question or a document, wins. A caller who asks what they can book, or is not sure which visit, hears the visit types by name (get_clinic_info). A caller who describes a problem without naming a visit still gets the most likely one.';

/** The visits a caller can book here: never one the team books itself, and for a pet or patient already found or added, only the ones for them. */
export function bookableVisits(clinic: Pick<ClinicConfig, 'visitTypes'>, patient: { isNew?: boolean } | null): VisitType[] {
  return clinic.visitTypes.filter((v) => !v.staffOnly && (!patient || (patient.isNew ? v.audience !== 'existing' : v.audience !== 'new')));
}

/**
 * Up to `max` of the bookable visits, the closest to what the caller asked for first: the most words shared with the
 * visit's name (in any of its languages) or its description ("dental cleaning" puts a dental check-up first). The
 * clinic's own order otherwise.
 */
export function closestVisits(clinic: Pick<ClinicConfig, 'visitTypes'>, asked: string, patient: { isNew?: boolean } | null, max = 5): VisitType[] {
  const wanted = new Set(askedTopicWords(asked));
  const score = (v: VisitType) => {
    const own = new Set(nameWords([v.name, ...Object.values(v.names ?? {}), v.description ?? ''].join(' ')));
    return [...wanted].filter((w) => own.has(w)).length;
  };
  return bookableVisits(clinic, patient).map((v, order) => ({ v, order, score: score(v) }))
    .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, max).map((x) => x.v);
}

/** The visits as the caller hears them, with the ids the next find_slots takes. */
export const visitChoicesIn = (visits: VisitType[], language: Language) => visits.map((v) => ({ id: v.id, name: localName(v, language) }));

/** What the model passed as the visit, in words ("vt_laser_therapy" is "laser therapy"); nothing for not_offered. */
export const askedVisitWords = (visitTypeId: unknown) =>
  typeof visitTypeId === 'string' && visitTypeId !== NOT_OFFERED_VISIT ? visitTypeId.replace(/^vt_/i, '').replace(/[_-]+/g, ' ') : '';

/**
 * "What visits do you have?", "what can I book?", "I'm not sure which appointment", "¿qué tipo de citas tienen?": the
 * caller asks what the clinic books, and hears its visits by name.
 */
const WHAT_VISITS = new RegExp([
  String.raw`\bwhat (?:kinds?|types?|sorts?) of (?:visits?|appointments?|services?|exams?)\b`,
  String.raw`\bwhat (?:visits?|appointments?|services?) (?:do|can|are|does|is)\b`,
  String.raw`\bwhich (?:visits?|appointments?) (?:do|can|are)\b`,
  String.raw`\bwhat (?:can|could) (?:i|we) (?:book|schedule|make an appointment for)\b`,
  String.raw`\bwhat do you (?:book|offer)\b`,
  String.raw`\bnot sure (?:what|which) (?:kind of |type of |sort of )?(?:visit|appointment)\b`,
  String.raw`\bque (?:tipos? de )?(?:citas|visitas|consultas|servicios) (?:tienen|ofrecen|hay|puedo|se pueden|manejan|dan)\b`,
  String.raw`\bque (?:tipos?|clases?) de (?:citas?|visitas?|consultas?|servicios?)\b`,
  String.raw`\bque (?:puedo|podria) (?:reservar|agendar|programar)\b`,
  String.raw`\bno se (?:que|cual) (?:tipo de )?(?:cita|visita|consulta)\b`,
].join('|'));
export const asksWhatVisits = (text: string) => WHAT_VISITS.test(normalise(text));
