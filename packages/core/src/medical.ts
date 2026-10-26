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
/** The same in Spanish, without accents (text is normalised first). Brand names are shared with the English list. */
const DRUGS_ES = 'ibuprofeno|paracetamol|acetaminofen|aspirina|naproxeno|difenhidramina|amoxicilina|antibioticos?|prednisona|insulina|melatonina|omeprazol|gabapentina|codeina|pastillas?|tabletas?|capsulas?|pildoras?|medicinas?|medicamentos?|remedios?|jarabe|gotas|calmantes?|analgesicos?|antiinflamatorios?|antialergicos?';
const ANY_DRUG = `${DRUGS}|${DRUGS_ES}`;

const PATTERNS = [
  // English: a medicine and what to do with it
  words(`(${DRUGS}) (for|before|with|after|while|during)`),
  words(`(${DRUGS}) (dose|doses|dosage|dosing)|dos(e|age|ing) (of|for) (${DRUGS})`),
  words(`how (much|many) (of )?(the |my |this |that |his |her )?(${DRUGS})`),
  words(`how (much|many) .{0,40}for (a|an|my|his|her|the|our) (\\d+ ?(year|month)s? old |little |young )?(${CHILD})`),
  // English
  words('how (much|many) (should|do|can|could) (i|we|he|she|they) (take|give|use)|what (dose|dosage|amount)|(right|correct|safe|max(imum)?|normal) (dose|dosage)|dos(e|age|ing) (of|for)'),
  words('(should|can|could|is it (ok|okay|safe) to) (i|we|he|she|they)? ?(take|stop|skip|double|mix|combine|drink)|(stop|skip|double|halve) (my|the|his|her) (dose|pill|pills|medication|medicine|tablets?)'),
  words('side effects?|interact(ion|s)? with|(safe|okay|ok) (to take|with|during) (pregnan(t|cy)|breastfeeding|alcohol)|is (it|this|that) (serious|normal|dangerous)|what does (it|this|my) (mean|result)'),
  // giving a medicine to someone else: a child, or a pet at a veterinary clinic
  words(`((should|can|could|may) (i|we)|is it (ok|okay|safe|bad) to) give (him|her|it|them|my \\w+|the \\w+|our \\w+)? ?(some |a little )?(of )?(my |his |her |the |our )?(${DRUGS})`),
  words('(should|can|could) (i|we) give (him|her|it|them) (something|anything)|what (can|could|should) (i|we) give (him|her|it|them|my \\w+|the \\w+|our \\w+) for'),
  // Spanish, without accents: text is normalised first. The same questions as the English above, in the same order
  words(`(${ANY_DRUG}) (para|antes de|despues de|con|durante|mientras)`),
  words(`dosis (de|del|para) (${ANY_DRUG})|cuant(o|a|os|as) (de )?(la |el |su |mi )?(${ANY_DRUG})`),
  words('cuant(o|a|os|as) (le |les )?((debo|puedo|tengo que|deberia|hay que) (tomar|dar(le|les)?)|doy|damos)|que dosis|la dosis|(dosis|cantidad) (correcta|segura|maxima|normal)'),
  words('(puedo|debo|deberia|podemos|debemos) (tomar(?! (una |la |el |un )?(cita|turno|consulta|foto))|saltar(me)?|doblar|duplicar|mezclar)|(dejar|suspender|parar) (de (tomar|darle) )?(la |las |el |los |su |sus |mi |mis )(dosis|pastillas?|medicinas?|medicamentos?|tabletas?)'),
  words('efectos secundarios|interaccion(es)? (con|entre)|(seguro|bueno|malo) (tomar(lo|la)? )?(durante el embarazo|en el embarazo|si estoy embarazada|con alcohol|amamantando|dando pecho)|(es|esta|sera) (eso |esto )?(grave|serio|peligroso|preocupante)|es normal que|(?<=^|¿ ?)(es|eso es|esto es) normal(?= ?[?.!]|$)|que (significa|quiere decir)(?= ?[?.!]|$)|que (significa|quiere decir) (eso|esto|el resultado|los resultados)'),
  // giving a medicine to a pet or a child: "¿le puedo dar ibuprofeno a mi perro?", "¿qué le puedo dar para el dolor?"
  words(`((le |les )?(puedo|podemos|debo|deberia|tengo que|se (le )?puede) dar(le|les|selo|sela)?|es (seguro|bueno|malo) dar(le|les)?|(le|les) (doy|damos)) (un poco de |algo de |medi[oa] |una? )?(mi |mis |su |sus |el |la |los |las |este |esta |ese |esa )?(${ANY_DRUG})`),
  words('(le |les )?(puedo|podemos|debo|deberia) dar(le|les)? algo (para|contra)|que (le |les )?(puedo|podemos|debo|deberia) dar(le|les)?( a (mi|su|el|la|nuestro|nuestra) \\w+)? (para|contra)'),
];

/** What the assistant says when the clinic's documents do not answer a question. */
export const NO_INFORMATION = "I don't have that information, I can have someone call you back.";
/** And when the question is one only a clinician may answer. */
export const MEDICAL_REFUSAL = "I can't give medical advice, but I can have someone from the care team call you back.";

/** A bare amount ("16 mg", "two tablets"): a dose question when asked, but also how a refill is named. */
const QUANTITY = words('\\d+ ?(mg|milligrams?|miligramos?|ml|mililitros?|units?|unidades|tablets?|tabletas?|pills?|pastillas?)');

/**
 * Whether a question is one only a clinician may answer. `quantities: false` leaves out
 * a bare amount, for the caller's recent turns: "a refill of Apoquel 16 mg" must not
 * make the next question, "what time do you close?", a medical one.
 */
export function isMedicalQuestion(text: string, opts: { quantities?: boolean } = {}): boolean {
  const t = normalise(text);
  return PATTERNS.some((p) => p.test(t)) || (opts.quantities !== false && QUANTITY.test(t));
}
