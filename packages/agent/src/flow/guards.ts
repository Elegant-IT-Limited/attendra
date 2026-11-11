// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, type Language, normalise } from '@attendra/core';

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
export const CLAIMS: Record<'booked' | 'moved' | 'cancelled' | 'not_found' | 'vet_day', RegExp> = {
  booked: /\b(?:i'?ve booked|i have booked|you'?re (?:all )?booked|you are (?:all )?booked|you'?re all set for|is (?:now )?booked|are (?:now )?booked|has been booked|booked (?:you|him|her|them|it) (?:in|for)|(?:le |lo |la )?he reservado|queda reservad[oa]|ya esta reservad[oa]|quedo reservad[oa])\b/,
  moved: /\b(?:i'?ve (?:moved|rescheduled)|i have (?:moved|rescheduled)|has been (?:moved|rescheduled)|is now (?:moved|on)|he cambiado|quedo cambiad[oa]|ya esta cambiad[oa])\b/,
  cancelled: /\b(?:i'?ve cancell?ed|i have cancell?ed|has been cancell?ed|is (?:now )?cancell?ed|he cancelado|queda cancelad[oa]|quedo cancelad[oa])\b/,
  not_found: /\b(?:(?:couldn'?t|could not|can'?t|cannot|didn'?t|did not) find|(?:don'?t|do not) see (?:a|any)|no (?:file|record|profile|pets?|account) (?:under|for|with|on)|not (?:on file|in our (?:system|records))|no (?:encontre|encuentro|aparece)|no tenemos (?:un |ningun )?(?:registro|expediente|perfil))\b/,
  // a vet's day said before any lookup: "Dr. Vance isn't in on Tuesday", "no está disponible el viernes" (batch 1c, live runs)
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
 * A question about how the clinic handles emergencies ("what does 'on call' mean?", "¿qué significa que atienden
 * emergencias a cualquier hora?"): clinic information, never a medical question (note 49 B3: Spanish "¿qué significa?"
 * read as one). The animal's own condition still is.
 */
const EMERGENCY_HANDLING = /\bemergenc\w*\b.*\b(?:handle|handles|handling|on call|on-call|any time|anytime|after hours|setting|policy|de guardia|atiende\w*|maneja\w*|cualquier hora|horario|fuera de horario)\b|\b(?:handle|handles|handling|on call|on-call|de guardia|atiende\w*|maneja\w*)\b.*\bemergenc\w*\b/;
export const asksEmergencyHandling = (question: string) => EMERGENCY_HANDLING.test(normalise(question));
/** The words without "what does it mean?" ("¿qué significa?", "¿qué quiere decir?"), for a question about the clinic's emergency handling. */
export const withoutMeaningAsk = (text: string) => text.replace(/[¿]?\s*\b(?:qu[eé] (?:significa|quiere decir)(?: eso| esto)?|what (?:does|do) (?:that|this|it|they) mean|what (?:does|do) [^?.!]{0,80} mean)\b\s*[?]?/gi, ' ');
