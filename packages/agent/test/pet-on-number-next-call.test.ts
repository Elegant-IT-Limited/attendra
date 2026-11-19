// SPDX-License-Identifier: AGPL-3.0-only
import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// Call quality R1 (2026-11-19): a pet the assistant registered on one call was asked for again on the next call from the
// same number. "Is this for Rocky or a new pet?" (Vapi writes it with no comma), answered "Yeah. Rocky.", was read as
// "new", and verify_caller refused with pet_is_new.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
// a made-up number with no pets on it before the first call
const PHONE = '+17205550188';

describe('a pet registered on one call', () => {
  for (const lang of ['en', 'es'] as const) {
    it(`is found on the next call from the same number, when the caller answers the pick question with a yes and its name (${lang})`, async () => {
      const first = await w.call(PHONE, { clinic });
      first.caller(lang === 'es' ? 'Hola, acabo de adoptar un cachorro nuevo, se llama Rocky. Soy Johnny.' : 'Hi, I just adopted a new puppy called Rocky. I am Johnny.');
      const reg = await first.delegate([{ tool: 'register_patient', args: { pet_name: 'Rocky', owner_name: 'Johnny', species: 'dog', sex: 'male', birthday_or_age: '3 months', phone: null } }]);
      expect(reg.errors).toEqual([null]);

      const next = await w.call(PHONE, { clinic });
      next.caller(lang === 'es' ? 'Hola, quiero una cita.' : 'Hi, I want to book a visit.');
      const pick = await next.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone: null } }]);
      expect(pick.results[0]!.data).toMatchObject({ pets_on_number: ['Rocky'] });
      // the line as Vapi wrote it: no comma before "or a new pet"
      next.assistant(lang === 'es' ? 'Gracias, Johnny. ¿Es para Rocky o para una mascota nueva?' : 'Thanks, Johnny. Is this for Rocky or a new pet?');
      next.caller(lang === 'es' ? 'Sí. Rocky.' : 'Yeah. Rocky.');
      const found = await next.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Rocky', phone: null } }]);
      expect(found.errors).toEqual([null]);
      expect(next.state.verifiedPatient?.firstName).toBe('Rocky');
    });
  }
});
