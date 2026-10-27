// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { PetEmergencyKind } from '../emergency';
import { B, E, PACKS } from '../locales';
import type { EmergencyDestination, IndustryPack } from './types';

const phone = z.string().min(3).max(30).nullable().default(null);

/** Whole words, after the text is normalised (lower case, no accents), in any script. */
const w = (alternatives: string) => new RegExp(`${B}(?:${alternatives})${E}`, 'u');
/** An action, then within a few words what it was done with: "ate half a chocolate bar". */
const near = (first: string, then: string, gap = 40) => new RegExp(`${B}(?:${first})${E}.{0,${gap}}?${B}(?:${then})${E}`, 'u');

const EN_TOXINS = 'chocolate|xylitol|sugar free gum|gum|grapes?|raisins?|antifreeze|rat poison|mouse poison|rodent poison|slug bait|snail bait|lil(?:y|ies)|ibuprofen|advil|tylenol|acetaminophen|aspirin|pills?|medications?|meds|weed|marijuana|cannabis|edibles?|bleach|onions?|garlic|socks?|toys?|string|batter(?:y|ies)|fertili[sz]er|insecticide|poison';
const ES_TOXINS = 'chocolate|xilitol|chicle|uvas?|pasas?|anticongelante|veneno|raticida|ibuprofeno|paracetamol|aspirina|pastillas?|medicinas?|medicamentos?|marihuana|cloro|lejia|cebollas?|ajo|calcetin(?:es)?|juguetes?|pilas?|baterias?|fertilizante|insecticida';

/**
 * Phrases that mean an animal is in danger, as an owner says them. Like the engine's
 * own list, they err toward false positives: sending a worried owner to the emergency
 * hospital costs a trip; missing antifreeze costs the animal. Each one has a test.
 */
const EN: [PetEmergencyKind, RegExp][] = [
  ['pet_toxin', near('ate|eaten|eats|eating|got into|swallowed|chewed|licked|drank|ingested|has had|had some', EN_TOXINS)],
  ['pet_toxin', w('antifreeze|rat poison|mouse poison|rodent poison|slug bait|snail bait|xylitol|poisoned')],
  ['pet_breathing', w("(?:can'?t|cannot|can not|hard to|trouble|struggling to|having trouble) breath(?:e|ing)|not breathing|(?:isn|wasn)'?t breathing|stopped breathing|gasping|choking|open[- ]mouth(?:ed)? breathing|panting (?:hard|heavily|a lot)|heavy panting")],
  ['pet_breathing', w('(?:blue|purple|gr[ae]y|white|pale) (?:gums|tongue)|(?:gums|tongue) (?:are|is|look|looks|turned|went|getting|going) (?:blue|purple|gr[ae]y|white|pale)')],
  ['pet_trauma', w("hit by (?:a |the )?(?:car|truck|vehicle|bike)|got hit|run over|ran over|fell (?:off|from|out of)|attacked by|dog fight|bitten by (?:a |another )?(?:dog|snake|coyote)|snake ?bite|bleeding (?:a lot|badly|heavily)|won'?t stop bleeding|lots of blood|broken (?:leg|bone|jaw|tail)|can'?t (?:stand|get up|walk)|dragging (?:his|her|its|their) (?:back )?legs")],
  ['pet_collapse', w("collapsed|collapsing|unresponsive|unconscious|passed out|won'?t wake up|not waking up|seizures?|seizing|having a fit|fitting|convulsing|convulsions?|dying|going to die")],
  ['pet_bloat', w('bloat(?:ed|ing)?|(?:swollen|hard|distended|tight) (?:belly|stomach|tummy|abdomen)|(?:belly|stomach|tummy|abdomen) (?:is |looks |got |went )?(?:swollen|hard|distended|tight)|retching|dry heaving')],
  ['pet_bloat', near('trying to (?:vomit|throw up|be sick)', 'nothing|nothing comes|can\'?t', 30)],
  ['pet_urinary', w("can'?t (?:pee|urinate)|straining to (?:pee|urinate)|not peeing|hasn'?t peed|no urine|blocked (?:cat|bladder)")],
  ['pet_heat', w('heat ?stroke|overheated|overheating|left in (?:a|the) (?:hot )?car|(?:in|inside) (?:a|the) hot car')],
  ['pet_birth', near('in labou?r|giving birth|whelping|pushing', 'hours|a long time|all (?:day|night)')],
  ['pet_birth', w('(?:puppy|kitten|baby) (?:is )?stuck')],
];

const ES: [PetEmergencyKind, RegExp][] = [
  ['pet_toxin', near('comio|se comio|trago|se trago|mordio|mordisqueo|lamio|bebio|ingirio', ES_TOXINS)],
  ['pet_toxin', w('anticongelante|veneno para ratas|raticida|xilitol|envenenad[oa]')],
  ['pet_breathing', w('no puede respirar|le cuesta respirar|no respira|dejo de respirar|se (?:esta )?ahoga(?:ndo)?|jadea mucho')],
  ['pet_breathing', w('(?:encias|lengua) (?:azul(?:es)?|morad[oa]s?|blanc[oa]s?|palid[oa]s?)')],
  ['pet_trauma', w('l[oa] atropell(?:o|aron)|atropellad[oa]|se cayo (?:de|del)|l[oa] ataco|pelea de perros|l[oa] mordio (?:un|otro) perro|mordedura de (?:serpiente|vibora)|sangra mucho|sangrando (?:mucho|bastante|sin parar)|no para de sangrar|mucha sangre|pata rota|hueso roto|no puede (?:caminar|pararse|levantarse)')],
  ['pet_collapse', w('se desmayo|colapso|se desplomo|se derrumbo|no reacciona|inconsciente|no despierta|convulsion(?:es|a|ando)?|ataque|se (?:esta )?muriendo|se va a morir')],
  ['pet_bloat', w('(?:panza|barriga|abdomen|estomago) (?:hinchad[oa]|dur[oa]|inflad[oa])|arcadas')],
  ['pet_bloat', near('quiere vomitar|intenta vomitar', 'no puede|nada', 30)],
  ['pet_urinary', w('no puede (?:orinar|hacer pis|hacer pipi)|no orina|no ha orinado|se esfuerza (?:para|por) orinar')],
  ['pet_heat', w('golpe de calor|insolacion|(?:lo|la) deje en el (?:carro|coche|auto)|(?:carro|coche|auto) caliente')],
  ['pet_birth', near('pariendo|de parto|dando a luz|empujando', 'horas|mucho tiempo|todo el dia|toda la noche')],
  ['pet_birth', near('horas|mucho tiempo|todo el dia|toda la noche', 'de parto|pariendo|dando a luz|empujando', 20)],
  ['pet_birth', w('(?:cachorro|gatito) (?:atorado|atascado)')],
];

function script(language: 'en' | 'es', to: EmergencyDestination): string {
  const h = to.hospital;
  const spoken = h ? PACKS[language].speakPhone(h.phone) : '';
  if (language === 'es') {
    const go = h
      ? `"Esto suena a una emergencia. Por favor lleve a su mascota ahora mismo a ${h.name}, en ${h.address}. Su número es ${spoken}."`
      : '"Esto suena a una emergencia. Por favor lleve a su mascota ahora mismo al hospital veterinario de emergencias de 24 horas más cercano."';
    return 'Quien llama puede estar describiendo una emergencia de un animal. Deje la tarea actual ahora. Diga, con calma y claridad: '
      + `${go} Luego diga: "Si una persona está herida o en peligro, llame al ${to.emergencyNumber}." `
      + (to.textOffer && h ? 'Luego ofrezca una vez: "Le puedo enviar la dirección y el teléfono del hospital por mensaje ahora mismo, ¿quiere?" ' : '')
      + 'No dé consejos médicos ni de primeros auxilios, no pregunte por los síntomas y no siga con la reserva. '
      + 'Si quien llama dice que el animal está bien y que no es una emergencia, puede continuar.';
  }
  const go = h
    ? `"This sounds like an emergency. Please take your pet to ${h.name} at ${h.address} right away. Their number is ${spoken}."`
    : '"This sounds like an emergency. Please take your pet to the nearest 24-hour emergency vet right away."';
  return 'The caller may be describing an animal emergency. Stop the current task now. Say, calmly and clearly: '
    + `${go} Then say: "If a person is hurt or in danger, call ${to.emergencyNumber}." `
    + (to.textOffer && h ? 'Then offer once: "I can text you the hospital\'s address and number right now; shall I?" ' : '')
    + 'Do not give medical or first-aid advice, do not ask about symptoms, and do not continue booking. '
    + 'If the caller says the animal is safe and it is not an emergency, you may continue.';
}

/** Veterinary clinics: the patient is a pet, found by its owner's name, its own name and the owner's phone. */
export const vet: IndustryPack = {
  id: 'vet',
  name: 'Veterinary clinic',
  terms: { business: 'clinic', patient: 'pet', patients: 'pets', provider: 'veterinarian', providers: 'veterinarians' },
  identity: 'pet',
  prompt: {
    identify: [
      'Before booking, ask which pet the visit is for; an owner may have several. To find a pet you need the owner\'s first name, the pet\'s name and the phone number on file (usually the number they are calling from). Ask only for what the caller has not said yet, one thing at a time. Never ask for a last name unless the backend asks for it. If the pet is new to the clinic, say you can add them, and never ask for the phone number on its file: it has none yet. Then ask only what you do not know yet: what kind of animal it is (not when they said "my cat" or "my dog"), whether it is female or male (not when they said "she", "her", "he" or "him"), and its age or birthday with the year. A rough age ("about two", "around eight months") is enough: never ask for a closer one.',
      'Never ask again for something the caller already told you on this call: their name, the pet\'s name, the phone number, the kind of animal or the pet\'s sex. If you are unsure, read back what you have and ask them to confirm it in one question.',
    ],
    preferences: ['If the caller would like a particular veterinarian, or a vet who sees their kind of animal, tell the backend.'],
    limits: ['Never give medical or first-aid advice for an animal, never say whether something is serious, never discuss symptoms, medicines or doses beyond noting what the caller wants, and never say a refill is approved.'],
  },
  planner: {
    rules: [
      'Rules: find the pet (the owner\'s first name, the pet\'s name and the phone on file) before booking, changing or reading anything of theirs. Anyone may hear the veterinarians, hours and open times without being found: answer those from get_clinic_info and find_slots. Before booking, ask which pet the visit is for; one owner may have several, and verify_caller again switches to another. If nothing is found and they say the pet is new to the clinic, add it with register_patient. Offer only slots returned by find_slots.',
      'Choosing the veterinarian: never ask the caller which vet they would like. When they have not named one, search all vets (find_slots puts the pet\'s usual vet first) and say the vet\'s name with each time; a caller who wants a particular vet will say so, and then you search with that provider_id. Some vets see only some animals, or see exotic pets (rabbits, birds, reptiles): get_clinic_info lists what each one sees. For an animal that is not a dog or a cat, pass the animal to find_slots as the specialty. If the caller only describes symptoms, do not decide what kind of visit or vet they need: ask, or offer a sick visit. If they have no preference, search all vets: find_slots applies the clinic\'s own rules (the pet\'s usual vet first, only vets who see its kind of animal, the fairest pick among the rest) and its note says what to tell the caller. If the caller asks which vet is best, or asks you to choose: never rank, praise or compare the vets, since every vet here is fully qualified; say you will find the right one for the pet, and search all vets.',
      'Details: pass the owner\'s name, the pet\'s name, the phone, the kind of animal and the pet\'s age or birthday to verify_caller or register_patient as the caller said them: the tool checks them and says exactly what to ask again. Never ask again for a detail the caller already gave on this call: the state line lists them. Someone who says the pet is new (or not registered, or never been here) is never looked up: ask only for what register_patient still needs, each detail once, and call it; it checks the pet is not on file already. Look the pet up again only if they later say it may be on file after all.',
      'An owner who has said who they are but not which pet: call verify_caller with pet_name null. When it returns pets_on_number, ask which one the call is for in the words it gives ("Is this for Biscuit or Max, or a new pet?"); without it, ask which pet, and never say a pet\'s name the caller has not said.',
      'A pet is called by its name, never "he", "she", "him" or "her", until the owner or the record has said its sex ("I can add Susi", not "I can add her"). Ask for the owner\'s first name and the pet\'s name in separate replies, one at a time.',
    ],
    limits: [
      'Never give medical or first-aid advice for an animal, never interpret symptoms, never say whether something is serious, never suggest a medicine or a dose, never promise a refill. Offer a visit or a callback instead; the on-call vet is for emergencies, not questions.',
      'Records (sent to another clinic, a groomer or a boarding place, or for travel): find the pet first, then take a request with create_callback, with the reason starting "Records request:" and saying where they should go. Never read records out on the phone.',
      'A pet\'s visits: once the pet is found, visit_summary gives its next visits, its last visit and its usual vet, and nothing else. Use it only when the owner asks ("when was Biscuit last in?", "who saw him?", "when is his next visit?") and answer just that question; never read out a list of visits unasked, and never count visits ("8 visits this year"): only the last and the next. A past visit is always said as the last visit you can see, in the words visit_summary gives, because only visits booked or recorded here are known. What a vet found, diagnoses, test results, medicines and doses, weights, vet notes, invoices, the full history or a copy of the records are never said: offer, in the words visit_summary gives, to have the team send the records in writing, and on a yes take a create_callback with the reason starting "Records request:".',
    ],
    descriptions: {
      verify_caller: 'Find the pet by the owner\'s first name (a full name if they gave one), the pet\'s name and the phone number on file (null: the number they are calling from) before booking, changing or reading anything of theirs. Pass species when the caller has said what kind of animal it is ("my cat Mango"), else null. Call it again to switch to another of the owner\'s pets. When the owner has said who they are but not which pet, call it with pet_name null: on a call with caller ID it may return pets_on_number, their pets\' first names to ask about; otherwise it says to ask which pet.',
      visit_summary: 'Only after the pet is found, and only when the owner asks about its visits: the pet\'s next visits (when, vet, kind of visit), its last visit that is booked or recorded here, and its usual vet. Nothing medical, ever.',
      register_patient: 'Add a new pet, when the caller says the pet is new to the clinic (no lookup first: this checks the pet is not on file already) or verify_caller found nothing and they say it is new. Needs the pet\'s name, the owner\'s first name (and last name if they gave it), the kind of animal (dog, cat, rabbit...), its sex (female, male, or unknown), its birthday or age as the owner says it, and the phone (null: the number they are calling from). The pet is then found and can book.',
      get_clinic_info: 'Hours for today and the next 7 days, the veterinarians (what animals and services they see, weekly hours, time off, whether they take new patients, and the clinic\'s own details on each, such as qualifications, under details), the visit types, the emergency hospitals, and the clinic FAQ. Also returns passages from the clinic\'s documents when the FAQ has no answer. No identity needed.',
      find_slots: 'Find up to 3 open appointment slots, optionally with one veterinarian (provider_id), or with the vets who see a kind of animal or service from get_clinic_info (specialty). No identity needed: use it to answer "who is free Monday" before asking who they are. Returns slot ids to offer. Set from_date to the first day the caller asked for ("next week" is the coming Monday); null means today. from_time is the earliest time of day they want ("after 3" is 15:00, "at 10:30" is 10:30), else null.',
      create_refill_request: 'Log a refill request for the pet\'s medication, for a vet to approve. Pharmacy may be "pick up at the clinic". Never approve or promise a refill. callback_number: the number they give, or null when the number they are calling from is fine.',
    },
  },
  toolArgs: {
    // the owner's first name (or full name), the pet's name, and the phone number on the pet's file: null means the number they are calling from
    // species: the kind of animal when the caller has said it ("my cat Mango"), kept so it is never asked again; not part of the lookup
    // pet_name null: the owner said who they are and no pet yet; with caller ID, the result names their pets on this number to pick from
    verify_caller: z.object({ owner_name: z.string().trim().min(2), pet_name: z.string().trim().min(1).max(60).nullable().default(null), phone, species: z.string().trim().min(2).max(40).nullable().default(null) }),
    // a new pet, after verify_caller found nothing and the caller said the pet is new
    register_patient: z.object({
      pet_name: z.string().trim().min(1).max(60), owner_name: z.string().trim().min(2).max(120),
      // what kind of animal: dog, cat, rabbit, parrot
      species: z.string().trim().min(2).max(40),
      sex: z.enum(['female', 'male', 'unknown']),
      // as the owner says it: a date, or an age ("3 years", "six months")
      birthday_or_age: z.string().trim().min(1).max(60),
      phone,
    }),
  },
  emergency: {
    phrases: { en: EN, es: ES },
    script: (language, to) => script(language, to),
    safe: {
      en: w("not an? emergency|isn'?t an emergency|no emergency|not urgent|(?:he|she|it|they)(?:'?s| is| are|'?re) (?:fine|ok|okay|alright|all right|safe|doing (?:fine|well|ok|okay|great)|totally fine|completely fine)(?: now)?|(?:he|she|it|they) seems? (?:fine|ok|okay|alright|all right)"),
      es: w('no es (?:una )?emergencia|no es urgente|(?:ya )?esta (?:bien|perfecto|tranquilo|tranquila)|(?:el|ella) esta bien'),
    },
  },
};
