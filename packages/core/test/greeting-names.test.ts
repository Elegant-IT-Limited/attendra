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
});
