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

/** Pet medicines, for the dose questions only: named in a refill ("a refill of Apoquel for Bella") they ask nothing. */
const VET_DRUGS = 'rimadyl|carprofen|metacam|meloxicam|galliprant|apoquel|cerenia|trazodone';
/** What a dose is counted in: "two pills", "half a tablet", "dos pastillas". */
const DOSE_UNIT = 'tablets?|pills?|capsules?|doses?|teaspoons?|drops|tabletas?|pastillas?|capsulas?|pildoras?|dosis|gotas|cucharaditas?';
/**
 * An amount of a medicine: "25 mg", "two pills", "dos pastillas", or a part ("half a", "a quarter of", "media") only when a
 * medicine, a pill or a dose word follows: "half an hour", "a half day" and "media hora" are no amount (review).
 */
const AMOUNT = `\\d+(?:[.,]\\d+)? ?(?:mg|milligrams?|miligramos?|ml|mililitros?|cc|units?|unidades|${DOSE_UNIT})`
  + `|(?:one|two|three|four|five|a couple of|a few|una?|dos|tres|cuatro|cinco) (?:${DOSE_UNIT})`
  + `|(?:half (?:a|an|of (?:a|an|the|his|her|my|its))|a half(?: of)?(?: a| an)?|(?:a )?quarter (?:of )?(?:a|an)|medi[oa]|un cuarto de(?: una?)?) (?:\\w+ )?(?:${DOSE_UNIT}|${DRUGS}|${DRUGS_ES}|${VET_DRUGS})`;
const SOMEONE = 'him|her|it|them|my \\w+|the \\w+|our \\w+|his \\w+';
/** A pet's own amount, said as theirs: "her usual 25 mg", "his normal dose". */
const OWN = '(?:(?:her|his|its|their|the|my|our) )?(?:usual |normal |regular |daily |same )?';
/**
 * A dose asked with an amount or a dosing verb, whatever the amount (the owner's decision, 2026-11-26: a dosing answer
 * is a safety risk): "can I give him 25 mg of Benadryl?", "is 50 mg OK?", "can she have half a Tylenol?", "how many mg",
 * "¿le puedo dar 25 mg?", "¿puede tomar media pastilla?". A refill naming its own dose asks none of these.
 */
const DOSE = [
  words(`(?:should|can|could|may) (?:i|we) give (?:${SOMEONE})? ?${OWN}(?:${AMOUNT})`),
  words(`is it (?:ok|okay|safe|fine|alright|bad) to give (?:(?:${SOMEONE}) )?${OWN}(?:${AMOUNT})`),
  words(`(?:is|are|would|will) (?:${AMOUNT})(?: of)?(?: \\w+)? (?:ok|okay|safe|fine|alright|too much|enough|right)`),
  words('how (?:much|many) (?:mg|milligrams?|ml|cc|units?|tablets?|pills?|capsules?)'),
  words(`(?:can|could|should|may) (?:he|she|it|they|${SOMEONE}) (?:have|take|get|eat) (?:(?:${AMOUNT})|(?:some |a |an |any )?(?:of )?(?:my |his |her |the |our )?(?:${DRUGS}|${VET_DRUGS}))`),
  words(`(?:le |les )?(?:puedo|podemos|debo|deberia) dar(?:le|les)? (?:${AMOUNT})`),
  words(`(?:le|les) (?:doy|damos|di) (?:${AMOUNT})`),
  words(`(?:puede|pueden|podria|deberia|debe) (?:tomar|tomarse|comer|recibir) (?:(?:${AMOUNT})|(?:un poco de |algo de |una? )?(?:${ANY_DRUG}|${VET_DRUGS}))`),
  words(`(?:es|son|seria) (?:${AMOUNT})(?: de)?(?: \\w+)? (?:mucho|demasiado|seguro|suficiente|bien|ok)`),
  words('cuant(?:o|a|os|as) (?:mg|miligramos?|ml|mililitros?|pastillas?|tabletas?|capsulas?|gotas)'),
];

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
/** And when the question is one only a clinician may answer: a question, so the caller chooses before anything is taken (the owner's live rerun, 2026-11-26). */
export const MEDICAL_REFUSAL = "I can't give medical advice. Would you like a visit with one of our vets, or a call back from our team?";

/** A bare amount ("16 mg", "two tablets"): a dose question when asked, but also how a refill is named. */
const QUANTITY = words('\\d+ ?(mg|milligrams?|miligramos?|ml|mililitros?|units?|unidades|tablets?|tabletas?|pills?|pastillas?)');

/**
 * Whether a question is one only a clinician may answer. `quantities: false` leaves out
 * a bare amount, for the caller's recent turns: "a refill of Apoquel 16 mg" must not
 * make the next question, "what time do you close?", a medical one.
 */
/**
 * "What medicine should I give my cat for fleas?": which medicine to give, asked of the assistant (step 4, an adversarial
 * eval). Never when the caller asks about their pet's own medicine to refill it or forgot its name: that is the record,
 * and a refill request (review 4).
 */
const WHICH_MEDICINE = [
  words('what (medicine|medicines|medication|medications|meds|drug|drugs|pill|pills|remedy|remedies|treatment) (can|could|should|do|would) (i|we) give'),
  words('que (medicina|medicinas|medicamento|medicamentos|remedio|remedios|pastilla|pastillas|tratamiento) (le |les )?((puedo|podemos|debo|deberia) dar(le|les)?|doy|damos)'),
];
// only the pet's own, current medicine: "a refill of it", "the one she's on", "her heart pill refill", a forgotten name,
// "la receta de nuevo"; never "every day" or a bare "refill", which still ask for advice (final review)
const ABOUT_THEIR_OWN = words('refill (of|for) (it|her|his|its|that|them|the same)|(her|his|its) (current |usual |regular |own )?(medicine|medication|meds|pills?|tablets?|heart pill|prescription) refill|the one (she|he|it)\'?s (on|taking)|(forgot|forget|don\'?t remember|can\'?t remember) (the|its|her|his) name|(la|su) receta (de nuevo|otra vez)|renovar (la|su) receta|resurtir|olvide (el|su) nombre|no (me )?acuerdo (del|de su) nombre|la que (ya )?toma');

export function isMedicalQuestion(text: string, opts: { quantities?: boolean } = {}): boolean {
  const t = normalise(text);
  return PATTERNS.some((p) => p.test(t)) || DOSE.some((p) => p.test(t)) || (WHICH_MEDICINE.some((p) => p.test(t)) && !ABOUT_THEIR_OWN.test(t)) || (opts.quantities !== false && QUANTITY.test(t));
}

/**
 * Talk about how the assistant works, which a caller must never hear (note 49 B2: a test call heard "It's still running
 * in the background" and "the information returned is only an address"). One list for the voice's prompt, the eval
 * check on every line handed to the voice, and the check on what it said in a live run. English and Spanish. A change
 * explained as internal state is one too (T5, a tester's call 2026-11-24: "The earlier tentative change won't be used").
 */
export const INTERNAL_TALK = /\b(?:in the background|lookups?\b|still waiting on\b|(?:i'?m |i am )?(?:still )?waiting for (?:that|it|this|the (?:request|change|booking|cancellation)|that (?:request|change)) to (?:complete|finish|go through|come back)|until it (?:finishes|completes|is done|goes through)|as soon as it'?s ready|esperando a que (?:termine|se complete)|hasta que termine|waiting (?:on|for) (?:that|the|this|my|a) (?:lookup|search|check|result|system)|(?:lookup|search) to (?:finish|come back|load)|esperando (?:que termine )?(?:la busqueda|el resultado)|still loading|the (?:information|info|result|results|data|details) (?:i |that )?(?:got back|returned|came back|i (?:got|received|have here)|(?:it |that )?(?:returned|shows|says))|i got back|what came back|(?:the|my) system\b|(?:the|my|our) (?:tool|tools|database|lookup|search results?)\b|(?:a|the) tool\b|en segundo plano|(?:la|los) (?:informacion|resultados?|datos) (?:que )?(?:recibi|obtuve|devolvio|volvio|me (?:dio|llego))|(?:el|mi) sistema\b|mis instrucciones\b|instrucciones (?:internas|ocultas|del sistema)|\bmi prompt\b|my (?:internal |hidden )?(?:instructions|prompt|system prompt)\b|(?:internal|hidden) (?:instructions|system prompt)|la herramienta|tentative (?:change|booking|cancell?ation|one)|earlier (?:change|proposal)|(?:won'?t|will not) be used|waiting to (?:be )?confirm(?:ed)?|(?:i )?had waiting|pending (?:change|booking|cancell?ation)|the one (?:booked|made) on this call|cambio (?:pendiente|provisional)|no se (?:usara|va a (?:hacer|usar)))/i;
/** Whether a line talks about how the assistant works (after accents are folded: "información" is "informacion"). */
export function talksAboutInternals(line: string): boolean {
  return INTERNAL_TALK.test(line.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

/**
 * The filler preambles a reply never opens with (call quality R7, 2026-11-19; PR #191), named in every voice's prompt
 * from this one list (CQ2-R7), and the check on a reply's opening words: a scripted eval's reply, or a live transcript.
 */
export const FILLER_PREAMBLES = ['Let me…', 'Okay, let me…', 'Sure, I can help with that', 'Let me think this through', "I'll set that up and confirm"] as const;
/** The list as the prompts quote it: "Let me…", "Okay, let me…", ... */
export const FILLER_PREAMBLE_LIST = FILLER_PREAMBLES.map((p) => `"${p}"`).join(', ');
// an opening acknowledgement or two ("Okay,", "One moment,", "Sure, one moment,") then "let me…" / "déjeme…" / "déjame…";
// never "let me know" (an offer, not a preamble): CQ2-R7, review 3
const ACKS = String.raw`(?:(?:okay|ok|so|alright|all right|sure|got it|right|one moment|one sec(?:ond)?|just a moment|bueno|vale|claro|un momento|un segundo|listo)[,.]?\s+){0,2}`;
const OPENS_WITH_FILLER = new RegExp(String.raw`^\s*${ACKS}(?:let me\b(?!\s+know\b)|d[eé]j[ae]me\b|perm[ií]t[ae]me\b)|^\s*sure,? i can help with that\b|^\s*i'?ll set that up and confirm\b|^\s*claro,? (?:le|lo|la) (?:puedo )?ayud(?:o|ar) con eso\b`, 'i');
/** Whether a reply opens with a filler preamble ("Let me check...", "Okay, let me...", "Déjeme ver..."). */
export const opensWithFillerPreamble = (line: string) => OPENS_WITH_FILLER.test(line);
