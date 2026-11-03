// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turns a real call's words into made-up ones, for a draft scenario (2026-11). It fails closed: whatever it
 * cannot classify as an ordinary word, a short number or punctuation is replaced.
 *
 * In order: emails, street addresses, dates, then the known entities (from the database: the clinic, its vets,
 * the owners and pets on the call's numbers, every number), then any run of three or more digits or spoken
 * digits ("seven two oh") as a made-up 555-01xx number, then any capitalised word that is not a common word or
 * one of the clinic's own visit words as the next made-up name. The same input always gives the same output,
 * and the same real value always gets the same made-up one within a call.
 *
 * What it cannot see: a real name written in lower case that is not on the call's numbers, or one that is also a
 * common word ("Hope", "Max"). So drafts stay git-ignored and a person reads each one before it becomes a scenario.
 */

/** What the database knows about the call, every value real. Each list in the order the database gave it. */
export interface KnownEntities {
  /** The clinic's name, its other locations', its emergency hospitals'. */
  clinic: string[];
  /** The assistant's name. */
  assistant: string[];
  /** The vets' (or doctors') names, with or without a title. */
  vets: string[];
  /** The owners' names (or, at a clinic for people, the patients'). */
  owners: string[];
  /** The pets' names. */
  pets: string[];
  /** Every phone number: the caller's first, then the ones on file. */
  numbers: string[];
  /** Street addresses, the clinic's and the hospitals'. */
  addresses: string[];
  /** Words that are never names: the clinic's visit types, its animal lists. */
  keep: string[];
}

export const emptyKnown = (): KnownEntities => ({ clinic: [], assistant: [], vets: [], owners: [], pets: [], numbers: [], addresses: [], keep: [] });

const OWNERS = [['Jordan', 'Lee'], ['Alex', 'Park'], ['Sam', 'Gray'], ['Taylor', 'Reed'], ['Casey', 'Moss'], ['Morgan', 'Hale']] as const;
const VETS = [['Elena', 'Ruiz'], ['Marcus', 'Bell'], ['Hana', 'Sato'], ['Priya', 'Shah'], ['Owen', 'Fry']] as const;
const PETS = ['Biscuit', 'Pepper', 'Clover', 'Ziggy', 'Pickle', 'Waffles', 'Nugget', 'Olive'] as const;
const CLINICS = ['Riverbend Animal Hospital', 'Front Range Pet Emergency', 'Riverbend North', 'Riverbend South'] as const;
const OTHERS = ['Robin', 'Avery', 'Quinn', 'Drew', 'Rowan', 'Skyler', 'Emery', 'Harper', 'Reese', 'Logan', 'Parker', 'Blake'] as const;
const ADDRESS = '100 Main Street';
const EMAIL = 'jordan@example.com';
const SPOKEN_EMAIL = 'jordan at example dot com';
const REDACTED = '[redacted]';

// the words a sentence or a name can start with that are never a person's name; folded (no accents, lower case)
const COMMON = new Set(`
a about after again ah all also am an and any anything are as ask at aw be because been before but by bye can can't cannot could
did didn't do does doesn't don't each either even ever every everything excuse for from get go going good goodbye got great had
has have he he's hello her here hey hi him his how however hmm huh i i'd i'll i'm i've if in is isn't it it's its just kind let
let's like look maybe me mine mm mhm more most much my never next no nope not nothing now of oh ok okay on once one only or other
our out over perfect please pm am really right same see she should so some something sorry still sure thank thanks that that's
the their them then there there's these they they're this those though through to today tomorrow tonight too uh um under until
up us very wait was we we'd we'll we're well were what what's when where which while who why will with won't would wow yeah yep
yes yesterday yet you you'd you'll you're your yours alright awesome actually anyway honestly great fine nice cool also
need needs talk tell call calling called book booked booking want wanted make take give come put try find help keep check
move change cancel schedule confirm say said ask asked think thought know knew mean meant hold bring sounds sound first last
monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october
november december morning afternoon evening noon midnight week weekend month year day days time times o'clock
dr doctor mr mrs ms miss sir madam mister dra doctora sr sra srta senor senora senorita
dog dogs cat cats puppy puppies kitten kittens rabbit rabbits bird birds reptile reptiles snake lizard turtle hamster guinea pig
ferret horse pet pets animal animals vet vets veterinarian clinic hospital office front desk emergency appointment appointments
visit visits exam check checkup check-up wellness vaccine vaccines vaccination shots sick new patient patients client owner
english spanish espanol ingles number phone text message call voicemail email address street road avenue
hola buenos buenas dias tardes noches gracias si no por favor de del la las el los un una unos unas y o pero que como cuando donde
quien cual cuales para con sin mi mis tu tus su sus nuestro nuestra es son esta estan estoy soy era fue ser estar tengo tiene
tenemos quiero quisiera necesito puede puedo podria me te se le lo les nos bueno claro vale perfecto disculpe perdon gracias
adios hasta luego ahora hoy manana ayer lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio
julio agosto septiembre setiembre octubre noviembre diciembre perro perros gato gatos mascota mascotas cita citas consulta
veterinario veterinaria clinica hospital numero telefono mensaje llamada correo calle avenida señor señora ok okey aja eh este
`.split(/\s+/).filter(Boolean).map((w) => fold(w)));

const UNITS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', cero: '0', one: '1', uno: '1', una: '1', two: '2', dos: '2', three: '3', tres: '3', four: '4', cuatro: '4',
  five: '5', cinco: '5', six: '6', seis: '6', seven: '7', siete: '7', eight: '8', ocho: '8', nine: '9', nueve: '9',
  ten: '10', diez: '10', eleven: '11', once: '11', twelve: '12', doce: '12', thirteen: '13', trece: '13', fourteen: '14', catorce: '14',
  fifteen: '15', quince: '15', sixteen: '16', dieciseis: '16', seventeen: '17', diecisiete: '17', eighteen: '18', dieciocho: '18',
  nineteen: '19', diecinueve: '19', twenty: '20', veinte: '20', thirty: '30', treinta: '30', forty: '40', cuarenta: '40', fifty: '50',
  cincuenta: '50', sixty: '60', sesenta: '60', seventy: '70', setenta: '70', eighty: '80', ochenta: '80', ninety: '90', noventa: '90',
  veintiuno: '21', veintidos: '22', veintitres: '23', veinticuatro: '24', veinticinco: '25', veintiseis: '26', veintisiete: '27',
  veintiocho: '28', veintinueve: '29', hundred: '00', cien: '00', ciento: '00', thousand: '000', mil: '000', double: '', triple: '',
};
const NUMBER_WORD = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
const NUMBER_TOKEN = `(?:\\d+|(?:${NUMBER_WORD}|dieciséis|veintidós|veintitrés|veintiséis))`;
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const NUMBER_RUN = new RegExp(`${B}${NUMBER_TOKEN}(?:[\\s,.()/-]+${NUMBER_TOKEN})*${E}`, 'giu');
const TIME_AFTER = /^\s*(?:a\.?m\.?|p\.?m\.?|o'clock|de la (?:mañana|manana|tarde|noche))(?![\p{L}])/iu;
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
// not "way", "drive" or "place": "20 minutes by the way" is no address (the number and capitalised passes still catch the parts)
const STREET = 'street|st\\.?|avenue|ave\\.?|road|rd\\.?|boulevard|blvd\\.?|lane|ln\\.?|parkway|pkwy\\.?|highway|hwy\\.?';
const TITLE = /^(?:dr\.?|doctor|dra\.?|doctora|mr\.?|mrs\.?|ms\.?)$/i;

/** Lower case, no accents: how words are compared. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A name as a pattern: any spacing between its words, and each accented letter also without its accent. */
const namePattern = (name: string) => name.trim().split(/\s+/).map((w) => [...w].map((c) => (fold(c) !== c.toLowerCase() ? `[${escape(c)}${escape(fold(c))}]` : escape(c))).join('')).join('\\s+');
/** The digits a run stands for, spoken or written ("seven two oh" is 720, "double five" is 55). */
function digitsOf(run: string): string {
  let out = '';
  let repeat = 1;
  for (const token of run.toLowerCase().split(/[\s,.()/-]+/).filter(Boolean)) {
    const t = fold(token).replace(/[^\p{L}\p{N}]/gu, '');
    if (t === 'double' || t === 'triple') { repeat = t === 'double' ? 2 : 3; continue; }
    const d = /^\d+$/.test(t) ? t : (UNITS[t] ?? '');
    out += d.repeat(repeat);
    repeat = 1;
  }
  return out;
}

export class Anonymiser {
  private readonly held: string[] = [];
  private readonly words = new Map<string, string>();
  /** The real words of the known names, as written, for their patterns. */
  private readonly wordsSeen: string[] = [];
  private readonly numbers = new Map<string, string>();
  private readonly keep: Set<string>;
  private readonly known: { re: RegExp; to: string }[] = [];
  private others = 0;

  constructor(known: KnownEntities = emptyKnown()) {
    this.keep = new Set(known.keep.flatMap((k) => k.split(/[\s/-]+/)).map(fold).filter(Boolean));
    for (const n of known.numbers) if (digitsOf(n).length >= 7) this.numberFor(n);
    const pairs: { from: string; to: string }[] = [];
    const person = (name: string, target: readonly [string, string]) => {
      const words = name.trim().split(/\s+/);
      const t = words.length > 1 && TITLE.test(words[0]!) ? words.shift()! : '';
      if (!words.length) return;
      words.forEach((w, i) => this.word(w, i === words.length - 1 && words.length > 1 ? target[1] : target[0]));
      pairs.push({ from: name, to: [t, ...words.map((w) => this.words.get(fold(w))!)].filter(Boolean).join(' ') });
      if (t) pairs.push({ from: words.join(' '), to: words.map((w) => this.words.get(fold(w))!).join(' ') });
    };
    known.clinic.forEach((c, i) => {
      pairs.push({ from: c, to: CLINICS[i % CLINICS.length]! });
      for (const w of c.split(/\s+/)) if (!COMMON.has(fold(w)) && !this.keep.has(fold(w))) this.word(w, 'Riverbend');
    });
    known.assistant.forEach((a) => pairs.push({ from: a, to: this.word(a, 'Juniper') }));
    known.vets.forEach((v, i) => person(v, VETS[i % VETS.length]!));
    known.owners.forEach((o, i) => person(o, OWNERS[i % OWNERS.length]!));
    known.pets.forEach((p, i) => person(p, [PETS[i % PETS.length]!, PETS[i % PETS.length]!]));
    known.addresses.forEach((a) => pairs.push({ from: a, to: ADDRESS }));
    // every word of a known name on its own, as well as the whole name, the longest first
    for (const from of this.wordsSeen) pairs.push({ from, to: this.words.get(fold(from))! });
    const seen = new Set<string>();
    for (const p of pairs.filter((p) => p.from.trim().length > 1).sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from))) {
      const key = fold(p.from.trim());
      if (seen.has(key)) continue;
      seen.add(key);
      this.known.push({ re: new RegExp(`${B}${namePattern(p.from)}${E}`, 'giu'), to: p.to });
    }
  }

  /** The made-up number for a real one: the same last nine digits always give the same 303-555-01xx. */
  numberFor(raw: string): string {
    const digits = digitsOf(raw);
    const key = digits.length >= 7 ? digits.slice(-9) : digits;
    let made = this.numbers.get(key);
    if (!made) {
      made = `303-555-01${String(this.numbers.size % 100).padStart(2, '0')}`;
      this.numbers.set(key, made);
    }
    return made;
  }

  /** One line of a call, made up. */
  text(input: string): string {
    let s = input.replace(/[-]/g, ' ');
    // emails, written and spoken
    s = s.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, () => this.hold(EMAIL));
    s = s.replace(new RegExp(`${B}[\\p{L}\\p{N}._-]+(?:\\s+(?:dot|punto)\\s+[\\p{L}\\p{N}_-]+)*\\s+(?:at|arroba)\\s+[\\p{L}\\p{N}_-]+(?:\\s+(?:dot|punto)\\s+[\\p{L}\\p{N}_-]+)+${E}`, 'giu'), () => this.hold(SPOKEN_EMAIL));
    // street addresses: a number then up to four words then the kind of street; a calle with its number; a flat or suite
    s = s.replace(new RegExp(`${B}(?:\\d+(?:[\\s-]+${NUMBER_TOKEN})*|${NUMBER_TOKEN}(?:[\\s-]+${NUMBER_TOKEN})+)(?:\\s+[\\p{L}.'-]+){0,4}?\\s+(?:${STREET})(?![\\p{L}])`, 'giu'), () => this.hold(ADDRESS));
    s = s.replace(new RegExp(`${B}(?:calle|avenida|avda\\.?|av\\.|camino|carrera|paseo)(?:\\s+[\\p{L}.'-]+){1,4}?(?:\\s*(?:n[oº°]\\.?|#)?\\s*\\d+)?${E}`, 'giu'), () => this.hold('Calle Mayor'));
    s = s.replace(new RegExp(`${B}(?:apt\\.?|apartment|suite|unit|apartamento|depto\\.?)\\s*#?\\s*[\\p{L}\\p{N}-]+|#\\s*[\\p{L}\\p{N}-]+`, 'giu'), () => this.hold('Apt 1'));
    // dates with a year (a date of birth): one fixed date
    s = s.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, () => this.hold('2020-01-01'));
    s = s.replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, () => this.hold('01/01/2020'));
    s = s.replace(new RegExp(`${B}(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}${E}`, 'giu'), () => this.hold('January 1, 2020'));
    s = s.replace(new RegExp(`${B}\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+|de\\s+)?(?:${MONTHS}),?\\s+(?:de(?:l)?\\s+)?\\d{4}${E}`, 'giu'), () => this.hold('1 January 2020'));
    // the known entities, the whole names before their words
    for (const k of this.known) s = s.replace(k.re, () => this.hold(k.to));
    // a run of three or more digits, written or spoken; a short time ("four forty pm") stays
    s = s.replace(NUMBER_RUN, (run: string, offset: number, all: string) => {
      const digits = digitsOf(run);
      if (digits.length < 3) return run;
      if (digits.length <= 4 && TIME_AFTER.test(all.slice(offset + run.length))) return run;
      return this.hold(this.numberFor(run));
    });
    // any other capitalised word that is not a common word: the next made-up name
    s = s.replace(/(?<![\p{L}\p{N}'’-])\p{Lu}[\p{L}\p{M}'’-]*/gu, (w: string) => {
      const bare = w.replace(/['’]s$/i, '');
      const head = fold(bare.split(/['’]/)[0]!);
      if (COMMON.has(fold(bare)) || COMMON.has(head) || this.keep.has(fold(bare)) || this.keep.has(head)) return w;
      return this.hold(this.word(bare, null)) + w.slice(bare.length);
    });
    // fail closed: a chunk that is not words, a short number, a time or punctuation is replaced
    s = s.split(/(\s+)/).map((chunk) => {
      if (!chunk.trim()) return chunk;
      const rest = chunk.replace(/[a-z]+/g, '');
      if (/^[\p{L}\p{M}'’.,!?;:"“”()¿¡…–—-]*$/u.test(rest)) return chunk;
      if (/^[(¿¡"“]*\d{1,2}(?::\d{2})?(?:st|nd|rd|th|º|°|ª|a\.?m\.?|p\.?m\.?)?[.,!?;:)"”…-]*$/iu.test(rest)) return chunk;
      return REDACTED;
    }).join('');
    return s.replace(/([a-z]+)/g, (_, code: string) => this.held[decode(code)] ?? REDACTED);
  }

  private hold(value: string): string {
    this.held.push(value);
    return `${encode(this.held.length - 1)}`;
  }

  /** The made-up word for a real one, the same every time; a new one takes `to`, or the next made-up name. */
  private word(real: string, to: string | null): string {
    const key = fold(real);
    let made = this.words.get(key);
    if (!made) {
      made = to ?? `${OTHERS[this.others % OTHERS.length]}${this.others >= OTHERS.length ? ` ${OTHERS[Math.floor(this.others / OTHERS.length) % OTHERS.length]}` : ''}`;
      if (!to) this.others++;
      this.words.set(key, made);
      this.wordsSeen.push(real);
    }
    return made;
  }
}

// a held value's index as letters that are no word and no number: q, x, z
const encode = (n: number) => n.toString(3).replace(/[012]/g, (d) => 'qxz'[Number(d)]!);
const decode = (code: string) => parseInt(code.replace(/[qxz]/g, (c) => String('qxz'.indexOf(c))), 3);
