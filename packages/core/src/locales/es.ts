// SPDX-License-Identifier: AGPL-3.0-only
import { type LanguagePack, words } from './types';

// Spanish as spoken in the United States: usted, clear and short. Accents are
// removed before matching (normalise), so "sí" and "si", "está" and "esta" meet.
const when = (start: Date, timeZone: string) => {
  const day = new Intl.DateTimeFormat('es-US', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(start);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h12' }).format(start).replace(/\D/g, ''));
  const time = new Intl.DateTimeFormat('es-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(start);
  return `${day} a ${hour === 1 ? 'la' : 'las'} ${time}`;
};

const DIGITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];

/** The same personal texts as in English: the names when the call gave them, never empty ones. The kind of visit is not named in Spanish (its article depends on the word). */
const hola = (v: Record<string, string>, rest: string) => (v.name ? `Hola ${v.name}, ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1));
const citaDe = (v: Record<string, string>) => `${v.pet ? `la cita de ${v.pet}` : 'su cita'}${v.provider ? ` con ${v.provider}` : ''}`;
const pedidoDe = (v: Record<string, string>) => (v.pet ? `el pedido de ${v.pet}` : 'su pedido');

export const es: LanguagePack = {
  code: 'es',
  name: 'Spanish',
  nativeName: 'Español',
  locale: 'es-US',
  prompt: [
    'If the caller speaks Spanish, answer in Spanish for the rest of the call, using usted.',
    'In Spanish, keep sentences short and say dates and times the way they are given to you.',
  ],
  greeting: ({ assistantName, clinicName }) => `Gracias por llamar a ${clinicName}. ${assistantName ? `Soy ${assistantName}, la` : 'Soy la'} asistente virtual con inteligencia artificial de la clínica. ¿En qué le puedo ayudar?`,
  disclosure: /\b(asistente (virtual|de ia|con inteligencia artificial|automatizad[oa])|inteligencia artificial)\b/i,
  speakWhen: when,
  speakPhone: (e164) => e164.replace(/\D/g, '').split('').map((d) => DIGITS[Number(d)]).join(' '),
  readbackBooking: ({ when: w, provider, providerKind, visit, replacing }) => `${w} ${providerKind === 'room' ? 'en' : 'con'} ${provider}, para ${visit}${replacing ? `, en lugar de la cita del ${replacing}` : ''}`,
  readbackCancel: ({ when: w }) => `cancelar la cita del ${w}`,
  sms: {
    booking_confirmed: (v) => `${v.clinic}: ${hola(v, `${citaDe(v)} es el ${v.when}.`)} Para cambiarla o cancelarla, llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    request_ready: (v) => `${v.clinic}: ${hola(v, `${pedidoDe(v)} está listo para recoger.`)} ¿Preguntas? Llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    refill_sent: (v) => `${v.clinic}: ${hola(v, `${pedidoDe(v)} se envió a ${v.pharmacy}.`)} ¿Preguntas? Llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    refill_not_approved: (v) => `${v.clinic}: ${hola(v, `sobre ${v.pet ? `el pedido reciente de ${v.pet}` : 'su pedido reciente'}, por favor llámenos al ${v.clinicPhone}.`)} Responda STOP para no recibir más mensajes.`,
    change_confirmed: (v) => `${v.clinic}: ${hola(v, `${citaDe(v)} se cambió al ${v.when}.`)} Para cambiarla o cancelarla, llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    cancel_confirmed: (v) => `${v.clinic}: ${hola(v, `${citaDe(v)} del ${v.when} quedó cancelada.`)} Para reservar otra, llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    directions: (v) => `${v.clinic}: ${v.address}. Mapa: ${v.mapUrl}. Responda STOP para no recibir más mensajes.`,
    hours: (v) => `Horario de ${v.clinic}: ${v.hours}. Responda STOP para no recibir más mensajes.`,
    emergency_hospital: (v) => `${v.clinic}: urgencias veterinarias: ${v.hospital}, ${v.hospitalAddress}, tel. ${v.hospitalPhone}. Si una persona está herida o en peligro, llame al ${v.emergencyNumber}. Responda STOP para no recibir más mensajes.`,
    provider: (v) => `${v.clinic}: ${v.provider}${v.details ? `, ${v.details}` : ''}. ¿Preguntas? Llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    answer: (v) => `${v.clinic}: ${v.answer} ¿Preguntas? Llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    link: (v) => `${v.clinic}: ${v.label}: ${v.url} Responda STOP para no recibir más mensajes.`,
    reminder: (v) => `${v.clinic}: ${hola(v, `le recordamos ${citaDe(v)} el ${v.when}.`)} Responda C para confirmarla, o llame al ${v.clinicPhone} para cambiarla. Responda STOP para no recibir más mensajes.`,
  },
  textOffer: ({ target }) => (target === 'file' ? '¿Quiere que se lo envíe por mensaje de texto al número que tenemos en su ficha?' : '¿Quiere que se lo envíe por mensaje de texto al número desde el que llama?'),
  textSent: 'Listo, se lo acabo de enviar.',
  textRefused: ({ reason }) => (reason === 'opted_out' ? 'Ese número pidió no recibir mensajes nuestros, así que se lo leo.' : 'No puedo enviar mensajes de texto, así que se lo digo despacio.'),
  reminderOffer: '¿Quiere un recordatorio por mensaje de texto el día antes de la cita? Pueden aplicarse tarifas de mensajes y datos, y puede responder STOP cuando quiera.',
  refillTextOffer: '¿Quiere un mensaje de texto a ese número cuando el equipo lo haya decidido? Pueden aplicarse tarifas de mensajes y datos, y puede responder STOP cuando quiera.',
  phoneQuestion: ({ callerId }) => (callerId ? '¿El número desde el que llama es el mejor para comunicarnos con usted?' : '¿Cuál es el mejor número para comunicarnos con usted?'),
  // "o" becomes "u" before a name that starts with an o sound: "Max u Oreo"
  whichPet: ({ names, more }) => {
    const or = (next: string) => (/^h?o/i.test(next) ? 'u' : 'o');
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} ${or(names.at(-1)!)} ${names.at(-1)}` : names[0]!;
    return `¿Es para ${list}, ${more ? 'o para otra mascota' : 'o para una mascota nueva'}?`;
  },
  lastVisitSeen: ({ pet, when: w, provider, visit }) => `La última visita que veo de ${pet} fue el ${w}${provider ? ` con ${provider}` : ''}${visit ? `, para ${visit.toLowerCase()}` : ''}.`,
  recordsOffer: 'No puedo dar detalles médicos por teléfono, pero puedo pedirle al equipo que le envíe el historial por escrito. ¿Le parece bien?',
  phoneAsGiven: ({ digits }) => `Tengo ${digits}. Lo anoto tal como me lo dio.`,
  petNewQuestion: ({ pet }) => `¿Es la primera vez que ${pet} viene con nosotros?`,
  confirmTextNote: ({ target }) => (target === 'calling' ? 'le enviaré una confirmación por mensaje de texto al número desde el que llama, si le parece bien' : 'le enviaré una confirmación por mensaje de texto al número de su ficha, si le parece bien'),
  smsConfirmed: ({ clinic, when }) => `${clinic}: gracias, su cita del ${when} está confirmada.`,
  shortDays: ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'],
  smsNoReplies: ({ clinicPhone }) => `Este número no lee respuestas. Llame al ${clinicPhone}.`,
  abuseWarning: 'Quiero ayudarle, pero si este lenguaje continúa tendré que terminar la llamada. También puedo pedir que alguien de la clínica le llame.',
  abuseGoodbye: 'Voy a terminar la llamada ahora. Puede volver a llamar cuando quiera. Adiós.',
  takeOver: 'Le comunico con una persona de nuestro equipo ahora mismo.',
  tooSlow: 'Disculpe, esto está tardando más de lo debido. Si quiere, puedo pedir que alguien de la clínica le llame para eso.',
  couldNotFinish: 'Disculpe, no pude completar eso ahora. Puedo pedir que alguien de la clínica le llame.',
  emergencyScript: (n) =>
    'The caller may be describing a medical emergency. Stop the current task now. Say, in Spanish, calmly and clearly: ' +
    `"Si es una emergencia médica, por favor cuelgue y llame al ${n} ahora mismo." ` +
    'Do not give medical advice, do not ask about symptoms, and do not continue booking. ' +
    'If the caller says they are safe and it is not an emergency, you may continue.',
  selfHarmScript: (n, crisis) =>
    'The caller may be at risk of harming themselves. Stop the current task. Say, in Spanish, calmly and kindly: ' +
    `"Me alegra mucho que haya llamado. Si está en peligro ahora mismo, llame al ${n}.` +
    (crisis ? ` También puede llamar o enviar un mensaje de texto al ${crisis}, la Línea de Prevención del Suicidio y Crisis, a cualquier hora."` : '"') +
    ' Stay warm and brief. Do not give medical advice.',
  // written without accents: the text is normalised before it is matched
  emergencyPhrases: [
    ['cardiac', words('(me )?duele (mucho )?el pecho|dolor (fuerte )?(en el|de|del) pecho|(presion|opresion) en el pecho|ataque al corazon|infarto')],
    ['breathing', words('no (puedo|puede|podemos) respirar|me (estoy )?ahog(o|ando)|se (esta )?ahog(a|ando)|falta de aire|(dificultad|me cuesta|le cuesta) (para )?respirar|no respira')],
    ['stroke', words('derrame( cerebral)?|ictus|embolia|(la )?cara (se le )?(cayo|esta caida|torcida)|(tiene )?la cara caida|habla (arrastrada|rara)|no (puede|puedo) hablar bien|no (puede|puedo) mover (el|la|mi|su) (brazo|pierna|cara)')],
    ['bleeding', words('no (para|deja) de sangrar|sangr(a|ando) mucho|mucha sangre|sangrado (abundante|fuerte)|(vomit|tos)(a|iendo|e) sangre')],
    ['unresponsive', words('inconsciente|se desmayo|(esta )?desmayad[oa]|no (responde|reacciona|despierta)|convulsi(on|ones|onando)')],
    ['self_harm', words('suicid(io|arme|arse|a)|matarme|quitarme la vida|no quiero (vivir|seguir viviendo)|hacerme dano|mejor (estaria )?muert[oa]')],
    // "se tomó" only with what was taken: "se tomó el día libre" is not an emergency
    ['overdose', words('sobredosis|veneno|envenenad[oa]|(me tome|tome|se tomo) (demasiad[oa]s?|tod[oa]s?|todas las pastillas|las pastillas|el frasco|un frasco|una botella|veneno|lejia|cloro|algo)')],
    ['allergic', words('se me (esta )?cerrando la garganta|(se me )?cierra la garganta|anafilaxia|lengua hinchada')],
    ['general', words('emergencia|(llame|llamen|necesito) una ambulancia|ambulancia')],
  ],
  notAnEmergency: words('no es (una )?emergencia|no es urgente'),
  // "si" is also "if" ("si puede el martes"), so it counts only as its own word at the start, before a pause or the end
  yes: new RegExp(`^si(?=\\s*[,.!]|$)|${words('claro|correcto|esta bien|de acuerdo|perfecto|exacto|adelante|confirmo|reservela|hagalo|asi es|me parece bien|suena bien|me sirve').source}`, 'u'),
  yesAlone: /^(vale|por favor|si por favor)$/,
  hedge: new RegExp(`${words('no|espere|espera|mejor|tal vez|quizas?|a lo mejor|en realidad|otro|otra|cambiar|momento|pensandolo|pero|prefiero|aunque|repita').source}|[?¿]`, 'u'),
  markers: /\b(el|la|los|las|de|que|por|para|con|una?|quiero|necesito|cita|gracias|hola|senor|senora|manana|hoy|si|esta|usted|puedo)\b/g,
  saysNew: words('(?:es|son|soy|somos) (?:completamente )?nuev[oa]s?|(?:paciente|cliente|mascota)s? nuev[oa]s?|nuev[oa]s? (?:paciente|cliente|mascota|aqui|en (?:la|su) clinica)|no (?:esta|estan|estoy) (?:registrad[oa]s?|en (?:su|el) sistema)|nunca (?:ha|han|he) (?:venido|ido|estado)|primera (?:vez|visita|consulta) (?:aqui|con ustedes|en (?:la|su) clinica)|(?:su|una) primera (?:consulta|visita|revision)|(?:acabo|acabamos) de (?:adoptar|tener)|(?:quiero|quisiera|necesito) registrar|registrar a (?:mi|mis|nuestr[oa]s?)'),
  describesPet: words('(?:tiene|de) (?:\\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|dieciocho) (?:anos?|mes(?:es)?|semanas?)|(?:anos?|meses) de edad|hembra|macho|esterilizad[oa]|castrad[oa]'),
  pointsAtPet: /^(?=.*\b(el|la|los|las|mi|mis|nuestro|nuestra|su|este|esta|ese|esa|otro|otra|ambos|ambas)\b)(?:(?:el|la|los|las|mi|mis|nuestro|nuestra|su|este|esta|ese|esa|otro|otra|ambos|ambas|no|uno|una|de|dos|mayor|menor|pequeno|pequena|grande|perro|perra|gato|gata|mascota|cachorro|cachorra|conejo|coneja)(?:[\s,.!?]+|$))+$/,
  saysOnFile: words('no es nuev[oa]|ya (?:es|son) (?:paciente|cliente)s?|ya (?:esta|estan) (?:registrad[oa]s?|en (?:su|el) sistema)|ya (?:ha|han|hemos|he) (?:venido|ido|estado)|(?:puede|podria) (?:que )?(?:ya )?(?:este|estar) (?:registrad[oa]s?|en (?:su|el) sistema)'),
};
