// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isClearYes } from '../src';

// YES-ANY-LANG (owner decision, 26 Nov): a plain yes in English or Spanish is a yes at every clinic, whatever languages it
// offers. The corpus found it: 201-vet-es-pets-on-number-books at a clinic set to English only ended no_clear_yes on "Sí".
describe('YES-ANY-LANG: a plain yes in either language counts at every clinic', () => {
  it('YES-ANY-LANG: Spanish yeses at an English-only clinic, English yeses at a Spanish-only one', () => {
    for (const s of ['Sí.', 'si', 'Claro.', 'Vale.', 'De acuerdo.', 'Ok.', 'Dale.', 'Está bien.', 'Por supuesto.', 'Eso es.'])
      expect(isClearYes(s, ['en']), s).toBe(true);
    for (const s of ['Yes.', 'Yeah, sure.', 'Okay.', 'Sounds good.']) expect(isClearYes(s, ['es']), s).toBe(true);
  });

  it('YES-ANY-LANG: a hedge or a no still blocks it, in both languages, at every clinic', () => {
    for (const s of ['Sí, pero espere.', 'No.', 'Sí... ¿a qué hora?', 'Yes, actually no.', 'Claro, aunque mejor el jueves.']) {
      expect(isClearYes(s, ['en']), s).toBe(false);
      expect(isClearYes(s, ['es']), s).toBe(false);
    }
  });

  it('YES-ANY-LANG-review: "Eso es todo, gracias", "that\'s all", "that\'s it, thanks" are a goodbye, never a yes', () => {
    for (const s of ['Eso es todo, gracias.', 'Eso es todo.', 'Es todo.', 'Eso sería todo.', "That's all.", "That's it, thanks.", "That's all, thank you."]) {
      expect(isClearYes(s, ['en']), s).toBe(false);
      expect(isClearYes(s, ['es']), s).toBe(false);
    }
    // "eso es" said as the whole answer is still a yes
    expect(isClearYes('Eso es.', ['en'])).toBe(true);
    expect(isClearYes('Eso es.', ['es'])).toBe(true);
  });
});
