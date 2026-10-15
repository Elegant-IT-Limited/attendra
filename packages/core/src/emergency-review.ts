// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from './clinic';
import { industryPack } from './industries';
import type { EmergencyDestination } from './industries/types';
import { emergencyNumberFor, LANGUAGES, PACKS } from './locales';

/** One kind of emergency as a reviewer reads it: what it covers, and examples a caller might say. */
export interface ReviewItem { kind: string; title: string; examples: { en: string; es: string } }

// What the phrase lists catch, written for a person to read. The lists themselves are in
// the language packs and the industry packs; their tests are the exact record.
const PERSON: ReviewItem[] = [
  { kind: 'cardiac', title: 'Heart', examples: { en: 'chest pain, heart attack', es: 'me duele el pecho' } },
  { kind: 'breathing', title: 'Breathing', examples: { en: "can't breathe", es: 'no puedo respirar' } },
  { kind: 'stroke', title: 'Stroke', examples: { en: 'face drooping, slurred speech', es: 'no puede hablar bien, tiene la cara caída' } },
  { kind: 'bleeding', title: 'Bleeding', examples: { en: "won't stop bleeding", es: 'sangrando mucho' } },
  { kind: 'unresponsive', title: 'Unresponsive', examples: { en: 'passed out, not waking up', es: 'inconsciente' } },
  { kind: 'self_harm', title: 'Self-harm (always the crisis script first)', examples: { en: "don't want to be alive", es: 'quitarme la vida' } },
  { kind: 'overdose', title: 'Overdose or poison', examples: { en: 'took too many, took a whole bottle, swallowed bleach', es: 'se tomó todas las pastillas, veneno' } },
  { kind: 'allergic', title: 'Severe allergic reaction', examples: { en: 'throat is swelling', es: 'se me está cerrando la garganta' } },
];

const ANIMAL: ReviewItem[] = [
  { kind: 'pet_toxin', title: 'Toxins and swallowed objects', examples: { en: 'ate chocolate, got into the rat poison, licked antifreeze, ate grapes, swallowed a sock, ate xylitol gum', es: 'se comió chocolate, tomó anticongelante, se tragó un calcetín' } },
  { kind: 'pet_breathing', title: 'Breathing', examples: { en: "can't breathe, gums are blue, choking, open-mouth breathing", es: 'no puede respirar, encías azules' } },
  { kind: 'pet_trauma', title: 'Trauma and bleeding', examples: { en: "hit by a car, bleeding a lot, bitten by a snake, can't stand up", es: 'lo atropelló un carro, sangra mucho' } },
  { kind: 'pet_collapse', title: 'Collapse or seizure', examples: { en: 'collapsed, having a seizure, unresponsive, dying', es: 'está convulsionando, no reacciona' } },
  { kind: 'pet_bloat', title: 'Bloat', examples: { en: 'belly swollen and hard, retching, trying to throw up and nothing comes', es: 'panza hinchada, quiere vomitar y no puede' } },
  { kind: 'pet_urinary', title: 'Cannot urinate', examples: { en: "can't pee, straining to urinate, blocked cat", es: 'no puede orinar' } },
  { kind: 'pet_heat', title: 'Heatstroke', examples: { en: 'heatstroke, left in a hot car', es: 'golpe de calor' } },
  { kind: 'pet_birth', title: 'A difficult birth', examples: { en: 'in labour for hours, a puppy is stuck', es: 'cachorro atorado' } },
];

/** A short, stable fingerprint of text: FNV-1a, 32 bits, as 8 hex digits. Runs the same in the browser and on the server. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Which version of the lists a review covered: a fingerprint of every phrase pattern
 * the clinic's calls are checked against. When a release changes a list, the version
 * changes, and the clinic's review is shown as out of date until it is done again.
 */
export function emergencyListVersion(industry: string | undefined): string {
  const pack = industryPack(industry);
  const sources = [
    ...LANGUAGES.flatMap((l) => (pack.emergency?.phrases[l] ?? []).map(([k, re]) => `${l}:${k}:${re.source}`)),
    ...LANGUAGES.flatMap((l) => PACKS[l].emergencyPhrases.map(([k, re]) => `${l}:${k}:${re.source}`)),
  ];
  return fingerprint(sources.join('\n'));
}

/** The words in quotation marks in a script instruction: what the caller actually hears. */
const spoken = (instruction: string) => [...instruction.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).join(' ');

/**
 * What a clinic's veterinarian (or clinician) reviews before calls go live: every kind of
 * emergency the assistant acts on, examples of what callers say, and the exact words the
 * caller hears, with this clinic's emergency hospital and emergency number in them.
 */
export function emergencyReviewSheet(clinic: Pick<ClinicConfig, 'industry' | 'emergencyHospital' | 'emergencyNumber' | 'phoneNumbers'>) {
  const pack = industryPack(clinic.industry);
  const to: EmergencyDestination = { hospital: clinic.emergencyHospital ?? null, emergencyNumber: emergencyNumberFor(clinic) };
  const animal = !!pack.emergency;
  // the script spells the hospital's number out for the voice; the reviewer reads it as written
  const readable = (text: string, language: 'en' | 'es') => {
    const h = to.hospital;
    if (!h) return text;
    const shown = /^\+1\d{10}$/.test(h.phone) ? h.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') : h.phone;
    return text.replace(PACKS[language].speakPhone(h.phone), shown);
  };
  return {
    industry: pack.id,
    version: emergencyListVersion(clinic.industry),
    animal: animal ? ANIMAL : [],
    person: PERSON,
    says: {
      animal: animal ? { en: readable(spoken(pack.emergency!.script('en', to)), 'en'), es: readable(spoken(pack.emergency!.script('es', to)), 'es') } : null,
      person: { en: spoken(PACKS.en.emergencyScript(to.emergencyNumber)), es: spoken(PACKS.es.emergencyScript(to.emergencyNumber)) },
    },
    hospitalSet: !!clinic.emergencyHospital,
  };
}
export type EmergencyReviewSheet = ReturnType<typeof emergencyReviewSheet>;
