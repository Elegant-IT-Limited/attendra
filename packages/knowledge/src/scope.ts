// SPDX-License-Identifier: AGPL-3.0-only
import { detectLanguage, type Language, normalise, words } from '@attendra/core';

/**
 * What the assistant says to a question that is not about the clinic: one polite
 * line, in the caller's language, and nothing about how the assistant is made.
 */
export const OFF_TOPIC_LINE: Record<'en' | 'es', string> = {
  en: 'I can help with questions about the clinic, appointments and your pet.',
  es: 'Puedo ayudarle con preguntas sobre la clínica, las citas y su mascota.',
};
export const isOffTopicLine = (text: string) => Object.values(OFF_TOPIC_LINE).includes(text.trim());

/**
 * How the assistant is built: software, vendors, AI models, prompts, servers. A
 * tester asked "what stack is used to build this app?" and heard technical details
 * read from an unrelated upload. None of this is the clinic's business to tell a
 * caller, so a question that asks about it is refused before anything is searched.
 * Words that are also clinic words stay out ("provider" is a doctor, "code" a door
 * code, "llama" an animal): they count only in phrases.
 */
const SYSTEM = [
  // English: the stack and the code
  'stack|tech stack|framework|frameworks|programming|programming language|source code|codebase|code base|built with|built using|developed with|written in (javascript|typescript|python|java|which language|what language)',
  'software|backend|back end|frontend|front end|database|databases|data base|server|servers|hosting|hosted on|cloud|aws|azure|api|apis|endpoint|endpoints|sdk|webhook|webhooks',
  'javascript|typescript|python|java|nodejs|node\\.js|reactjs|react native|nextjs|next\\.js|nestjs|postgres|postgresql|sql|mysql|mongodb|docker|kubernetes|github|repository|repo|open source|vercel',
  '(who|which company|what company) (made|built|created|developed|programmed|designed|makes|builds|runs) (you|this|it|the (app|assistant|system|software|website|bot))',
  '(how|what) (is|was|were) (this|the|your) (app|application|software|system|website|site|assistant|bot) (built|made|developed|created|programmed|coded)',
  // the model and the AI behind it ("AI" alone is also artificial insemination, at a vet)
  '(an|the|your|which|what|use|uses|using|are you) ai|ai (model|models|assistant|system|company|voice|receptionist|powered|tool|tools)|ai-powered|a\\.i\\.',
  'artificial intelligence|machine learning|neural network|llm|llms|language model|large language model|chatbot|bot|robot|gpt|gpt-\\d\\w*|chatgpt|openai|open ai|anthropic|claude ai|gemini ai|google gemini|copilot|mistral ai',
  '(which|what|your) model|model (are you|do you use|is this|powers you)|algorithm|algorithms|embedding|embeddings|vector database|tokens',
  // the instructions it runs on ("prompt" alone is prompt care, prompt payment)
  'system prompt|your prompt|prompt injection|prompt engineering|initial prompt|your instructions|your rules|your configuration|ignore (all|your|the|previous)\\w*|jailbreak|developer mode',
  // the vendors behind the call
  'twilio|vapi|retell|elevenlabs|deepgram|speech to text|text to speech|tts|stt|vendor|vendors|tech company|technology company',
  'are you (a |an )?(real )?(bot|robot|ai|machine|computer|human|person|program)|what are you',
  // Spanish, without accents: the text is normalised first ("programacion" is also the booking of visits,
  // and "esta hecha" a booking made, so neither counts alone)
  'pila tecnologica|codigo fuente|lenguaje de programacion|construida con|construido con|con que tecnologia',
  'base de datos|bases de datos|servidor|servidores|nube|plataforma tecnologica|que software|el software|este software',
  'inteligencia artificial|(la|una|de|usan|eres|con) ia|modelo de lenguaje|modelo de ia|que modelo|tu modelo|algoritmo|aprendizaje automatico|robot|bot',
  'quien (te|lo|la) (hizo|creo|programo|desarrollo|construyo|diseno)|que empresa (te|lo|la) (hizo|creo|programo|desarrollo)',
  'tu prompt|prompt del sistema|tus instrucciones|tus reglas|ignora (todas|tus|las)\\w*|proveedor de (software|tecnologia|telefonia|voz|ia)|proveedores de (software|tecnologia|telefonia|voz|ia)',
  'eres (un |una )?(robot|bot|ia|maquina|computadora|humano|humana|persona real|programa)|que eres',
].join('|');

/**
 * Questions that are plainly about something else: the weather, sport, jokes,
 * homework. Phrases, not single words, so "are you open in bad weather?" and "a
 * health certificate for my dog's flight" stay clinic questions.
 */
const ELSEWHERE = [
  'weather forecast|what(\'s| is) the weather|weather (today|tomorrow|this week|this weekend)|will it (rain|snow)',
  'who won|football|soccer|baseball|basketball|hockey|super bowl|world cup|the game (last night|tonight)|score of the game',
  'joke|jokes|poem|poems|song|songs|lyrics|riddle|riddles',
  'capital of|president of|prime minister|election|elections|politics|news today|the news',
  'lasagna|make (a )?pizza|pizza recipe|pasta recipe|cake recipe|bake (a|some)|recipe for (a |an )?(cake|pie|soup|pasta|dinner|cookies)',
  'bitcoin|crypto|cryptocurrency|stock market|stocks|lottery|horoscope|zodiac',
  'movie|movies|film to watch|tv show|netflix|video game|video games',
  'homework|math problem|translate (this|the following|into)|meaning of life|tell me about yourself|your favorite',
  // Spanish
  'pronostico|como estara el clima|que clima|el clima (hoy|manana)|va a llover',
  'quien gano|futbol|beisbol|baloncesto|partido de anoche|el partido|mundial',
  'chiste|chistes|poema|poemas|cancion|canciones|adivinanza',
  'capital de|presidente de|primer ministro|eleccion|elecciones|las noticias|noticias de hoy',
  'lasana|hacer (una )?pizza|paella|receta de pastel|hacer un pastel|receta de cocina',
  'bitcoin|criptomoneda|criptomonedas|bolsa de valores|loteria|horoscopo|signo del zodiaco',
  'pelicula|peliculas|serie de television|netflix|videojuego|videojuegos',
  'tarea de|problema de matematicas|matematicas|sentido de la vida|cuentame de ti|tu favorito|tu favorita',
].join('|');

/**
 * What a clinic is asked about: hours, prices, policies, services, directions, the
 * vets, preparing for a visit, appointments and the animals. Used to tell whether an
 * upload reads like clinic information. Words a manual or someone's notes use as much
 * ("open", "team", "results", a day of the week) are left out, so they do not make a
 * manual or a to-do list look like a price list.
 */
const CLINIC = [
  'hours|opening hours|closed|closes|closing time|holiday|holidays|after hours|after-hours',
  'price|prices|pricing|cost|costs|fee|fees|how much|pay|paid|payment|payments|card|cards|cash|insurance|deposit|deposits|refund|refunds|bill|bills|billing|invoice|invoices|discount|discounts',
  'park|parking|address|directions?|located|location|where are you|get there|bus|buses|street|avenue|floor|suite|entrance|ramp|elevator|wheelchair|highway',
  'appointment\\w*|book|booking|bookings|booked|rebook\\w*|reschedul\\w*|cancel\\w*|visit|visits|walk-?ins?|check-?ups?|exam|exams|examination|consultation\\w*|late|arriv\\w*|waiting room|wait time|new patients?|new clients?|registration',
  'vets?|veterinar\\w*|doctors?|dr|nurses?|technicians?|front desk|reception\\w*|clinic|clinics|hospital|office|medicine|medical',
  'pets?|dogs?|puppy|puppies|cats?|kittens?|rabbits?|birds?|reptiles?|horses?|animals?|species|patients?|clients?',
  'vaccin\\w*|shots?|rabies|booster\\w*|wellness|dental|teeth|surgery|spay\\w*|neuter\\w*|microchip\\w*|groom\\w*|boarding|x-?rays?|blood work|bloodwork|refills?|prescriptions?|medications?',
  'policy|policies|bring|prepare|preparation|fasting|forms?|records?|services?|emergenc\\w*|urgent|callback|callbacks|call back|call you back|call me back',
  // Spanish
  'horario\\w*|abren|abierto\\w*|cierran|cerrado\\w*|festivo\\w*|fuera de horario',
  'precio\\w*|costo\\w*|cuesta\\w*|cuanto|tarifa\\w*|pago|pagos|pagar|tarjeta\\w*|efectivo|seguro|seguros|deposito\\w*|reembolso\\w*|presupuesto\\w*|factura\\w*|descuento\\w*',
  'estacion\\w*|aparca\\w*|direccion|ubicacion|ubicad\\w*|como llego|llegar|autobus|calle|avenida|piso|entrada|rampa|ascensor|elevador|silla de ruedas|autopista',
  'cita|citas|consulta|consultas|reserv\\w*|agend\\w*|reprogram\\w*|cancel\\w*|visita\\w*|revision\\w*|chequeo\\w*|examen\\w*|sala de espera|nuevo cliente|nuevos clientes',
  'veterinari\\w*|doctor\\w*|enfermer\\w*|recepcion\\w*|clinica\\w*|hospital\\w*|consultorio',
  'mascota\\w*|perro\\w*|perra\\w*|cachorr\\w*|gato\\w*|gata\\w*|gatito\\w*|conejo\\w*|pajaro\\w*|aves?|reptil\\w*|caballo\\w*|animal\\w*|paciente\\w*|cliente\\w*',
  'vacun\\w*|rabia|refuerzo\\w*|bienestar|dental|dientes|cirugia\\w*|esteriliz\\w*|castra\\w*|microchip\\w*|peluqueria|guarderia|hospedaje|radiografia\\w*|analisis de sangre|receta\\w*|medicamento\\w*',
  'politica\\w*|traer|llevar|preparar\\w*|ayuno|ayunas|formulario\\w*|expediente\\w*|historial|servicio\\w*|emergencia\\w*|urgencia\\w*|devolver la llamada|le llamamos|le llamaremos',
].join('|');

const SYSTEM_RE = words(SYSTEM);
const ELSEWHERE_RE = words(ELSEWHERE);
const CLINIC_RE = words(CLINIC, 'gu');
const SYSTEM_ALL = words(SYSTEM, 'gu');

export type QuestionScope = 'clinic' | 'off_topic' | 'system';

/**
 * Whether a question is the clinic's to answer. Cheap and deterministic: no model,
 * and the same answer every time. A question about the system (its stack, its AI
 * model, its prompt, its vendors) is 'system', whatever else it says. One that is
 * plainly about something else (the weather, sport, a joke) is 'off_topic'. Anything
 * else is 'clinic', for the documents to answer or not.
 */
export function questionScope(question: string): QuestionScope {
  const q = normalise(question);
  if (SYSTEM_RE.test(q)) return 'system';
  if (ELSEWHERE_RE.test(q)) return 'off_topic';
  return 'clinic';
}

/** The language of a question, English or Spanish, for the off-topic line. */
export function questionLanguage(question: string): 'en' | 'es' {
  // an inverted mark or an accented letter is Spanish here; English questions have neither
  if (/[¿¡ñáéíóú]/i.test(question)) return 'es';
  return detectLanguage(question, ['en', 'es'] as Language[], 'en') === 'es' ? 'es' : 'en';
}

export interface DocumentAssessment {
  /** Words in the document, counted as the full-text search counts them. */
  words: number;
  /** Clinic words: hours, prices, visits, the animals, directions. */
  clinic: number;
  /** System words: software, servers, AI models, vendors. */
  technical: number;
  /** Whether it reads like clinic information a caller may hear. */
  clinicInformation: boolean;
}

/**
 * Whether an upload reads like clinic information, from its words: at least two clinic
 * words, one in sixty at least, and more clinic words than technical ones. Whatever is uploaded may be read to a caller, so a
 * document that fails is not kept without a yes.
 */
export function assessDocument(text: string): DocumentAssessment {
  // a bounded sample: the first 200,000 characters say what a document is about
  const t = normalise(text.slice(0, 200_000));
  const total = t.split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length > 1).length;
  const clinic = t.match(CLINIC_RE)?.length ?? 0;
  const technical = t.match(SYSTEM_ALL)?.length ?? 0;
  const clinicInformation = clinic > technical && clinic >= 2 && clinic * 60 >= total;
  return { words: total, clinic, technical, clinicInformation };
}

/**
 * Whether a passage found for a question is mostly about the system rather than the
 * clinic. Such a passage is never read out: uploaded notes about a vendor or the
 * software must not reach a caller, whatever the question was.
 */
export function isTechnicalPassage(text: string): boolean {
  const a = assessDocument(text);
  return a.technical >= 2 && a.technical >= a.clinic;
}

/**
 * The line to say instead of searching, or null for a clinic question: the one call
 * a tool needs to make before it looks anything up.
 */
export function outOfScopeLine(question: string): string | null {
  return questionScope(question) === 'clinic' ? null : OFF_TOPIC_LINE[questionLanguage(question)];
}
