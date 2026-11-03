// SPDX-License-Identifier: AGPL-3.0-only
import { B, E, type Language, LANGUAGES, normalise, PACKS } from './locales';

/**
 * The emergency guardrail. It runs on every caller transcript fragment, before and
 * independently of the model, and a clinic cannot turn it off.
 *
 * It is deliberately a phrase list, not a classifier. A missed emergency is the one
 * failure this product cannot have, so the list errs toward false positives: telling
 * a caller with a mild cough to call 911 costs a moment of confusion, missing chest
 * pain costs far more. The patterns live in the language packs, are reviewed by each
 * clinic and in the pull request that changes them (docs/safety.md), and every one has a test.
 *
 * Every pack's phrases are checked on every call, whatever languages the clinic has
 * switched on: a caller does not choose their language by the clinic's settings.
 */

export type EmergencyKind = 'cardiac' | 'breathing' | 'stroke' | 'bleeding' | 'unresponsive' | 'self_harm' | 'overdose' | 'allergic' | 'general' | PetEmergencyKind;

/** An animal in danger, from the veterinary pack. The person on the phone is not the patient. */
export type PetEmergencyKind = 'pet_toxin' | 'pet_breathing' | 'pet_trauma' | 'pet_collapse' | 'pet_bloat' | 'pet_urinary' | 'pet_heat' | 'pet_birth';
export const isPetEmergency = (kind: string): kind is PetEmergencyKind => kind.startsWith('pet_');

/** Extra phrase lists an industry pack adds, per language. They are checked before the language's own. */
export type EmergencyPhrases = Partial<Record<Language, [EmergencyKind, RegExp][]>>;

/** `at`: where the phrase starts in the normalised text, so the words before it can say who it is about. */
export interface EmergencyMatch { kind: EmergencyKind; phrase: string; language: Language; at?: number }

/**
 * Checks the recent caller text. Pass a rolling window, not just the latest delta:
 * transcripts arrive in fragments, and "chest" and "pain" can land in different ones.
 */
export function detectEmergency(recentCallerText: string, extra: EmergencyPhrases = {}): EmergencyMatch | null {
  return detectEmergencies(recentCallerText, extra)[0] ?? null;
}

/** Every kind present in the text, most specific first, so a second emergency in the same window is not hidden by the first. */
export function detectEmergencies(recentCallerText: string, extra: EmergencyPhrases = {}): EmergencyMatch[] {
  const text = normalise(recentCallerText);
  const found: EmergencyMatch[] = [];
  const seen = new Set<EmergencyKind>();
  for (const language of LANGUAGES) {
    const pack = PACKS[language];
    for (const [kind, re] of [...(extra[language] ?? []), ...pack.emergencyPhrases]) {
      if (seen.has(kind)) continue;
      const m = text.match(re);
      if (!m) continue;
      // "it's not an emergency" is the one negation we honour, and only for the
      // generic word: "no chest pain" style negations are too easy to mishear
      if (kind === 'general' && LANGUAGES.some((l) => PACKS[l].notAnEmergency.test(text))) continue;
      seen.add(kind);
      found.push({ kind, phrase: m[0], language, at: m.index ?? text.indexOf(m[0]) });
    }
  }
  // the generic word last, so a specific kind leads
  return [...found.filter((f) => f.kind !== 'general'), ...found.filter((f) => f.kind === 'general')];
}

/**
 * The words that say who an emergency is about, per language, from an industry pack whose patient is not the caller.
 * `firstPerson`: the caller themselves, right before the phrase ("I'm having", "my"); `firstPersonPhrase`: the phrase says
 * it itself ("pain in my arm", "no puedo respirar"); `person`: someone else by who they are ("my husband", "su hija");
 * `pet`: an animal ("my dog", "la gata"). The last one named before the phrase is who a "he" or "she" means.
 */
export interface SubjectWords { firstPerson: RegExp; firstPersonPhrase: RegExp; person: RegExp; pet: RegExp }

/** The animal's kind of emergency for a person's red flag said about a pet: "my dog's throat is swelling" is the pet's airway. */
export const PET_KIND_OF: Partial<Record<EmergencyKind, PetEmergencyKind>> = {
  cardiac: 'pet_collapse', breathing: 'pet_breathing', stroke: 'pet_collapse', bleeding: 'pet_trauma', unresponsive: 'pet_collapse', overdose: 'pet_toxin', allergic: 'pet_breathing',
};

const lastAt = (text: string, re: RegExp) => {
  let last = -1;
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) last = m.index + m[0].length;
  return last;
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Who a red flag is about, from the words just before it: 'person' when the caller speaks of themselves ("I can't
 * breathe", "my chest hurts") or the last one named is a person ("my husband... he can't breathe"); 'pet' when the last
 * one named is an animal or one of the pets on the call by name ("my dog's throat", "Luna's throat"). Null when nothing
 * says. `text` is normalised.
 */
export function subjectOf(text: string, match: Pick<EmergencyMatch, 'phrase' | 'at'>, words: Partial<Record<Language, SubjectWords>>, petNames: readonly string[] = []): 'person' | 'pet' | null {
  const at = match.at ?? text.indexOf(match.phrase);
  const before = text.slice(Math.max(0, at - 160), Math.max(0, at));
  const all = Object.values(words);
  if (all.some((w) => w.firstPersonPhrase.test(match.phrase) || w.firstPerson.test(before))) return 'person';
  const person = Math.max(-1, ...all.map((w) => lastAt(before, w.person)));
  const names = petNames.map((n) => normalise(n).trim()).filter((n) => n.length > 1);
  const pet = Math.max(-1, ...all.map((w) => lastAt(before, w.pet)), ...names.map((n) => lastAt(before, new RegExp(`${B}${escape(n)}${E}`, 'u'))));
  if (person < 0 && pet < 0) return null;
  return pet > person ? 'pet' : 'person';
}

/**
 * At a clinic for animals, a red flag from the person list (throat swelling, can't breathe) is a person in danger only
 * when a person is its subject: the same words about a pet, or with nobody named, are the animal's emergency, whose
 * script also tells a person in danger to call the emergency number (a tester clinic, 2026-11-03: "my dog Luna's throat is
 * swelling" got the 911 line). An animal's phrase the caller says of themselves ("I can't breathe") is dropped: the
 * person list answers it. Self-harm and the bare word are left as they are.
 */
export function bySubject(matches: EmergencyMatch[], text: string, words: Partial<Record<Language, SubjectWords>>, petNames: readonly string[] = []): EmergencyMatch[] {
  const said = normalise(text);
  const out: EmergencyMatch[] = [];
  for (const m of matches) {
    if (m.kind === 'general' || m.kind === 'self_harm') { out.push(m); continue; }
    const subject = subjectOf(said, m, words, petNames);
    if (isPetEmergency(m.kind)) { if (subject !== 'person') out.push(m); continue; }
    out.push(subject === 'person' ? m : { ...m, kind: PET_KIND_OF[m.kind] ?? 'pet_collapse' });
  }
  // one match per kind, the first kept
  return out.filter((m, i) => out.findIndex((o) => o.kind === m.kind) === i);
}

/** Kinds serious enough to ring the on-call line (when the clinic enabled it). The word "emergency" alone is not. */
export const TRANSFER_KINDS = new Set<EmergencyKind>(['cardiac', 'breathing', 'stroke', 'bleeding', 'unresponsive', 'self_harm', 'overdose', 'allergic',
  'pet_toxin', 'pet_breathing', 'pet_trauma', 'pet_collapse', 'pet_bloat', 'pet_urinary', 'pet_heat', 'pet_birth']);

/**
 * Fixed text, owned by the clinic and reviewed at onboarding. Sent as a session
 * instruction, so the model says it in its own voice but may not soften or replace it.
 * These are the English, United States versions; calls use the language pack's.
 */
export const EMERGENCY_INSTRUCTION = PACKS.en.emergencyScript('911');
export const SELF_HARM_INSTRUCTION = PACKS.en.selfHarmScript('911', '988');
