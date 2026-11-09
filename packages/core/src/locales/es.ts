// SPDX-License-Identifier: AGPL-3.0-only
import { clock12, dateParts, wallClock } from './dates';
import { type Clock, type LanguagePack, type OfferDay, words } from './types';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** "miércoles 4 de noviembre", without the article: "el" goes before it, or "del" and "al". */
const fullDay = (date: string) => { const d = dateParts(date); return `${DIAS[d.weekday]} ${d.day} de ${MESES[d.month - 1]}`; };
/** The part of the day as said after a time: "de la mañana" before noon, "del mediodía" at 12:00, "de la tarde" to 19:59, "de la noche" after. */
const partOfDay = (hour: number, minute: number) => (hour === 12 && minute === 0 ? 'del mediodía' : hour > 0 && hour < 12 ? 'de la mañana' : hour >= 12 && hour < 20 ? 'de la tarde' : 'de la noche');
/** "5:20", with "a la" before 1 o'clock and "a las" before any other hour. */
const hora = (hour: number, minute: number) => { const c = clock12(hour, minute); return { at: c.hour === 1 ? 'a la' : 'a las', time: `${c.hour}:${c.minutes}` }; };
/** "el miércoles 4 de noviembre a las 5:20 de la tarde": the weekday, the date and the time, every time, never the year. */
const fullWhen = (start: Date, timeZone: string) => {
  const w = wallClock(start, timeZone);
  const h = hora(w.hour, w.minute);
  return `el ${fullDay(w.date)} ${h.at} ${h.time} ${partOfDay(w.hour, w.minute)}`;
};
/** "o" is "u" before a word said with an o sound: "8:00" is "ocho", "11:00" is "once". */
const oBefore = (hour: number) => (hour % 12 === 8 || hour % 12 === 11 ? 'u' : 'o');
/** One day's times: "a las 8:00, 8:40 o 9:20 de la mañana"; the part of the day once per run, and with each time when the vets differ. */
const horas = (day: OfferDay) => {
  const withVets = day.times.some((t) => t.provider);
  const said = day.times.map((t, i) => {
    const next = day.times[i + 1];
    const h = hora(t.hour, t.minute);
    const part = partOfDay(t.hour, t.minute);
    const showPart = withVets || !next || partOfDay(next.hour, next.minute) !== part;
    return `${withVets || i === 0 ? `${h.at} ` : ''}${h.time}${showPart ? ` ${part}` : ''}${t.provider ? ` con ${t.provider}` : ''}`;
  });
  // "u" only when the time itself follows ("8:00 u 8:40"), not before "a las"
  return said.length > 1 ? `${said.slice(0, -1).join(', ')} ${withVets ? 'o' : oBefore(day.times.at(-1)!.hour)} ${said.at(-1)}` : said[0] ?? '';
};

/** "a, b y c". */
const yList = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items.at(-1)}` : items[0] ?? '');
/** "9", "9:30", como se dice una hora al hablar de horarios ("de 9 a 1"). */
const horaCorta = (t: Clock) => { const c = clock12(t.hour, t.minute); return t.minute ? `${c.hour}:${c.minutes}` : String(c.hour); };
/** "a las 9", "a la 1". */
const aLas = (t: Clock) => `${clock12(t.hour, t.minute).hour === 1 ? 'a la' : 'a las'} ${horaCorta(t)}`;
/** "los viernes", "los sábados". */
const losDias = (weekday: number) => `los ${DIAS[weekday]}${weekday === 0 || weekday === 6 ? 's' : ''}`;
/** Días de lunes a domingo, tres o más seguidos como un rango: "de miércoles a viernes y los domingos". */
const diasPalabras = (days: number[]) => {
  const orden = [1, 2, 3, 4, 5, 6, 0];
  const runs: number[][] = [];
  for (const d of orden.filter((x) => days.includes(x))) {
    const last = runs.at(-1);
    const prev = last?.at(-1);
    if (last && prev !== undefined && orden.indexOf(d) === orden.indexOf(prev) + 1) last.push(d); else runs.push([d]);
  }
  return yList(runs.flatMap((r) => (r.length >= 3 ? [`de ${DIAS[r[0]!]} a ${DIAS[r.at(-1)!]}`] : r.map((d) => losDias(d)))));
};
const avisoTexto = (hours: number) => (hours % 24 === 0 ? `${hours / 24} ${hours === 24 ? 'día' : 'días'}` : `${hours} horas`);
const mayuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NUMEROS = ['cero', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce'];

// Spanish as spoken in the United States: usted, clear and short. Accents are
// removed before matching (normalise), so "sí" and "si", "está" and "esta" meet.

/** A full time after "el", "del" or "al": the article it starts with is dropped, so "del el miércoles" is never said. */
const sinEl = (w: string | undefined) => (w ?? '').replace(/^el\s+/i, '');

/** A pet's kind as owners say it in Spanish, with its article: "su perro". Anything else is left unsaid. */
const SPECIES_ES: Record<string, string> = { dog: 'su perro', perro: 'su perro', cat: 'su gato', gato: 'su gato', rabbit: 'su conejo', conejo: 'su conejo', bird: 'su pájaro', parrot: 'su loro', 'guinea pig': 'su cuyo', ferret: 'su hurón', hamster: 'su hámster' };
const DIGITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
/** A note written to follow a comma, said as a sentence of its own. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The same personal texts as in English: the names when the call gave them, never empty ones. The kind of visit is not named in Spanish (its article depends on the word). */
const hola = (v: Record<string, string>, rest: string) => (v.name ? `Hola ${v.name}, ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1));
const citaDe = (v: Record<string, string>) => `${v.pet ? `la cita de ${v.pet}` : 'su cita'}${v.provider ? ` con ${v.provider}` : ''}`;
const pedidoDe = (v: Record<string, string>) => (v.pet ? `el pedido de ${v.pet}` : 'su pedido');
/** El número del pedido, para que quien llama y el equipo hablen del mismo: " (R-1042)". */
const ref = (v: Record<string, string>) => (v.ref ? ` (${v.ref})` : '');

export const es: LanguagePack = {
  code: 'es',
  name: 'Spanish',
  nativeName: 'Español',
  locale: 'es-US',
  prompt: [
    'If the caller speaks Spanish, answer in Spanish for the rest of the call, using usted.',
    'In Spanish, keep sentences short and say dates and times the way they are given to you.',
    'In Spanish, warmth is short and natural: "ajá", "claro" or "entiendo" while they talk, "Ay, lo siento mucho" for bad news, and a name said back ("Muy bien, Ginger entonces").',
  ],
  greeting: ({ assistantName, clinicName }) => `Gracias por llamar a ${clinicName}. ${assistantName ? `Soy ${assistantName}, la` : 'Soy la'} asistente virtual con inteligencia artificial de la clínica. ¿En qué le puedo ayudar?`,
  disclosure: /\b(asistente (virtual|de ia|con inteligencia artificial|automatizad[oa])|inteligencia artificial)\b/i,
  // en entero siempre (2026-11-14): el día de la semana, la fecha y la hora
  speakWhen: (start, timeZone) => fullWhen(start, timeZone),
  fullWhen,
  fullDay,
  speakPhone: (e164) => e164.replace(/\D/g, '').split('').map((d) => DIGITS[Number(d)]).join(' '),
  readbackBooking: ({ when: w, provider, providerKind, visit, replacing, pet, shift }) => (replacing
    ? `cambiar la cita${pet ? ` de ${pet}` : ''} del ${sinEl(replacing)} al ${sinEl(w)} ${providerKind === 'room' ? 'en' : 'con'} ${provider}${shift ? `; ${shift}` : ''}`
    : `${w} ${providerKind === 'room' ? 'en' : 'con'} ${provider}, para ${visit}`),
  readbackCancel: ({ when: w }) => `cancelar la cita del ${sinEl(w)}`,
  sms: {
    booking_confirmed: (v) => `${v.clinic}: ${hola(v, `${citaDe(v)} es el ${sinEl(v.when)}.`)} Para cambiarla o cancelarla, llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    request_ready: (v) => `${v.clinic}: ${hola(v, `${pedidoDe(v)}${ref(v)} está listo para recoger.`)} ¿Preguntas? Llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    refill_sent: (v) => `${v.clinic}: ${hola(v, `${pedidoDe(v)}${ref(v)} se envió a ${v.pharmacy}.`)} ¿Preguntas? Llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    refill_not_approved: (v) => `${v.clinic}: ${hola(v, `sobre ${v.pet ? `el pedido reciente de ${v.pet}` : 'su pedido reciente'}${ref(v)}, por favor llámenos al ${v.clinicPhone}.`)} Responda STOP para no recibir más mensajes.`,
    change_confirmed: (v) => `${v.clinic}: ${hola(v, `${citaDe(v)} se cambió ${v.from ? `del ${sinEl(v.from)} ` : ''}al ${sinEl(v.when)}.`)} Para cambiarla o cancelarla, llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    cancel_confirmed: (v) => `${v.clinic}: ${hola(v, `${citaDe(v)} del ${sinEl(v.when)} quedó cancelada.`)} Para reservar otra, llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    vet_changed: (v) => `${v.clinic}: ${hola(v, `${v.pet ? `la cita de ${v.pet}` : 'su cita'} del ${sinEl(v.when)} ahora es con ${v.provider}, a la misma hora.`)} Para cambiarla o cancelarla, llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    directions: (v) => `${v.clinic}: ${v.address}. Mapa: ${v.mapUrl}. Responda STOP para no recibir más mensajes.`,
    hours: (v) => `Horario de ${v.clinic}: ${v.hours}. Responda STOP para no recibir más mensajes.`,
    emergency_hospital: (v) => `${v.clinic}: urgencias veterinarias: ${v.hospital}, ${v.hospitalAddress}, tel. ${v.hospitalPhone}. Si una persona está herida o en peligro, llame al ${v.emergencyNumber}. Responda STOP para no recibir más mensajes.`,
    provider: (v) => `${v.clinic}: ${v.provider}${v.details ? `, ${v.details}` : ''}. ¿Preguntas? Llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    answer: (v) => `${v.clinic}: ${v.answer} ¿Preguntas? Llame al ${v.clinicPhone}. Responda STOP para no recibir más mensajes.`,
    link: (v) => `${v.clinic}: ${v.label}: ${v.url} Responda STOP para no recibir más mensajes.`,
    reminder: (v) => `${v.clinic}: ${hola(v, `le recordamos ${citaDe(v)} el ${sinEl(v.when)}.`)} Responda C para confirmarla, o llame al ${v.clinicPhone} para cambiarla. Responda STOP para no recibir más mensajes.`,
  },
  textOffer: ({ target }) => (target === 'file' ? '¿Quiere que se lo envíe por mensaje de texto al número que tenemos en su ficha?' : '¿Quiere que se lo envíe por mensaje de texto al número desde el que llama?'),
  textSent: 'Listo, se lo acabo de enviar.',
  noProviderForVisit: ({ visit, pets }) => `Ningún ${pets ? 'veterinario' : 'médico'} ofrece ${visit}: quienes llaman no pueden reservarlo`,
  textRefused: ({ reason }) => (reason === 'opted_out' ? 'Ese número pidió no recibir mensajes nuestros, así que se lo leo.' : 'No puedo enviar mensajes de texto, así que se lo digo despacio.'),
  reminderOffer: '¿Quiere un recordatorio por mensaje de texto el día antes de la cita? Pueden aplicarse tarifas de mensajes y datos, y puede responder STOP cuando quiera.',
  refillTextOffer: '¿Quiere un mensaje de texto a ese número cuando el equipo lo haya decidido? Pueden aplicarse tarifas de mensajes y datos, y puede responder STOP cuando quiera.',
  sameNumberQuestion: '¿El número desde el que llama es el mejor para comunicarnos con usted?',
  callbackNumberQuestion: '¿Cuál es el mejor número para comunicarnos con usted?',
  yourNameQuestion: '¿Y su nombre?',
  thanksOwner: ({ owner }) => `Gracias, ${owner}.`,
  whichPetVerified: ({ owner, names, more, offerNew }) => {
    const or = (next: string) => (/^h?o/i.test(next) ? 'u' : 'o');
    const list = names.length === 2 ? `${names[0]} o para ${names[1]}`
      : names.length > 2 ? `${names.slice(0, -1).join(', ')} ${or(names.at(-1)!)} ${names.at(-1)}` : names[0] ?? '';
    return `Gracias, ${owner}. ¿Es para ${list}${more ? ', o para otra mascota' : offerNew ? ', o para una mascota nueva' : ''}?`;
  },
  whichWeek: ({ first, second }) => `¿Este ${fullDay(first)}, o el ${fullDay(second)}?`,
  bookedByCallerNote: ({ name }) => `reservada por quien llamó: ${name}`,
  foundByLastFourNote: 'encontrada en la llamada por los últimos cuatro dígitos del número y el nombre de la mascota',
  // written without accents: the text is normalised before it is matched
  memory: {
    species: {
      perro: 'dog', perra: 'dog', perrito: 'dog', perrita: 'dog', cachorro: 'dog', cachorra: 'dog', gato: 'cat', gata: 'cat', gatito: 'cat', gatita: 'cat',
      conejo: 'rabbit', coneja: 'rabbit', pajaro: 'bird', loro: 'parrot', perico: 'parakeet', cuyo: 'guinea pig', hamster: 'hamster', huron: 'ferret',
      lagartija: 'lizard', serpiente: 'snake', tortuga: 'turtle',
    },
    female: /\b(hembra|nina|perra|perrita|gata|gatita|coneja|cachorra|esterilizada)\b/g,
    // only words that say the sex: "perro" and "gato" are said of either sex, so they never set it
    male: /\b(macho|nino|castrado)\b/g,
    she: /\b(ella)\b/,
    he: /(?!)/,
    age: /\b(?:tiene|de)\s+(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|dieciocho)\s+(anos?|mes(?:es)?|semanas?)\b/g,
    numbers: { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, dieciocho: 18 },
    intent: {
      book: /\b(reservar|agendar|traerl[oa]|traer)\b/g,
      visit: /\b(cita|consulta|chequeo|revision)\b/g,
      want: /\b(quiero|quisiera|necesito|necesita|gustaria|hacer|sacar|toca)\b/g,
      move: /\b(cambiar|mover|reprogramar|cambiela|cambiala|pasela|pasala|mejor a las)\b/g,
      cancel: /\b(cancelar|anular)\b/g,
    },
    weekdays: ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
    months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    today: /\b(hoy)\b/g,
    tomorrow: /(?<!\b(?:la|esta|pasado)\s)\b(manana)\b/g,
    thisWord: 'este',
    nextWord: 'proximo',
    anyVet: /\b(cualquier (?:doctor|doctora|veterinari[oa])|cualquiera|me da igual (?:quien|cual)|no importa (?:quien|cual))\b/g,
    anyDay: /\b(cualquier dia|lo (?:antes|mas pronto) posible|la primera (?:cita|hora) (?:disponible|libre)|lo primero que tenga)\b/g,
    time: /\b(?:(a las|a la|como a las|alrededor de las|despues de las|antes de las|antes de la|tipo)\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*(de la (?:manana|tarde|noche)|a\.?m\b\.?|p\.?m\b\.?))?(?!\s*(?:anos?|meses|semanas?|dias?|horas?|minutos?|mascotas?|de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))\b)(?![\d:-])/g,
    after: /^despues de las$/,
    before: /^antes de las?$/,
    around: /^(?:como a las|alrededor de las|tipo)$/,
    pm: /tarde|noche|p\.?m/,
    am: /manana|a\.?m/,
  },
  // "o" becomes "u" before a name that starts with an o sound: "Max u Oreo"
  whichPet: ({ names, more }) => {
    const or = (next: string) => (/^h?o/i.test(next) ? 'u' : 'o');
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} ${or(names.at(-1)!)} ${names.at(-1)}` : names[0]!;
    return names.length > 1
      ? `Veo a ${list.replace(/ [ou] ([^ ]+)$/, ' y $1')} con este número. ¿Para cuál es${more ? ', o es para otra mascota' : ', o es para una mascota nueva'}?`
      : `Veo a ${list} con este número. ¿Es para ${list}, ${more ? 'o para otra mascota' : 'o para una mascota nueva'}?`;
  },
  lastVisitSeen: ({ pet, when: w, provider, visit }) => `La última visita que veo de ${pet} fue el ${sinEl(w)}${provider ? ` con ${provider}` : ''}${visit ? `, para ${visit.toLowerCase()}` : ''}.`,
  recordsOffer: 'No puedo dar detalles médicos por teléfono, pero puedo pedirle al equipo que le envíe el historial por escrito. ¿Le parece bien?',
  phoneAsGiven: ({ digits }) => `Tengo ${digits}. Lo anoto tal como me lo dio.`,
  petNewQuestion: ({ pet }) => `¿Es la primera vez que ${pet} viene con nosotros?`,
  profileNumberQuestion: ({ last4 }) => (last4 ? `Claro. ¿La ficha de su mascota está con el número desde el que llama, que termina en ${last4}?` : 'Claro. ¿Con qué número de teléfono está registrada la ficha de su mascota?'),
  phoneReadback: ({ grouped }) => `¿Es el ${grouped}?`,
  foundPet: ({ pet, species }) => {
    const kind = species ? SPECIES_ES[species.toLowerCase()] ?? null : null;
    return kind ? `Encontré a ${pet}, ${kind}.` : `Encontré a ${pet}.`;
  },
  notSeenPet: ({ pet }) => `No veo a ${pet} con ese número.`,
  noPetsOnNumber: 'No veo ninguna ficha con ese número.',
  numberNotOpened: 'No puedo abrir una ficha con esos datos en esta llamada. Puedo dejarle un mensaje al equipo para que le devuelvan la llamada.',
  lastFourQuestion: ({ after }) => (after === 'no_profile'
    ? '¿Cuáles son los últimos cuatro dígitos del número con el que podría estar la ficha, y el nombre de su mascota? Si es nueva para nosotros, la puedo registrar.'
    : 'Probemos de otra forma. ¿Cuáles son los últimos cuatro dígitos del número con el que está la ficha, y el nombre de su mascota?'),
  lastFourNoMatch: 'No encontré una sola ficha con esos datos.',
  teamBooks: ({ visit, notice, related }) => `Nuestro equipo reserva ${visit.toLowerCase()} directamente${notice ? `, con al menos ${notice.replace(/days?/, 'días').replace(/hours?/, 'horas')} de anticipación` : ''}. Puedo dejarle una solicitud al equipo${related ? `, o reservarle primero ${related.toLowerCase()}` : ''}. ¿Qué prefiere?`,
  confirmTextNote: ({ target }) => (target === 'calling' ? 'le enviaré una confirmación por mensaje de texto al número desde el que llama, si le parece bien' : 'le enviaré una confirmación por mensaje de texto al número de su ficha, si le parece bien'),
  smsConfirmed: ({ clinic, when }) => `${clinic}: gracias, su cita del ${sinEl(when)} está confirmada.`,
  shortDays: ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'],
  smsNoReplies: ({ clinicPhone }) => `Este número no lee respuestas. Llame al ${clinicPhone}.`,
  abuseWarning: 'Quiero ayudarle, pero si este lenguaje continúa tendré que terminar la llamada. También puedo pedir que alguien de la clínica le llame.',
  abuseGoodbye: 'Voy a terminar la llamada ahora. Puede volver a llamar cuando quiera. Adiós.',
  takeOver: 'Le comunico con una persona de nuestro equipo ahora mismo.',
  returnedCallLine: ({ clinic }) => `Le habla el asistente telefónico de ${clinic}. La clínica no suele llamar desde esta línea, así que la llamada que recibió puede no haber sido nuestra. ¿Es usted cliente de ${clinic}, o quiere dejar un mensaje para el equipo?`,
  slots: {
    exactFree: ({ date, time, provider }) => { const h = hora(time.hour, time.minute); return `Sí, el ${fullDay(date)} ${h.at} ${h.time} ${partOfDay(time.hour, time.minute)} está libre${provider ? ` con ${provider}` : ''}. ¿Se la reservo?`; },
    notAt: ({ time, day }) => { const h = hora(time.hour, time.minute); return `${mayuscula(h.at)} ${h.time} no, pero el ${fullDay(day.date)} tengo ${horas(day)}.`; },
    nearest: ({ day }) => `Lo más cercano es el ${fullDay(day.date)} ${horas(day)}.`,
    vetHours: ({ provider, weekday, starts, ends }) => (starts
      ? `${provider} empieza ${aLas(starts)} ${losDias(weekday)}.`
      : `${provider} termina ${aLas(ends!)} ${losDias(weekday)}.`),
    frontDesk: ({ weekday, provider, from, to, clinicOpens, clinicCloses, oneDay }) => (oneDay
      ? `La recepción de la clínica está cerrada el ${fullDay(oneDay)}, pero ${provider} atiende ese día de ${horaCorta(from)} a ${horaCorta(to)}.`
      : clinicOpens && clinicCloses
      ? from.hour * 60 + from.minute < clinicOpens.hour * 60 + clinicOpens.minute
        ? `La recepción de la clínica abre ${aLas(clinicOpens)} ${losDias(weekday)}, pero ${provider} atiende desde ${aLas(from).replace(/^a /, '')}.`
        : `La recepción de la clínica cierra ${aLas(clinicCloses)} ${losDias(weekday)}, pero ${provider} atiende hasta ${aLas(to).replace(/^a /, '')}.`
      : `La recepción de la clínica está cerrada ${losDias(weekday)}, pero ${provider} atiende el ${DIAS[weekday]} de ${horaCorta(from)} a ${horaCorta(to)}.`),
    doesntDoType: ({ provider, visit, theirVisits, others }) => `${provider} no hace ${visit}; sus consultas son ${yList(theirVisits)}. `
      + (others.length ? `${yList(others)} ${others.length > 1 ? 'hacen' : 'hace'} ${visit}. ¿Busco con ${others.length > 1 ? 'ellos' : others[0]}?` : `Ahora mismo nadie aquí hace ${visit}. ¿Dejo una solicitud para el equipo?`),
    notWorkingThatDay: ({ provider, weekday, days }) => `${provider} no trabaja ${losDias(weekday)}. ${days.length ? `Atiende ${diasPalabras(days)}.` : 'No tiene horario esta semana.'}`,
    fullyBooked: ({ provider, date }) => (provider ? `${provider} no tiene horas libres el ${fullDay(date)}.` : `No tenemos horas libres el ${fullDay(date)}.`),
    nothingThrough: ({ provider, date }) => `No encuentro horas libres${provider ? ` con ${provider}` : ''} hasta el ${fullDay(date)}.`,
    tooFarAhead: ({ visit, days, lastDate }) => `${mayuscula(visit)} se reserva con hasta ${days} días de anticipación, así que el último día que puedo reservarla es el ${fullDay(lastDate)}.`,
    notice: ({ visit, hours, firstDate }) => `${mayuscula(visit)} necesita al menos ${avisoTexto(hours)} de anticipación, así que el primer día que puedo reservar es el ${fullDay(firstDate)}.`,
    clinicClosed: ({ date, note }) => `La clínica está cerrada el ${fullDay(date)}${note ? ` (${note})` : ''}.`,
  },
  tooSlow: 'Disculpe, esto está tardando más de lo debido. Si quiere, puedo pedir que alguien de la clínica le llame para eso.',
  couldNotFinish: 'Disculpe, no pude completar eso ahora. Puedo pedir que alguien de la clínica le llame.',
  spoken: {
    readback: ({ readback, textNote, move }) => (move
      ? `Entonces, quiere ${readback}. ${textNote ? `${sentence(textNote)}. ` : ''}¿Hago el cambio?`
      : `Tengo ${readback}. ${textNote ? `${sentence(textNote)}. ` : ''}¿Le reservo la cita?`),
    cancelReadback: ({ readback, textNote }) => `Entonces, quiere ${readback}. ${textNote ? `${sentence(textNote)}. ` : ''}¿Es correcto?`,
    done: ({ kind, textSent, then }) => `${kind === 'booked' ? 'Listo, la cita queda reservada.' : kind === 'rescheduled' ? 'Listo, la cita queda cambiada.' : 'Listo, la cita queda cancelada.'}${textSent ? ' Le he enviado un mensaje de confirmación.' : ''} ${then}`,
    anythingElse: '¿Hay algo más en lo que le pueda ayudar?',
    goodbye: 'Que le vaya bien. ¡Adiós!',
    callbackTaken: ({ sameNumber }) => `De acuerdo, se lo paso al equipo y alguien le llamará ${sameNumber ? 'a este número' : 'al número que me dio'}. ¿Hay algo más en lo que le pueda ayudar?`,
    refillTaken: 'He enviado la solicitud de la receta al equipo; la revisarán y se pondrán en contacto con usted. ¿Hay algo más en lo que le pueda ayudar?',
    urgentRequestTaken: 'Le envié esto al equipo como urgente, y alguien le llamará lo antes posible.',
    textSent: 'Listo, se lo acabo de enviar. ¿Hay algo más en lo que le pueda ayudar?',
    reminders: ({ agreed }) => `${agreed ? 'Perfecto, recibirá un recordatorio por mensaje de texto el día antes de la cita.' : 'De acuerdo, sin recordatorios por mensaje de texto.'} ¿Hay algo más en lo que le pueda ayudar?`,
    noVetForAnimal: ({ vet, animals, pet }) => `${vet && animals ? `${vet} solo atiende ${animals}` : 'Ninguno de nuestros veterinarios atiende ese tipo de animal'}, así que no puedo agendar eso aquí. ¿Quiere que deje una solicitud para que el equipo agende a ${pet}?`,
    noTransfer: 'Ahora mismo no puedo pasarle con nadie, pero pediré que el equipo le llame. ¿De qué se trata?',
    lookingUp: ({ kind, day, pet }) => kind === 'times_on' && day ? `Déjeme revisar ${day === 'hoy' || day === 'mañana' ? day : `el ${day}`}.`
      : kind === 'times' ? 'Un momento, reviso los horarios.'
      : kind === 'pet' && pet ? `Déjeme buscar a ${pet}.`
      : kind === 'visits' && pet ? `Déjeme ver las visitas de ${pet}.`
      : kind === 'number' ? 'Déjeme revisar ese número.'
      : 'Déjeme consultarlo.',
    oneMoment: 'Un momento.',
    dayWord: ({ daysFromToday, weekday }) => (daysFromToday === 0 ? 'hoy' : daysFromToday === 1 ? 'mañana' : ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][weekday]!),
    offerTimes: ({ days, provider }) => {
      if (!days.length) return '';
      const [first, ...rest] = days.map((d) => ({ day: fullDay(d.date), times: horas(d) }));
      const others = rest.map((d, i) => `${i === rest.length - 1 ? 'o ' : ''}el ${d.day} ${d.times}`);
      return `El ${first!.day} tengo ${[first!.times, ...others].join(', ')}${provider ? `, con ${provider}` : ''}.`;
    },
    dayShift: ({ days, day }) => {
      const n = Math.abs(days);
      const phrase = days === 1 ? 'el día siguiente' : days === -1 ? 'el día anterior'
        : n % 7 === 0 && n <= 28 ? `${n === 7 ? 'una semana' : `${NUMEROS[n / 7]} semanas`} ${days > 0 ? 'después' : 'antes'}`
          : n < 7 ? `${NUMEROS[n]} días ${days > 0 ? 'después' : 'antes'}` : 'otro día';
      return `es ${phrase}, el ${day}`;
    },
  },
  petEmergencyNext: ({ pet, transfer }) => `Ahora mismo no puedo reservar una visita de rutina para ${pet ?? 'su mascota'}, con lo que está pasando. ${transfer
    ? 'Le puedo pasar con nuestro equipo ahora mismo. ¿Quiere?'
    : 'Puedo enviarle a nuestro equipo un mensaje urgente para que le llamen lo antes posible. ¿Quiere?'}`,
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
    ['allergic', words('se (me|le) (esta )?(cerrando|hinchando) la garganta|(se (me|le) )?cierra la garganta|garganta hinchada|anafilaxia|lengua hinchada')],
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
