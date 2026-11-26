// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, isClearYes, type Language, LANGUAGES, normalise, PACKS } from '@attendra/core';
import type { CallState } from '../call-state';

/**
 * The rest of the 11-16 set (batch 1b), in code so every engine follows it the same way: the reason behind a refusal
 * when the caller asks "why?", no result the tools did not return, the facts checked again when the caller disputes
 * them, honest answers about recording and about being an AI, and side talk never translated. Each detector reads the
 * caller's own words (normalised: lower case, accents folded); each line is said word for word.
 */

/**
 * Why a tool said no, in plain words, by its reason code: what the caller hears when they ask "why?". Codes with no
 * entry are explained from the refusal's own words.
 */
export const WHY: Record<string, Record<Language, string>> = {
  after_hours: {
    en: 'We\'re closed right now, and outside opening hours I take a request for the team instead of booking. They\'ll call you back after we open.',
    es: 'Ahora estamos cerrados, y fuera del horario tomo una solicitud para el equipo en vez de reservar. Le llamarán cuando abramos.',
  },
  too_far_ahead: { en: 'That\'s further ahead than the clinic books appointments.', es: 'Esa fecha está más lejos de lo que la clínica reserva.' },
  not_verified: { en: 'For privacy, I can only go into a pet\'s details once I\'ve found them under the owner\'s number and name.', es: 'Por privacidad, solo puedo ver los datos de una mascota cuando la encuentro con el número y el nombre del dueño.' },
  identity_required: { en: 'For privacy, I first need to find the pet under the owner\'s number.', es: 'Por privacidad, primero necesito encontrar a la mascota con el número del dueño.' },
  verify_first: { en: 'For privacy, I first need to find the pet under the owner\'s number.', es: 'Por privacidad, primero necesito encontrar a la mascota con el número del dueño.' },
  medical_question: { en: 'Only the vets can give medical advice, after seeing the pet. I can book a visit or have the team call you.', es: 'Solo los veterinarios pueden dar consejos médicos, después de ver a la mascota. Puedo reservar una visita o pedir que el equipo le llame.' },
  emergency_in_progress: { en: 'This sounded like an emergency, so the safest next step is emergency care, not a routine visit. I can put you through to the team or have them call you right away.', es: 'Esto sonó como una emergencia, así que lo más seguro es la atención de emergencia, no una visita de rutina. Puedo comunicarle con el equipo o pedir que le llamen de inmediato.' },
  pet_flagged: { en: 'First I need to know whether this is still an emergency right now, to send you the right way.', es: 'Primero necesito saber si sigue siendo una emergencia ahora mismo, para indicarle lo correcto.' },
  staff_books: { en: 'The team books that kind of visit themselves, so I\'ll take a request and they\'ll call you.', es: 'El equipo reserva ese tipo de visita directamente, así que tomo una solicitud y le llamarán.' },
  slot_taken: { en: 'Someone else just took that time.', es: 'Otra persona acaba de tomar ese horario.' },
  not_available: { en: 'That time isn\'t free.', es: 'Ese horario no está libre.' },
  no_provider_for_specialty: { en: 'None of our vets is listed for that.', es: 'Ninguno de nuestros veterinarios aparece para eso.' },
  no_provider_for_animal: { en: 'None of our vets is listed for that kind of animal, so the team needs to arrange it.', es: 'Ninguno de nuestros veterinarios aparece para ese tipo de animal, así que el equipo debe organizarlo.' },
  not_textable: { en: 'That number can\'t get texts.', es: 'Ese número no puede recibir mensajes.' },
  texting_off: { en: 'The clinic doesn\'t send texts during calls.', es: 'La clínica no envía mensajes durante las llamadas.' },
  too_many_attempts: { en: 'I couldn\'t find it after a few tries, so the team will help directly.', es: 'No lo encontré después de varios intentos, así que el equipo le ayudará directamente.' },
};

/** "Why?", "why not?", "can you say why?", "¿por qué?". */
const WHY_ASKED = /(?:^|\b)(?:but )?(?:why|how come)\b|\b(?:say|tell me|explain|specify) why\b|(?:^|\s)(?:y )?por ?que\b|\bpor que no\b/;
export const askedWhy = (said: string) => WHY_ASKED.test(normalise(said));

/**
 * A result the assistant may only say when a tool returned it: booked, moved, cancelled, or not found. "I've booked
 * Biscuit for Thursday" with no booking on the call is a claim; so is "I couldn't find a file under that number" when no
 * search ran (11-16, a tester clinic: verify_caller had only asked for the read-back).
 */
export const CLAIMS: Record<'booked' | 'moved' | 'cancelled' | 'not_found' | 'vet_day' | 'texted' | 'text_arrived' | 'sent_elsewhere', RegExp> = {
  // the caller sent to the clinic for something this call can do (T2, a tester's call 2026-11-24: "I can't finalize the
  // booking from here. Please contact the clinic directly" for a time read back and ready to book): only when they are
  // sent there INSTEAD of booking ("contact the clinic directly to book", "call the front desk to schedule", or the bare
  // "Please contact the clinic directly."), never a closing line for later ("call us directly if anything changes"; the
  // paid-run review, 2026-11-26)
  sent_elsewhere: /(?:\b(?:contact|call|phone|ring) (?:the clinic|us|the office|the front desk)(?: directly)? (?:to|and) (?:book|schedule|finali[sz]e|complete|confirm|make|set up|arrange)\b|(?<!\b(?:if|when|whenever|should|in case)\b[^.?!]{0,80})\b(?:contact|call|phone|ring) (?:the clinic|us|the office|the front desk) directly(?! (?:if|when|whenever|should|in case|any ?time|later|for (?:any|future|other))\b)|\b(?:can'?t|cannot|am unable to|i'?m unable to) (?:finali[sz]e|complete|confirm|make) (?:the|this|that|your) (?:booking|appointment|reservation)(?: from here)?\b|\b(?:llame|comuniquese|contacte|hable)(?: directamente)? (?:a|con) (?:la clinica|la recepcion|el consultorio|nosotros)(?: directamente)? para (?:reservar|agendar|programar|confirmar|finalizar|completar|hacer|sacar)\b|(?<!\b(?:si|cuando|en caso)\b[^.?!]{0,80})\b(?:comuniquese (?:directamente )?con la clinica|llame directamente a la clinica)(?! (?:si|cuando|en caso|mas adelante|para cualquier)\b)|\bno puedo (?:finalizar|completar|confirmar) (?:la|esta|su) (?:reserva|cita)\b)/,
  booked: /\b(?:i'?ve booked|i have booked|you'?re (?:all )?booked|you are (?:all )?booked|you'?re all set for|is (?:now )?booked|are (?:now )?booked|has been booked|booked (?:you|him|her|them|it) (?:in|for)|(?:le |lo |la )?he reservado|queda reservad[oa]|ya esta reservad[oa]|quedo reservad[oa])\b/,
  moved: /\b(?:i'?ve (?:moved|rescheduled)|i have (?:moved|rescheduled)|has been (?:moved|rescheduled)|is now (?:moved|on)|he cambiado|quedo cambiad[oa]|ya esta cambiad[oa])\b/,
  cancelled: /\b(?:i'?ve cancell?ed|i have cancell?ed|has been cancell?ed|is (?:now )?cancell?ed|he cancelado|queda cancelad[oa]|quedo cancelad[oa])\b/,
  not_found: /\b(?:(?:couldn'?t|could not|can'?t|cannot|didn'?t|did not) find|(?:don'?t|do not) see (?:a|any)|no (?:file|record|profile|pets?|account) (?:under|for|with|on)|not (?:on file|in our (?:system|records))|no (?:encontre|encuentro|aparece)|no tenemos (?:un |ningun )?(?:registro|expediente|perfil))\b/,
  // a vet's day said before any lookup: "Dr. Vance isn't in on Tuesday", "no está disponible el viernes" (batch 1c, live runs)
  // a text said to be sent or to have arrived (a test call, 2026-11-16: "I've sent you a confirmation text" for a text the
  // carrier never delivered): sent only when the caller asked for one and it went; arrived, never, since nobody on the
  // call can see it arrive
  texted: /\b(?:(?:i'?ve|i have) (?:just )?(?:sent|texted) (?:you |it to you |that to you )?(?:(?:a|the|your) )?(?:confirmation )?(?:text|message|sms)|(?:i'?ve|i have) (?:just )?texted|(?:confirmation )?text(?: message)? (?:has been|was|is) sent|(?:le|se lo) (?:he|acabo de) envia(?:do|r) (?:un |el )?(?:mensaje|texto))\b/,
  text_arrived: /\b(?:you should (?:have )?(?:received|got(?:ten)?|get) (?:it|the text|a text|the message)|(?:the text|the message|your text) (?:has )?(?:arrived|went through|was delivered|has been delivered)|ya le (?:llego|ha llegado)|le (?:llego|ha llegado) (?:el|un) mensaje)\b/,
  vet_day: /\b(?:(?:isn'?t|is not|won'?t be|will not be|not) (?:in|available|working|there|here|free|seeing patients)|(?:doesn'?t|does not) (?:work|come in|see patients)|is (?:off|away|out))\b[^.?!]{0,30}?\b(?:on |this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|lunes|martes|miercoles|jueves|viernes|sabado|domingo|hoy|manana)\b|\bno (?:esta|trabaja|atiende|viene|tiene (?:horas|horario|citas))\b[^.?!]{0,30}?\b(?:el |este |los )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|lunes|martes|miercoles|jueves|viernes|sabado|domingo|hoy|manana)\b/,
};

/** Which claims the assistant's words make. */
export const claimsIn = (said: string) => (Object.keys(CLAIMS) as (keyof typeof CLAIMS)[]).filter((k) => CLAIMS[k].test(normalise(said)));

/** The caller disagrees with a fact: "that's not right", "but you're open until 8", "I was told...", "¿está seguro?". */
const DISPUTE = /\b(?:that'?s (?:not (?:right|true|correct)|wrong|incorrect)|you'?re wrong|you are wrong|that can'?t be right|(?:but|no,?) (?:you'?re|you are) open|you'?re open until|you said|i was told|the website says|google says|it says online|are you sure|eso no es (?:cierto|verdad|correcto)|no es (?:cierto|verdad)|esta equivocad[oa]|pero (?:ustedes )?(?:estan abiertos|abren)|me dijeron|esta segur[oa])\b/;
export const disputes = (said: string) => DISPUTE.test(normalise(said));
export const DISPUTE_NOTE = 'The caller disagrees with what you said. Check again with the tool that gave it (clinic_now, get_clinic_info or find_slots) before you answer. If the facts stand, say them kindly and firmly, starting with "I checked again:". Never agree with something no tool said, and never take back advice about an emergency.';

/** "Are you recording this?", "¿me está grabando?". */
const RECORDING_ASKED = /\b(?:(?:are|is) (?:you|this|it|the call|this call) (?:being )?record(?:ed|ing)|am i being recorded|(?:do|will) you record|record(?:ing)? (?:this|the|my) call|is this call recorded|(?:me |nos )?(?:esta|estan) grabando|se (?:graba|esta grabando)|grab(?:a|an) (?:la|esta|las) llamadas?)\b/;
export const askedAboutRecording = (said: string) => RECORDING_ASKED.test(normalise(said));
/** The truthful answer, from the clinic's own setting. */
export function recordingLine(clinic: Pick<ClinicConfig, 'recording'>, language: Language): string {
  const on = !!clinic.recording?.enabled;
  if (language === 'es') return on ? 'Sí, esta llamada puede grabarse, como dijo el aviso al inicio.' : 'Esta llamada no se graba en audio. Se guarda un resumen escrito para la clínica.';
  return on ? 'Yes, this call may be recorded, as the message at the start said.' : 'This call isn\'t recorded as audio. A written summary is kept for the clinic.';
}

/** "Are you a real person?", "am I talking to a robot?": the honest answer, always (callers must know it is software). */
const HUMAN_ASKED = /\b(?:are you (?:a )?(?:real|human|person|robot|bot|machine|computer|an? ai|ai)|is this (?:a )?(?:real person|human|robot|bot|recording)|am i (?:talking|speaking) to (?:a )?(?:real person|human|person|robot|bot|machine|computer)|eres (?:un |una )?(?:persona|humano|humana|robot|maquina)|es usted (?:una )?(?:persona|humano|robot)|estoy hablando con (?:una )?(?:persona|maquina|robot))\b/;
export const askedIfHuman = (said: string) => HUMAN_ASKED.test(normalise(said));
/** "Can you hear me?", "are you there?", "¿me escucha?": answered at once, in a few words (master prompt, step 4). */
// only the question on its own (with "hello", "hola" and the like around it), never "are you there on Saturdays?" or
// "¿está ahí el doctor?" (review 4): each clause is checked whole
const HEAR_ALONE = /^(?:(?:hello|hi|hey|sorry|um|uh|so|hola|oiga|perdon|alo|bueno)\s+)*(?:(?:can|could|do) you hear me(?: now| ok| okay| alright)?|are you (?:still )?there|me (?:escucha|escuchas|oye|oyes)(?: bien)?|(?:esta|estas|sigue) (?:ahi|ahí)|hello|hola|alo)(?:\s+(?:hello|hola))*$/;
const clauses = (said: string) => normalise(said).split(/[?.!,;¿¡]+/).map((c) => c.trim()).filter(Boolean);
export const asksIfHeard = (said: string) => { const parts = clauses(said); return parts.some((c) => HEAR_ALONE.test(c)) && parts.some((c) => HEAR_ALONE.test(c) && !/^(?:hello|hola|alo)(?:\s+(?:hello|hola))*$/.test(c)); };
/** Whether the turn says more than the question about the line ("Can you hear me? I want to book Bella for Friday"). */
export const saysMoreThanHeard = (said: string) => clauses(said).some((c) => !HEAR_ALONE.test(c));
export const heardLine = (language: Language) => (language === 'es' ? 'Sí, le escucho.' : 'Yes, I can hear you.');
export const humanLine = (language: Language) => (language === 'es' ? 'Soy el asistente de inteligencia artificial de la clínica. Si lo prefiere, le paso un mensaje al equipo para que le llamen.' : 'I\'m the clinic\'s AI assistant. If you\'d rather talk to someone, I can have the team call you back.');

/**
 * Speech not in the clinic's languages (another script: side talk with someone in the room, a TV): never translated
 * or answered. Over half the letters outside the Latin script.
 */
export function notInTheClinicsLanguages(said: string): boolean {
  const letters = [...said].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 4) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length < 0.5;
}
/** The one line for side talk, in the clinic's languages. */
export function sideTalkLine(clinic: Pick<ClinicConfig, 'languages'>): string {
  const names = clinic.languages.map((l) => (l === 'es' ? 'Spanish' : 'English'));
  return clinic.languages.includes('es') && clinic.languages.length > 1
    ? 'Sorry, I can help in English or Spanish.'
    : `Sorry, I can help in ${names[0] ?? 'English'}.`;
}

/** "Which vet is good for allergies?": clinic information (who is listed for what), never medical advice. */
const WHICH_VET = /\b(?:which|what|who(?:'?s| is)?) (?:of your )?(?:vet|vets|veterinarian|veterinarians|doctor|doctors|dr)\b|\b(?:best|good) (?:vet|doctor) for\b|\b(?:que|cual|quien) (?:veterinari[oa]|doctor[a]?|medic[oa])\b/;
export const asksWhichVet = (question: string) => WHICH_VET.test(normalise(question));
/**
 * A question about who the vets or doctors are: their names, how many, what they specialise in, their qualifications
 * (T6, a tester's call 2026-11-24). Answered once, from the clinic's own list, never "I don't have that".
 */
const VETS_WORD = /\b(?:vets?|veterinarians?|doctors?|drs?|doctoras?|doctores|veterinari[oa]s?|medic[oa]s?)\b/;
// who the vets are: their names, how many, the others, their qualifications or specialties; never where they are, when
// they open or what they charge (reviewer, T6: "What is the vet's address?" got the list of vets)
const ABOUT_VETS = /\b(?:who|which|names?|how many|other|others|additional|list|qualif\w*|credentials?|specialt\w*|speciali[sz]\w*|trained|certified|degrees?|background|quien(?:es)?|cual(?:es)?|nombres?|cuantos|cuantas|otros?|otras?|titulos?|cualificaciones|formacion|especialidad(?:es)?)\b/;
const NOT_ABOUT_WHO = /\b(?:address|where|located|location|hours?|open|opens|close|closes|charge|charges|cost|costs|price|prices|fee|fees|pay|insurance|parking|direccion|donde|hora|horas|horario|abre|abren|cierra|cierran|precio|precios|cuesta|cuestan|cobra|cobran|pagar|seguro)\b/;
/** Their training or schooling: "where did they train?", "¿dónde estudiaron?" is still about who they are. */
// ("training classes" is a service, never their qualifications: reviewer, T6)
const TRAINING = /\b(?:train|trained|school|schooling|college|university|studied|study|qualif\w*|credentials?|degrees?|certified|estudiaron|estudio|se formaron|formacion|titulos?|cualificaciones)\b/;
export const asksAboutTraining = (question: string) => VETS_WORD.test(normalise(question)) && TRAINING.test(normalise(question));
export const asksAboutVets = (question: string) => {
  const t = normalise(question);
  if (NOT_ABOUT_WHO.test(t) && !TRAINING.test(t)) return false;
  return (VETS_WORD.test(t) && (ABOUT_VETS.test(t) || TRAINING.test(t))) || /\b(?:qualifications?|credentials?|cualificaciones)\b/.test(t);
};
/**
 * A question about how the clinic handles emergencies ("what does 'on call' mean?", "¿qué significa que atienden
 * emergencias a cualquier hora?"): clinic information, never a medical question (note 49 B3: Spanish "¿qué significa?"
 * read as one). The animal's own condition still is.
 */
const EMERGENCY_WORD = /\bemergenc/;
const HANDLING_WORD = /\b(?:handle|handles|handling|on call|on-call|any time|anytime|after hours|setting|policy|de guardia|atiende|atienden|maneja|manejan|cualquier hora|horario|fuera de horario)\b/;
export const asksEmergencyHandling = (question: string) => {
  const t = normalise(question);
  // "do you take/receive/see emergencies?" asks the same (note 52 B6)
  return (EMERGENCY_WORD.test(t) && HANDLING_WORD.test(t)) || LANGUAGES.some((l) => PACKS[l].asksEmergencyService.test(t));
};
/** Where a "what does it mean?" starts in a sentence: "what does", "what do", "¿qué significa", "qué quiere decir". */
const MEANING_START = /(?:¿ ?)?\bqu[eé] (?:significa|quiere decir)\b|\bwhat (?:does|do)\b/i;
const MEANING_WORD = /\b(?:mean|means|significa|quiere decir)\b/i;
/**
 * The words without "what does it mean?" ("¿qué significa?", "¿qué quiere decir?"), for a question about the clinic's
 * emergency handling: in each sentence that asks what something means, from where the asking starts to the sentence's
 * end. Plain string steps, no backtracking (CodeQL: a regular expression on the caller's words must stay linear).
 */
export function withoutMeaningAsk(text: string): string {
  return text.split(/(?<=[.!?])/).map((sentence) => {
    const m = MEANING_START.exec(sentence);
    return m && MEANING_WORD.test(sentence.slice(m.index)) ? `${sentence.slice(0, m.index)} ` : sentence;
  }).join('');
}

/**
 * The caller says their texts are not arriving: "I never got the text", "the texts aren't coming through", "no me llegan
 * los mensajes". Answered as that, never with the clinic's details (a test call, 2026-11-16, heard the address).
 */
const NO_TEXTS = /\b(?:(?:not|never|haven'?t|didn'?t|did not|have not|don'?t|do not|isn'?t|aren'?t|no)\s+(?:been\s+|even\s+|yet\s+)?(?:get|getting|got|gotten|receiv(?:e|ed|ing)|see|seeing|seen|com(?:e|ing))\s+(?:any(?:thing)?\s+|the\s+|a\s+|your\s+|my\s+|that\s+|those\s+)?(?:texts?|messages?|sms|confirmations?|text messages?|confirmation texts?)|(?:texts?|messages?|confirmations?)\s+(?:(?:is|are|has|have)\s+)?(?:not|never|n'?t)\s+(?:coming|arriving|arrived|come|came|getting through)|no\s+(?:texts?|messages?)\s+(?:came|arrived|come|yet))\b|\bno\s+(?:me\s+)?(?:(?:ha|han)\s+)?(?:llega(?:n|do|ron)?|llego|recib(?:o|i|ido)|veo|he recibido|me ha llegado)\s+(?:ningun\s+|ningunos?\s+|el\s+|los\s+|un\s+|mis\s+|sus\s+)?(?:mensajes?|textos?|sms|confirmacion(?:es)?)\b|\bno\s+(?:he\s+)?recibido\s+(?:ningun\s+)?(?:mensajes?|textos?|sms)\b/;
export const saysTextsNotArriving = (said: string) => NO_TEXTS.test(normalise(said));

/**
 * The answer to it, in the caller's language: texts go to the number on file (its last four digits once the pet is
 * found by its owner's number), which may not be the phone calling; nobody on the call can see whether one arrived;
 * and the next step, the team checking or updating the number and calling back.
 */
export function textsNotArrivingLine(language: Language, last4: string | null, pets: boolean): string {
  if (language === 'es') {
    return `${last4 ? `Los mensajes van al número de la ficha, que termina en ${last4}` : `Los mensajes van al número de ${pets ? 'la ficha de su mascota' : 'su ficha'}`}, que puede no ser el teléfono desde el que llama, y yo no puedo ver si un mensaje llegó. Si ese número cambió, puedo pedir al equipo que lo actualice y le llame. ¿Quiere que lo haga?`;
  }
  return `${last4 ? `Texts go to the number on file, ending ${last4}` : `Texts go to the number on ${pets ? 'your pet\'s file' : 'your file'}`}, which may not be the phone you're calling from, and I can't see whether a text has arrived. If that number has changed, I can ask the team to update it and call you back. Would you like that?`;
}

/** What the voice is told when the caller says texts are not arriving: the line, and the request for the team on a yes. */
export function textsNotArrivingNote(state: Pick<CallState, 'verifiedPatient' | 'memory' | 'language'>, clinic: Pick<ClinicConfig, 'industry'>): string {
  // the last four digits of the number on file only once the pet is found by its owner's number (or caller ID)
  const phone = state.memory.verified ? state.verifiedPatient?.phone?.replace(/\D/g, '') ?? '' : '';
  const line = textsNotArrivingLine(state.language, phone.length >= 4 ? phone.slice(-4) : null, clinic.industry === 'vet');
  return `The caller says texts are not arriving. Do not answer with the clinic's details. Say, word for word: "${line}" On a yes, call create_callback with the reason "Texts not arriving: check or update the number on file" and the best number to call.`;
}

/**
 * The caller asks for a staff member's private details ("Dr. Ruiz's home address and cell number", "el celular de la
 * doctora Ruiz") or for another client's ("I'm Linh's neighbour…", "otro cliente"). Never given; and never a request
 * for the team unless the caller asks for one (the faithful live run filed a callback unasked).
 */
const PRIVATE_DETAILS = [
  /\b(?:dr|doctor|vet|nurse|receptionist|technician)\.?(?: \w+)?'s (?:home|personal|private|cell|mobile|own)\b/,
  /\b(?:where|what street) does (?:dr\.? \w+|doctor \w+|the vet|\w+) live\b/,
  /\b(?:direccion|domicilio|celular|movil|telefono personal|numero personal|telefono de casa)\b.{0,40}\b(?:del|de la|de) (?:dr|dra|doctor|doctora|veterinari[oa])\b/,
  /\bdonde vive (?:el|la) (?:dr|dra|doctor|doctora|veterinari[oa])\b/,
  /\b(?:i'?m|i am) (?:\w+'s )?(?:neighbou?r|friend|coworker|roommate|ex)\b/,
  /\b(?:another|other) (?:client|owner|customer)'?s?\b/,
  /\bsoy (?:la |el |su )?(?:vecin[oa]|amig[oa]|companer[oa]|ex) de\b/,
  /\botr[oa] (?:cliente|dueno|duena)\b/,
];
export const asksPrivateDetails = (said: string) => { const t = normalise(said); return PRIVATE_DETAILS.some((p) => p.test(t)); };
/** The caller asks, in their own words, for a callback or a message to the team. */
const ASKS_CALLBACK = /\b(?:call (?:me|us) back|callback|call-back|(?:have|can|could) (?:someone|somebody|the team|a vet|the vet|her|him|they|them) call|someone call me|leave (?:a|her|him) (?:message|note)|take a message|pass (?:it|that|a message) on|me (?:pueden|puede|podrian|podria) llamar|que me llamen?|me llame alguien|llamarme|devolver(?:me)? la llamada|dej(?:ar|e)(?:le)? un (?:mensaje|recado)|tom(?:ar|e) un (?:mensaje|recado))\b/;
const OFFERS_CALLBACK = /\b(?:call (?:you|them) back|callback|message|note for the team|le llame|le llamen|mensaje|recado|devolver la llamada)\b/;
/**
 * Whether a request for the team waits: the caller asked for someone's private details and has not, since, asked for a
 * callback or a message, nor said yes to the assistant's offer of one.
 */
export function requestHeldForPrivacy(state: CallState): boolean {
  const turns = state.turns;
  let at = -1;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.speaker === 'caller' && asksPrivateDetails(turns[i]!.text)) { at = i; break; }
  if (at < 0) return false;
  for (let i = at; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.speaker !== 'caller') continue;
    if (ASKS_CALLBACK.test(normalise(t.text))) return false;
    const offer = turns.slice(0, i).reverse().find((x) => x.speaker === 'agent');
    if (i > at && offer && OFFERS_CALLBACK.test(normalise(offer.text)) && isClearYes(t.text, LANGUAGES)) return false;
  }
  return true;
}

