import { describe, expect, it } from 'vitest';
import { detectEmergency, isClearYes, namesMatch, parseDob } from '../src';

describe('emergency guardrail', () => {
  it.each([
    ['I have really bad chest pain', 'cardiac'],
    ['my husband can’t breathe', 'breathing'],
    ['her face is drooping and her speech is slurred', 'stroke'],
    ["it won't stop bleeding", 'bleeding'],
    ['he passed out and is not waking up', 'unresponsive'],
    ["honestly I don't want to be alive anymore", 'self_harm'],
    ["I don't really want to be here anymore", 'self_harm'],
    ['I think I took too many of my pills', 'overdose'],
    ['my throat is swelling', 'allergic'],
    ['this is an emergency', 'general'],
  ])('catches "%s" as %s', (text, kind) => {
    expect(detectEmergency(text)?.kind).toBe(kind);
  });

  it('catches a phrase split across transcript fragments once the window is joined', () => {
    expect(detectEmergency(['I have some', 'chest', 'pain since this morning'].join(' '))?.kind).toBe('cardiac');
  });

  it('stays quiet on ordinary requests', () => {
    for (const t of ['I need to book my annual physical', 'can I get a refill of my lisinopril', 'what time do you close on Friday']) {
      expect(detectEmergency(t)).toBeNull();
    }
  });
});

describe('identity inputs', () => {
  it.each([
    ['March 4th 1985', '1985-03-04'], ['4 March 1985', '1985-03-04'], ['03/04/1985', '1985-03-04'], ['1985-03-04', '1985-03-04'], ['sept 9, 1962', '1962-09-09'],
  ])('reads "%s" as %s', (spoken, iso) => {
    expect(parseDob(spoken, new Date('2026-09-28'))).toBe(iso);
  });

  it('refuses dates it would have to guess', () => {
    for (const s of ['March 85', '02/30/1990', 'next year', '01/01/2099']) expect(parseDob(s, new Date('2026-09-28'))).toBeNull();
  });

  it('matches first and last name, ignoring accents and middle names', () => {
    expect(namesMatch('jose luis garcia', 'José García')).toBe(true);
    expect(namesMatch('Maria Garcia', 'Marisol Garcia')).toBe(false);
    expect(namesMatch('Garcia', 'José García')).toBe(false);
  });
});

describe('confirmation', () => {
  it('takes a plain yes', () => {
    for (const t of ['yes', 'Yeah that works, book it', "that's perfect"]) expect(isClearYes(t, ['en'])).toBe(true);
  });

  it('does not take a hedge, a question or a change of mind as yes', () => {
    for (const t of ['yes, actually no', 'hmm, maybe', 'yes? wait, Thursday or Friday', 'not that one', '']) expect(isClearYes(t, ['en'])).toBe(false);
  });
});
