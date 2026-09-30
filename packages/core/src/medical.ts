// SPDX-License-Identifier: AGPL-3.0-only
import { normalise, words } from './locales/types';

/**
 * Questions only a clinician may answer: how much of a medicine to take, whether to
 * take it, what it does with something else, what a symptom means. Checked in code
 * before the clinic's documents are searched, so a document that mentions a
 * medication can never become dosing advice, whatever the model would do with it.
 * Like the emergency list, it errs toward refusing: a caller who asks "how much is a
 * visit" is not caught, but "how much should I take" is.
 */
/** Medicines callers name, brand and generic, in the spellings transcribers return. */
const DRUGS = 'ibuprofen|advil|motrin|tylenol|acetaminophen|paracetamol|napa|panadol|aspirin|aleve|naproxen|insulin|metformin|lisinopril|amlodipine|atorvastatin|losartan|levothyroxine|amoxicillin|azithromycin|antibiotics?|benadryl|diphenhydramine|zyrtec|claritin|prednisone|warfarin|eliquis|xarelto|ozempic|semaglutide|melatonin|nyquil|dayquil|sudafed|omeprazole|gabapentin|sertraline|zoloft|xanax|ativan|oxycodone|codeine|tramadol|pills?|tablets?|medicines?|medications?|meds|syrup|drops';
const CHILD = 'child|kid|kids|baby|infant|toddler|son|daughter|newborn';

const PATTERNS = [
  // English: a medicine and what to do with it
  words(`(${DRUGS}) (for|before|with|after|while|during)`),
  words(`(${DRUGS}) (dose|doses|dosage|dosing)|dos(e|age|ing) (of|for) (${DRUGS})`),
  words(`how (much|many) (of )?(the |my |this |that |his |her )?(${DRUGS})`),
  words(`how (much|many) .{0,40}for (a|an|my|his|her|the|our) (\\d+ ?(year|month)s? old |little |young )?(${CHILD})`),
  // English
  words('how (much|many) (should|do|can|could) (i|we|he|she|they) (take|give|use)|what (dose|dosage|amount)|(right|correct|safe|max(imum)?|normal) (dose|dosage)|dos(e|age|ing) (of|for)'),
  words('(should|can|could|is it (ok|okay|safe) to) (i|we|he|she|they)? ?(take|stop|skip|double|mix|combine|drink)|(stop|skip|double|halve) (my|the|his|her) (dose|pill|pills|medication|medicine|tablets?)'),
  words('side effects?|interact(ion|s)? with|(safe|okay|ok) (to take|with|during) (pregnan(t|cy)|breastfeeding|alcohol)|is (it|this) (serious|normal|dangerous)|what does (it|this|my) (mean|result)'),
  words('\\d+ ?(mg|milligrams?|ml|units?|tablets?|pills?)'),
  // Spanish, without accents: text is normalised first
  words('cuant(o|a|os|as) (debo|puedo|tengo que) tomar|que dosis|la dosis|puedo tomar|debo tomar|efectos secundarios|dejar de tomar'),
  // Bangla, both scripts
  words('কতটুকু খাব|কয়টা খাব|ডোজ|কত মিলিগ্রাম|খেতে পারি|ওষুধ বন্ধ|koto ta khabo|kotota khabo|koyta khabo|dose koto|khete pari'),
];

/** What the assistant says when the clinic's documents do not answer a question. */
export const NO_INFORMATION = "I don't have that information, I can have someone call you back.";
/** And when the question is one only a clinician may answer. */
export const MEDICAL_REFUSAL = "I can't give medical advice, but I can have someone from the care team call you back.";

export function isMedicalQuestion(text: string): boolean {
  const t = normalise(text);
  return PATTERNS.some((p) => p.test(t));
}
