// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { PetEmergencyKind, SubjectWords } from '../emergency';
import { B, E, PACKS } from '../locales';
import { PROPOSE_IF_EXACT } from '../tool-notes';
import type { EmergencyDestination, IndustryPack } from './types';

// as the caller said it: digits, or words ("seven two oh, triple five..."), read as digits by the backend
const phone = z.string().min(3).max(80).nullable().default(null);

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

/**
 * Who a red flag is about (bySubject): the caller themselves, another person, or an animal. A pet or a person counts when
 * it is someone's ("my dog", "the cat", "her son"), not in passing ("bitten by a dog"). Words like "baby", "boy" and
 * "girl" are left out: owners call their pets that.
 */
const SUBJECTS: Partial<Record<'en' | 'es', SubjectWords>> = {
  en: {
    firstPerson: /(?:^|[^\p{L}'])(?:i|i'?m|im|i am|i'?ve|ive|i have|i got|i feel|me|my)(?: (?:having|getting|got|feeling|been|really|just|also|kind of|some|a|bad|real|this|so|starting to|started))*\s*$/u,
    firstPersonPhrase: w("i|i'?m|me|my|myself"),
    person: w("(?:my|our|his|her|their|the|a|your) (?:husband|wife|son|daughter|kid|kids|child|children|mom|mother|mum|dad|father|partner|boyfriend|girlfriend|friend|grandma|grandmother|grandpa|grandfather|brother|sister|neighbou?r|roommate|coworker|man|woman|person|family)|someone|somebody"),
    pet: w("(?:my|our|his|her|their|the|this|your) (?:\\p{L}+ )?(?:dog|doggy|doggie|pup|puppy|cat|kitty|kitten|pet|rabbit|bunny|bird|parrot|budgie|hamster|guinea pig|ferret|horse|pony|lizard|snake|turtle|tortoise|goat|animal)(?:'s|s)?"),
  },
  es: {
    firstPerson: /(?:^|[^\p{L}])(?:yo|me|mi)\s*$/u,
    firstPersonPhrase: w('me|mi|puedo|estoy|tome'),
    person: w('(?:mi|mis|nuestr[oa]s?|su|sus|el|la|un|una) (?:esposo|esposa|marido|mujer|hij[oa]s?|nin[oa]s?|mama|madre|papa|padre|abuel[oa]|herman[oa]|novi[oa]|amig[oa]|pareja|vecin[oa]|persona|senor|senora)|alguien'),
    pet: w('(?:mi|mis|nuestr[oa]s?|su|sus|el|la|este|esta) (?:perr[oa]s?|perrit[oa]s?|cachorr[oa]s?|gat[oa]s?|gatit[oa]s?|mascotas?|conej[oa]s?|pajar[oa]s?|loro|hamster|huron|caballo|tortuga|animal(?:ito)?)'),
  },
};

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
      'The number comes first: as soon as the caller wants to book, move or cancel a visit, ask the phone number the pet\'s profile is under, in the backend\'s words, and hand it to the backend before anything else (not their name, not the pet). The backend reads a number they say back to them before it searches, then says what it found ("I found Ginger, your dog", or the pets on that number to pick from): say that first, then go on. A direct question about the lookup ("did you find her?", "is he registered?") gets a direct yes or no first. To find a pet you need the phone number on file and the pet\'s name; the owner\'s name is to greet them and for a new pet, never to find one. With caller ID the backend knows the owner: never ask their name. With a number they say, the backend may ask "And the owner\'s name on that profile?" once: say it in its words, and never say a name from the records first. Ask only for what the caller has not said yet, one thing at a time. Never ask for a last name unless the backend asks for it. If the pet is new to the clinic, say you can add them, and never ask for the phone number on its file: it has none yet. Then ask only what you do not know yet: what kind of animal it is (not when they said "my cat" or "my dog"), whether it is female or male (not when they said "she", "her", "he" or "him"), and its age or birthday with the year. A rough age ("about two", "around eight months") is enough: never ask for a closer one.',
      'Never ask again for something the caller already told you on this call: their name, the pet\'s name, the phone number, the kind of animal or the pet\'s sex. If you are unsure, read back what you have and ask them to confirm it in one question. When the backend gives you the call memory, use it.',
      'A caller who asks for a person, the front desk or a real person is never asked for a pet, what kind of animal they have, or offered to add a pet: hand the transfer to the backend at once and say what it gives you.',
    ],
    preferences: ['If the caller would like a particular veterinarian, or a vet who sees their kind of animal, tell the backend.'],
    limits: [
      'Never give medical or first-aid advice for an animal, never say whether something is serious, never discuss symptoms, medicines or doses beyond noting what the caller wants, and never say a refill is approved.',
      'A vet\'s own phone number is private: never say it, text it or offer it. Asked for it, offer to take a message for them or to put the caller through to the front desk. Say a vet\'s name as the backend gives it ("Dr. Ruiz").',
    ],
  },
  planner: {
    rules: [
      'The number first: as soon as the caller wants to book, move or cancel, and before anything else (their name, the pet, a time), ask the phone number the pet\'s profile is under, in the words this prompt gives for the phone. When they answer, call verify_caller at once with that number (phone null when they said yes to the number they are calling from) and pet_name null unless they named a pet: it reads a said number back first, then returns the pets on that number to pick from, or says there are none (then a new owner and pet the usual way, with register_patient). The result of a lookup is said first, in its words ("I found Ginger, your dog."), before any times; a caller who asks "did you find her?" or "is he registered?" gets a direct yes or no first. With caller ID confirmed, never ask the owner\'s name: the backend thanks them by it. With a number they said, the backend asks "And the owner\'s name on that profile?" once for that number and compares it with the records itself: never say a name from the records first, and never say "I don\'t have your name". owner_name is the name the caller gave for the number in this call to verify_caller: never a pet\'s name, and never the name given for another number (a second number on the call is checked with its own owner\'s name).',
      'A number the caller says is wrong when it is read back is not a detail asked a third time: call verify_caller with each new number they give. After two wrong read-backs, or a number with no profile, the backend asks for the last four digits of the number on file and the pet\'s name: say its question, then call verify_caller with phone_last4 and pet_name. Only when that finds nobody, offer the request for the team.',
      'Rules: find the pet (the phone number, which is the household, and the pet\'s name; the owner\'s name never finds a pet) before booking, changing or reading anything of theirs. Anyone may hear the veterinarians, hours and open times without being found: answer those from get_clinic_info and find_slots. Before booking, ask which pet the visit is for; one owner may have several, and verify_caller again switches to another. If nothing is found and they say the pet is new to the clinic, add it with register_patient. Offer only slots returned by find_slots.',
      'Choosing the veterinarian: never ask the caller which vet they would like. When they have not named one, search all vets (find_slots puts the pet\'s usual vet first) and say the vet\'s name with each time; a caller who wants a particular vet will say so, and then you search with that provider_id, with a visit that vet does (get_clinic_info lists each vet\'s visit types) that fits what the caller described, never a check-up for a pet they said is sick. Some vets see only some animals, or see exotic pets (rabbits, birds, reptiles): get_clinic_info lists what each one sees. For an animal that is not a dog or a cat, pass the animal to find_slots as the specialty. If the caller only describes symptoms, do not decide what kind of visit or vet they need: ask, or offer a sick visit. If they have no preference, search all vets: find_slots applies the clinic\'s own rules (the pet\'s usual vet first, only vets who see its kind of animal, the fairest pick among the rest) and its note says what to tell the caller. If the caller asks which vet is best, or asks you to choose: never rank, praise or compare the vets, since every vet here is fully qualified; say you will find the right one for the pet, and search all vets.',
      'Details: pass the owner\'s name, the pet\'s name, the phone, the kind of animal, its sex and the pet\'s age or birthday to verify_caller or register_patient as the caller said them (null for one not said yet, never a guess: the call memory fills what they said earlier): the tool checks them and says exactly what to ask again. Never ask again for a detail the caller already gave on this call: the state line lists them. Someone who says the pet is new (or not registered, or never been here) is never looked up: ask only for what register_patient still needs, each detail once, and call it; it checks the pet is not on file already. Look the pet up again only if they later say it may be on file after all.',
      'A caller who has not named the pet yet: call verify_caller with pet_name null (owner_name null when they have not said who they are). When it returns pets_on_number, ask which one the call is for in the words it gives ("Thanks, Jordan. Is this for Biscuit or Max, or a new pet?"); a pet that is not among them is added under that number with register_patient, owner_name null (the owner on file). Without it, ask which pet, and never say a pet\'s name the caller has not said.',
      'The record: once the call memory says the caller is verified, you may say the pet\'s next visit and its last visit (visit_summary), and "the last visit I can see was with Dr. Ruiz" as the usual vet, when it helps the booking; never anything medical. Not verified: none of that and never a name from the records, but booking, moving, cancelling and adding a pet go ahead as usual.',
      '"The emergency doctor" or "the emergency vet" asked for a booking is a vet\'s title: offer the clinic\'s vets as usual and never mention the emergency hospital unless the caller asks where to go in an emergency or describes a danger sign.',
      'A pet is called by its name, never "he", "she", "him" or "her", until the owner or the record has said its sex ("I can add Susi", not "I can add her"). Ask one thing per reply: the number first, then the pet. Never ask the owner\'s name yourself: pass owner_name null unless they said it, and the backend asks for it only when the number has no owner on file.',
    ],
    limits: [
      'A vet\'s own phone number is private: you never have it and never give one; asked for it, offer a callback request for that vet (create_callback) or the front desk. Say a vet\'s name as the tools give it, with its title ("Dr. Ruiz").',
      'Never give medical or first-aid advice for an animal, never interpret symptoms, never say whether something is serious, never suggest a medicine or a dose, never promise a refill. Offer a visit or a callback instead; the on-call vet is for emergencies, not questions.',
      'Records (sent to another clinic, a groomer or a boarding place, or for travel): find the pet first, then take a request with create_callback, with the reason starting "Records request:" and saying where they should go. Never read records out on the phone.',
      'A pet\'s visits: once the pet is found, visit_summary gives its next visits, its last visit and its usual vet, and nothing else. Use it only when the owner asks ("when was Biscuit last in?", "who saw him?", "when is his next visit?") and answer just that question; never read out a list of visits unasked, and never count visits ("8 visits this year"): only the last and the next. A past visit is always said as the last visit you can see, in the words visit_summary gives, because only visits booked or recorded here are known. What a vet found, diagnoses, test results, medicines and doses, weights, vet notes, invoices, the full history or a copy of the records are never said: offer, in the words visit_summary gives, to have the team send the records in writing, and on a yes take a create_callback with the reason starting "Records request:".',
    ],
    descriptions: {
      verify_caller: 'Find the pet by the owner\'s first name (a full name if they gave one), the pet\'s name and the phone number on file (null: the number they are calling from) before booking, changing or reading anything of theirs. Pass species when the caller has said what kind of animal it is ("my cat Mango"), else null. Call it again to switch to another of the owner\'s pets. When the owner has said who they are but not which pet, call it with pet_name null: on a call with caller ID it may return pets_on_number, their pets\' first names to ask about; otherwise it says to ask which pet. phone_last4: null, unless the backend asked for the last four digits of the number on file; then those four digits as said, with pet_name, and phone null.',
      visit_summary: 'Only after the pet is found, and only when the owner asks about its visits: the pet\'s next visits (when, vet, kind of visit), its last visit that is booked or recorded here, and its usual vet. Nothing medical, ever.',
      register_patient: 'Add a new pet, when the caller says the pet is new to the clinic (no lookup first: this checks the pet is not on file already) or verify_caller found nothing and they say it is new. Needs the pet\'s name; the owner\'s first name only as they said it (null otherwise: on a number with an owner on file the pet joins that owner, and the backend asks for a name only when there is none); the kind of animal (dog, cat, rabbit...), its sex (female, male, or unknown), its birthday or age as the owner says it, and the phone (null: the number they are calling from). The pet is then found and can book. birthday_or_age is the pet\'s age or its birthday as the owner said it: never add a year the owner did not say (a day and month alone is not a birthday); ask how old the pet is instead.',
      get_clinic_info: 'Hours for today and the next 7 days, the veterinarians (what animals and services they see, weekly hours, time off, whether they take new patients, and the clinic\'s own details on each, such as qualifications, under details), the visit types, the emergency hospitals, how the clinic handles emergencies (in plain words, for a caller who asks), and the clinic FAQ. Also returns passages from the clinic\'s documents when the FAQ has no answer. No identity needed.',
      find_slots: 'Find up to 3 open appointment slots, optionally with one veterinarian (provider_id), or with the vets who see a kind of animal or service from get_clinic_info (specialty). No identity needed: use it to answer "who is free Monday" before asking who they are. Returns slot ids to offer. Set from_date to the first day the caller asked for ("next week" is the coming Monday); null means today. from_time is the time of day they named ("after 3" is 15:00, "at 10:30" is 10:30), else null, and time_mode how they said it: at ("is 4 free?", "at 10:30"), around ("around 5"), before ("earlier than 6", "before noon"), after ("after 3"), or earliest (the first times from from_time on); find_slots answers with that exact time first, then the nearest free times on that side. ' + PROPOSE_IF_EXACT,
      create_refill_request: 'Log a refill request for the pet\'s medication, for a vet to approve. Pharmacy may be "pick up at the clinic". Never approve or promise a refill. callback_number: the number they give, or null when the number they are calling from is fine.',
    },
  },
  toolArgs: {
    // the owner's first name (or full name), the pet's name, and the phone number on the pet's file: null means the number they are calling from
    // species: the kind of animal when the caller has said it ("my cat Mango"), kept so it is never asked again; not part of the lookup
    // pet_name null: the owner said who they are and no pet yet; with caller ID, the result names their pets on this number to pick from
    // phone_last4: only when the backend asked for the last four digits of the number on file (the second way to find a profile)
    verify_caller: z.object({ owner_name: z.string().trim().min(2).nullable().default(null), pet_name: z.string().trim().min(1).max(60).nullable().default(null), phone, species: z.string().trim().min(2).max(40).nullable().default(null), phone_last4: z.string().trim().min(1).max(40).nullable().default(null) }),
    // a new pet, after verify_caller found nothing and the caller said the pet is new
    // each detail null when the caller has not said it: the call memory fills what they said earlier, and the tool asks for what is still missing
    register_patient: z.object({
      pet_name: z.string().trim().min(1).max(60), owner_name: z.string().trim().min(2).max(120).nullable().default(null),
      // what kind of animal: dog, cat, rabbit, parrot
      species: z.string().trim().min(2).max(40).nullable().default(null),
      sex: z.enum(['female', 'male', 'unknown']).nullable().default(null),
      // as the owner says it: a date, or an age ("3 years", "six months")
      birthday_or_age: z.string().trim().min(1).max(60).nullable().default(null),
      phone,
    }),
  },
  emergency: {
    phrases: { en: EN, es: ES },
    subjects: SUBJECTS,
    script: (language, to) => script(language, to),
    safe: {
      en: w("not an? emergency|isn'?t an emergency|no emergency|not urgent|forget (?:about )?(?:it|this|that)|never ?mind|(?:he|she|it|they)(?:'?s| is| are|'?re) not (?:hurt|injured|in danger|bleeding|sick)|(?:he|she|it|they) (?:isn'?t|aren'?t|wasn'?t) (?:hurt|injured|in danger)|nothing (?:is )?wrong|(?:he|she|it|they)(?:'?s| is| are|'?re) (?:fine|ok|okay|alright|all right|safe|doing (?:fine|well|ok|okay|great)|totally fine|completely fine)(?: now)?|(?:he|she|it|they) seems? (?:fine|ok|okay|alright|all right)"),
      es: w('no es (?:una )?emergencia|no es urgente|olvide?lo|olvidese|no esta (?:herid[oa]|lastimad[oa]|en peligro)|no le pasa nada|(?:ya )?esta (?:bien|perfecto|tranquilo|tranquila)|(?:el|ella) esta bien'),
    },
  },
};
