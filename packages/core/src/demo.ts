// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig } from './clinic';

/**
 * The demo clinic. Fictional throughout: the name, the providers, the 555-01xx
 * numbers (reserved for fiction in North America) and every patient in the seed.
 */
/**
 * The demo clinic's holidays, US Thanksgiving (the fourth Thursday of November) and
 * Christmas, this year and next, so the demo never runs out of them.
 */
export function demoHolidays(year: number): string[] {
  const thanksgiving = (y: number) => {
    const first = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    return `${y}-11-${String(1 + ((4 - first + 7) % 7) + 21).padStart(2, '0')}`;
  };
  return [year, year + 1].flatMap((y) => [thanksgiving(y), `${y}-12-25`]);
}

export const DEMO_CLINIC = ClinicConfig.parse({
  id: 'clinic_demo_maple',
  name: 'Maple Street Family Medicine',
  timezone: 'America/Denver',
  phoneNumbers: ['+13035550100'],
  hours: {
    '1': [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }],
    '2': [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }],
    '3': [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }],
    '4': [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }],
    '5': [{ open: '08:00', close: '13:00' }],
  },
  holidays: demoHolidays(new Date().getUTCFullYear()),
  greeting: 'Thanks for calling Maple Street Family Medicine. I\'m Maya, the clinic\'s AI assistant. How can I help you today?',
  assistantName: 'Maya',
  languages: ['en', 'es'],
  primaryLanguage: 'en',
  providers: [
    { id: 'prov_okafor', name: 'Dr. Nkem Okafor', visitTypeIds: ['vt_sick', 'vt_annual', 'vt_new'] },
    { id: 'prov_lindqvist', name: 'Dr. Ann Lindqvist', visitTypeIds: ['vt_sick', 'vt_annual'],
      hours: { '2': [{ open: '09:00', close: '15:00' }], '4': [{ open: '09:00', close: '15:00' }] } },
  ],
  visitTypes: [
    { id: 'vt_sick', name: 'sick visit', names: { es: 'consulta por enfermedad' }, minutes: 20 },
    { id: 'vt_annual', name: 'annual physical', names: { es: 'examen físico anual' }, minutes: 40 },
    { id: 'vt_new', name: 'new patient visit', names: { es: 'primera consulta' }, minutes: 60 },
  ],
  routing: [
    { target: 'front_desk', uri: 'tel:+13035550101', when: 'open' },
    { target: 'billing', uri: 'tel:+13035550102', when: 'open' },
    { target: 'on_call', uri: 'tel:+13035550199', when: 'always' },
  ],
  faqs: [
    { id: 'faq_address', question: 'Where are you located? What is the address?', answer: 'We are at 214 Maple Street, Suite 3, Denver. Parking is free in the lot behind the building.' },
    { id: 'faq_insurance', question: 'Which insurance do you take? Do you accept my insurance?', answer: 'We accept most plans, including Aetna, Cigna, UnitedHealthcare, Anthem Blue Cross and Medicare. Please bring your card to the visit.' },
    { id: 'faq_fasting', question: 'Do I need to fast before my physical or blood work?', answer: 'For an annual physical with blood work, please do not eat for 8 hours before. Water and your usual medications are fine.' },
    { id: 'faq_portal', question: 'How do I get my test results or use the patient portal?', answer: 'Results are posted to the patient portal. The front desk can send you a portal invite by text.' },
  ],
  emergencyTransferEnabled: true,
});

const WEEKDAY = [{ open: '08:00', close: '17:00' }];

/**
 * The second demo clinic: a small practice in another organization, with its own
 * login. It is there to show that clinics on one Attendra never see each other.
 * Fictional throughout, with 555-01xx numbers.
 */
export const CEDAR_PARK_CLINIC = ClinicConfig.parse({
  id: 'clinic_demo_cedar_park',
  name: 'Cedar Park Clinic',
  timezone: 'America/Denver',
  phoneNumbers: ['+17205550150'],
  hours: { '1': WEEKDAY, '2': WEEKDAY, '3': WEEKDAY, '4': WEEKDAY, '5': WEEKDAY },
  greeting: "Thanks for calling Cedar Park Clinic. I'm the clinic's AI assistant. How can I help you today?",
  providers: [{ id: 'prov_osei', name: 'Dr. Ama Osei', visitTypeIds: ['vt_sick'] }],
  visitTypes: [{ id: 'vt_sick', name: 'sick visit', minutes: 20 }],
  routing: [{ target: 'front_desk', uri: 'tel:+17205550151', when: 'open' }],
});

/** Both demo clinics, for the seed and the evals. */
export const DEMO_CLINICS = { maple: DEMO_CLINIC, cedar_park: CEDAR_PARK_CLINIC } as const;
