// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, DEFAULT_ANIMALS } from './clinic';
import type { Industry } from './industries/types';
import { PACKS } from './locales';

/** What a new account says about itself at sign-up; everything else starts from the pack's defaults. */
export interface StarterInput {
  id: string;
  name: string;
  timezone: string;
  industry: Industry;
  /** The clinic's own main number, E.164. It sets the country (emergency number, phone formats) until a number reaches Attendra. */
  phone: string;
  /** The country chosen at sign-up (ISO code), for the emergency number; absent, the phone's country. */
  country?: string | undefined;
}

const WEEKDAYS = { open: '08:00', close: '18:00' };

/**
 * A new clinic's first settings: weekday hours, one provider to book with until the
 * team adds its own, and the pack's usual visit types. No FAQ and no documents, so the
 * assistant answers nothing it was not told. Valid as it stands, so a test call works
 * before the setup is finished.
 */
export function starterClinic(input: StarterInput): ClinicConfig {
  const vet = input.industry === 'vet';
  const visitTypes = vet
    ? [
      // the starter set for a vet clinic: what most callers ask for, in the minutes most clinics give them
      { id: 'vt_wellness', name: 'check-up', names: { es: 'chequeo' }, minutes: 20, description: 'A full check-up for a pet already seen here.', audience: 'existing' as const },
      { id: 'vt_sick', name: 'sick visit', names: { es: 'consulta por enfermedad' }, minutes: 30 },
      { id: 'vt_vaccines', name: 'vaccines', names: { es: 'vacunas' }, minutes: 15 },
      { id: 'vt_new', name: 'new patient visit', names: { es: 'primera consulta' }, minutes: 40, description: 'A first full check-up for a pet new to the clinic.', audience: 'new' as const },
    ]
    : [
      { id: 'vt_new', name: 'new patient visit', names: { es: 'primera consulta' }, minutes: 40, audience: 'new' as const },
      { id: 'vt_follow_up', name: 'follow-up visit', names: { es: 'consulta de seguimiento' }, minutes: 20, audience: 'existing' as const },
      { id: 'vt_sick', name: 'sick visit', names: { es: 'consulta por enfermedad' }, minutes: 20 },
    ];
  return ClinicConfig.parse({
    id: input.id,
    name: input.name,
    industry: input.industry,
    timezone: input.timezone,
    phoneNumbers: [input.phone],
    ...(input.country ? { country: input.country } : {}),
    hours: { '1': [WEEKDAYS], '2': [WEEKDAYS], '3': [WEEKDAYS], '4': [WEEKDAYS], '5': [WEEKDAYS] },
    greeting: PACKS.en.greeting({ assistantName: null, clinicName: input.name }),
    languages: ['en'],
    primaryLanguage: 'en',
    providers: [{ id: 'prov_1', name: vet ? 'our veterinarian' : 'our doctor', visitTypeIds: visitTypes.map((v) => v.id), placeholder: true }],
    visitTypes,
    // a vet clinic books in the morning what came in overnight, after a person has looked at it
    afterHours: vet ? 'requests' : 'book',
    // the animals its vets see, as a list from the start: a picker in setup offers only what is on the list
    ...(vet ? { lists: { categories: [...DEFAULT_ANIMALS] } } : {}),
  });
}
