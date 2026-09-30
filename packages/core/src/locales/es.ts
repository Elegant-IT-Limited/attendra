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
    booking_confirmed: (v) => `${v.clinic}: su cita es el ${v.when}. Para cambiarla o cancelarla, llame al ${v.clinicPhone}.`,
  },
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
  yes: new RegExp(`^si(?=\\s*[,.!]|$)|${words('claro|correcto|esta bien|de acuerdo|perfecto|exacto|adelante|confirmo|reservela|hagalo|asi es').source}`, 'u'),
  yesAlone: /^(vale|por favor|si por favor)$/,
  hedge: new RegExp(`${words('no|espere|espera|mejor|tal vez|quizas?|a lo mejor|en realidad|otro|otra|cambiar|momento|pensandolo|pero|prefiero|aunque|repita').source}|[?¿]`, 'u'),
  markers: /\b(el|la|los|las|de|que|por|para|con|una?|quiero|necesito|cita|gracias|hola|senor|senora|manana|hoy|si|esta|usted|puedo)\b/g,
};
