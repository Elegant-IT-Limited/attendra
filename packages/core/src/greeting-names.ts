// SPDX-License-Identifier: AGPL-3.0-only
import type { Language } from './locales/types';

/**
 * The clinic's and the assistant's names inside a greeting (note 52 B3). A test clinic renamed its assistant and its
 * clinic in Settings, and callers still heard the old names: the greeting is free text, saved on its own, and nothing
 * followed the rename. Setup already moves a greeting that is still the suggested one to a new name; Settings now
 * does the same for any greeting that says the old name, and points at a greeting that still says one.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A whole name, never part of a longer word: "Ana" is not inside "Banana", "Oak Hill" is found after a comma. */
const wholeName = (name: string) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escape(name.trim())}(?![\\p{L}\\p{M}\\p{N}])`, 'gu');

/** The greeting with every whole occurrence of one name replaced by another; null when it does not say the old one. */
export function renameInGreeting(greeting: string, before: string | null | undefined, after: string | null | undefined): string | null {
  const from = before?.trim();
  const to = after?.trim();
  if (!from || !to || from === to) return null;
  const re = wholeName(from);
  if (!re.test(greeting)) return null;
  return greeting.replace(wholeName(from), to);
}

export interface GreetingNames { clinicName: string; assistantName?: string | null }

/**
 * A greeting moved from the names it was written for to new ones, as Settings shows it before saving: the old clinic
 * name and the old assistant name replaced wherever the greeting says them. Unchanged when it says neither.
 */
export function greetingFollowingNames(greeting: string, before: GreetingNames, after: GreetingNames): string {
  let text = greeting;
  text = renameInGreeting(text, before.clinicName, after.clinicName) ?? text;
  text = renameInGreeting(text, before.assistantName, after.assistantName) ?? text;
  return text;
}

/**
 * Where the suggested greeting says the two names, per language: "Thanks for calling <clinic>. I'm <assistant>, the
 * clinic's AI assistant" and its Spanish twin. A greeting written in that shape tells which names it still says.
 */
const SHAPES: Record<Language, RegExp> = {
  en: /^\s*Thanks for calling (?<clinic>[^.!?]{1,100}?)[.!]\s+I'?m (?:(?<assistant>[\p{L}\p{M}'-]{2,24}),\s+the|the)\b/u,
  es: /^\s*Gracias por llamar a (?<clinic>[^.!?]{1,100}?)[.!]\s+Soy (?:(?<assistant>[\p{L}\p{M}'-]{2,24}),\s+la|la)\b/u,
};

export interface StaleName { kind: 'clinic' | 'assistant'; said: string; now: string | null }

/**
 * The names a greeting still says that are no longer the clinic's or the assistant's, read where the suggested
 * greeting puts them: "Your greeting still says 'Riverside'". A greeting in its own words names nothing here.
 * `now` is null for an assistant with no name of its own (the fix is then the suggested greeting).
 */
export function staleGreetingNames(greeting: string, language: Language, names: GreetingNames): StaleName[] {
  const m = SHAPES[language]?.exec(greeting);
  if (!m?.groups) return [];
  const same = (a: string, b: string) => a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'base' }) === 0;
  const out: StaleName[] = [];
  const clinic = m.groups.clinic?.trim();
  if (clinic && names.clinicName.trim() && !same(clinic, names.clinicName)) out.push({ kind: 'clinic', said: clinic, now: names.clinicName.trim() });
  const assistant = m.groups.assistant?.trim();
  const current = names.assistantName?.trim() || null;
  if (assistant && (!current || !same(assistant, current))) out.push({ kind: 'assistant', said: assistant, now: current });
  return out;
}
