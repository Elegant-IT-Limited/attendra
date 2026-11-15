import { describe, expect, it } from 'vitest';
import { greetingFollowingNames, PACKS, renameInGreeting, staleGreetingNames } from '../src';

const suggested = (l: 'en' | 'es', clinicName: string, assistantName: string | null) => PACKS[l].greeting({ clinicName, assistantName });

describe('a greeting follows a rename (note 52 B3)', () => {
  it('replaces the old clinic and assistant names wherever the greeting says them, as whole names only', () => {
    const before = "Thanks for calling Riverside Vets. I'm Ana, the clinic's AI assistant. Riverside Vets is open late on Thursdays. How can I help you today?";
    expect(greetingFollowingNames(before, { clinicName: 'Riverside Vets', assistantName: 'Ana' }, { clinicName: 'Lakeview Vets', assistantName: 'Maya' }))
      .toBe("Thanks for calling Lakeview Vets. I'm Maya, the clinic's AI assistant. Lakeview Vets is open late on Thursdays. How can I help you today?");
    // a name inside a longer word is not the name
    expect(renameInGreeting('Bananas at the AI assistant desk of Ana.', 'Ana', 'Maya')).toBe('Bananas at the AI assistant desk of Maya.');
    // nothing to follow: the greeting does not say the old name, or the name did not change, or the new one is empty
    expect(renameInGreeting("Hello, you've reached the AI assistant.", 'Ana', 'Maya')).toBeNull();
    expect(renameInGreeting(before, 'Ana', 'Ana')).toBeNull();
    expect(renameInGreeting(before, 'Ana', ' ')).toBeNull();
  });

  it('the suggested greeting in each language follows both names', () => {
    for (const l of ['en', 'es'] as const) {
      expect(greetingFollowingNames(suggested(l, 'Riverside Vets', 'Ana'), { clinicName: 'Riverside Vets', assistantName: 'Ana' }, { clinicName: 'Lakeview Vets', assistantName: 'Maya' }))
        .toBe(suggested(l, 'Lakeview Vets', 'Maya'));
    }
  });

  it('names a greeting that still says an old name, read where the suggested greeting puts it', () => {
    // the test clinic's case: clinic and assistant renamed, greeting left as it was
    const old = suggested('en', 'Riverside Vets', 'Ana');
    expect(staleGreetingNames(old, 'en', { clinicName: 'Lakeview Vets', assistantName: 'Maya' })).toEqual([
      { kind: 'clinic', said: 'Riverside Vets', now: 'Lakeview Vets' },
      { kind: 'assistant', said: 'Ana', now: 'Maya' },
    ]);
    expect(staleGreetingNames(suggested('es', 'Riverside Vets', 'Ana'), 'es', { clinicName: 'Riverside Vets', assistantName: 'Maya' }))
      .toEqual([{ kind: 'assistant', said: 'Ana', now: 'Maya' }]);
    // the names it should say: nothing to point at, in any letter case
    expect(staleGreetingNames(old, 'en', { clinicName: 'riverside vets', assistantName: 'ANA' })).toEqual([]);
    // the assistant's own name taken away: the greeting still says it, and the fix is the suggested greeting
    expect(staleGreetingNames(old, 'en', { clinicName: 'Riverside Vets', assistantName: null })).toEqual([{ kind: 'assistant', said: 'Ana', now: null }]);
    // the suggested greeting with no assistant name, and a greeting in the clinic's own words: nothing to read
    expect(staleGreetingNames(suggested('en', 'Riverside Vets', null), 'en', { clinicName: 'Riverside Vets', assistantName: null })).toEqual([]);
    expect(staleGreetingNames("Hi! You've reached our AI assistant at the front desk.", 'en', { clinicName: 'Lakeview Vets', assistantName: 'Maya' })).toEqual([]);
  });

  // 2026-11-16: a test clinic renamed to "Maple Vet Clinic" was told its greeting "still says" it, when the name was
  // followed by a comma, in English and in Spanish
  it('a greeting that says the clinic\'s name now is never pointed at, whatever follows the name: a comma, a full stop or the end of the line', () => {
    const now = { clinicName: 'Maple Vet Clinic', assistantName: 'Juniper' };
    const greetings: Record<'en' | 'es', string[]> = {
      en: [
        "Thanks for calling Maple Vet Clinic, Denver. I'm Juniper, the clinic's AI assistant. How can I help you today?",
        "Thanks for calling Maple Vet Clinic, where pets come first! I'm Juniper, the clinic's AI assistant.",
        "Thanks for calling Maple Vet Clinic, I'm Juniper, the clinic's AI assistant. How can I help you today?",
        "Thanks for calling Maple Vet Clinic. I'm Juniper, the clinic's AI assistant. How can I help you today?",
        "Thanks for calling Maple Vet Clinic\nI'm Juniper, the clinic's AI assistant. How can I help you today?",
      ],
      es: [
        'Gracias por llamar a Maple Vet Clinic, en Denver. Soy Juniper, la asistente virtual con inteligencia artificial de la clínica.',
        'Gracias por llamar a Maple Vet Clinic, soy Juniper, la asistente virtual con inteligencia artificial de la clínica.',
        'Gracias por llamar a Maple Vet Clinic. Soy Juniper, la asistente virtual con inteligencia artificial de la clínica.',
        'Gracias por llamar a Maple Vet Clinic\nSoy Juniper, la asistente virtual con inteligencia artificial de la clínica.',
      ],
    };
    for (const l of ['en', 'es'] as const) for (const g of greetings[l]) expect(staleGreetingNames(g, l, now), g).toEqual([]);
    // the same greetings written for the old name are still pointed at, with the name alone when a comma or a line end follows it
    const old = { clinicName: 'Oak Hill Vets', assistantName: 'Juniper' };
    expect(staleGreetingNames(greetings.en[2]!, 'en', old)).toEqual([{ kind: 'clinic', said: 'Maple Vet Clinic', now: 'Oak Hill Vets' }]);
    expect(staleGreetingNames(greetings.en[3]!, 'en', old)).toEqual([{ kind: 'clinic', said: 'Maple Vet Clinic', now: 'Oak Hill Vets' }]);
    expect(staleGreetingNames(greetings.en[4]!, 'en', old)).toEqual([{ kind: 'clinic', said: 'Maple Vet Clinic', now: 'Oak Hill Vets' }]);
    expect(staleGreetingNames(greetings.es[1]!, 'es', old)).toEqual([{ kind: 'clinic', said: 'Maple Vet Clinic', now: 'Oak Hill Vets' }]);
    expect(staleGreetingNames(greetings.es[2]!, 'es', old)).toEqual([{ kind: 'clinic', said: 'Maple Vet Clinic', now: 'Oak Hill Vets' }]);
    expect(staleGreetingNames(greetings.es[3]!, 'es', old)).toEqual([{ kind: 'clinic', said: 'Maple Vet Clinic', now: 'Oak Hill Vets' }]);
    // a name that only starts like the clinic's is still another name
    expect(staleGreetingNames("Thanks for calling Maple Vet Clinic East. I'm Juniper, the clinic's AI assistant.", 'en', now))
      .toEqual([{ kind: 'clinic', said: 'Maple Vet Clinic East', now: 'Maple Vet Clinic' }]);
  });
});
