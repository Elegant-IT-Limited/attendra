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
});
