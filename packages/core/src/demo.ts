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
    { id: 'prov_okafor', name: 'Dr. Nkem Okafor', gender: 'male', specialty: 'Family medicine', categories: ['Adults', 'Chronic conditions'],
      visitTypeIds: ['vt_sick', 'vt_annual', 'vt_new'] },
    { id: 'prov_lindqvist', name: 'Dr. Ann Lindqvist', gender: 'female', specialty: 'Family medicine', categories: ["Women's health", 'Older adults'],
      ages: { min: 18, max: null }, acceptingNewPatients: false, visitTypeIds: ['vt_sick', 'vt_annual'],
      hours: { '2': [{ open: '09:00', close: '15:00' }], '4': [{ open: '09:00', close: '15:00' }] } },
    // added after the first eval scenarios: last in the list, so a tie for the same time still goes to the doctors above
    { id: 'prov_raman', name: 'Dr. Priya Raman', gender: 'female', specialty: 'Pediatrics', categories: ['Children', 'Newborns', 'Vaccinations'],
      ages: { min: 0, max: 17 }, visitTypeIds: ['vt_sick', 'vt_annual', 'vt_new'],
      hours: { '1': [{ open: '08:00', close: '12:00' }], '3': [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }], '5': [{ open: '08:00', close: '13:00' }] } },
  ],
  visitTypes: [
    { id: 'vt_sick', name: 'sick visit', names: { es: 'consulta por enfermedad' }, minutes: 20 },
    { id: 'vt_annual', name: 'annual physical', names: { es: 'examen físico anual' }, minutes: 40, audience: 'existing' },
    { id: 'vt_new', name: 'new patient visit', names: { es: 'primera consulta' }, minutes: 60, audience: 'new' },
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
  providers: [{ id: 'prov_osei', name: 'Dr. Ama Osei', gender: 'female', specialty: 'Family medicine', visitTypeIds: ['vt_sick'] }],
  visitTypes: [{ id: 'vt_sick', name: 'sick visit', minutes: 20 }],
  routing: [{ target: 'front_desk', uri: 'tel:+17205550151', when: 'open' }],
});

const VET_DAY = [{ open: '08:00', close: '18:00' }];

/**
 * The veterinary demo clinic, on the vet industry pack, in an organization of its own.
 * Out of hours it takes requests instead of booking, and it sends an animal in danger
 * to its emergency hospital. Fictional throughout, with 555-01xx numbers.
 */
export const RIVERBEND_CLINIC = ClinicConfig.parse({
  id: 'clinic_demo_riverbend',
  name: 'Riverbend Animal Hospital',
  industry: 'vet',
  timezone: 'America/Denver',
  phoneNumbers: ['+17205550170'],
  hours: { '1': VET_DAY, '2': VET_DAY, '3': VET_DAY, '4': VET_DAY, '5': VET_DAY, '6': [{ open: '09:00', close: '13:00' }] },
  holidays: demoHolidays(new Date().getUTCFullYear()),
  greeting: "Thanks for calling Riverbend Animal Hospital. I'm Juniper, the clinic's AI assistant. How can I help you and your pet today?",
  assistantName: 'Juniper',
  languages: ['en', 'es'],
  primaryLanguage: 'en',
  providers: [
    { id: 'prov_ruiz', name: 'Dr. Elena Ruiz', gender: 'female', specialty: 'General practice', categories: ['Dogs', 'Cats', 'Dentistry'], visitTypeIds: ['vt_wellness', 'vt_sick', 'vt_vaccines', 'vt_new'] },
    { id: 'prov_bell', name: 'Dr. Marcus Bell', gender: 'male', specialty: 'General practice', categories: ['Dogs', 'Cats', 'Senior pets'], visitTypeIds: ['vt_wellness', 'vt_sick', 'vt_vaccines', 'vt_new'] },
    { id: 'prov_sato', name: 'Dr. Hana Sato', gender: 'female', specialty: 'Exotic pets', categories: ['Rabbits', 'Birds', 'Reptiles', 'Small mammals'],
      visitTypeIds: ['vt_wellness', 'vt_sick', 'vt_new'], hours: { '2': VET_DAY, '4': VET_DAY } },
  ],
  visitTypes: [
    { id: 'vt_wellness', name: 'wellness exam', names: { es: 'chequeo general' }, minutes: 30, audience: 'existing' },
    { id: 'vt_sick', name: 'sick visit', names: { es: 'consulta por enfermedad' }, minutes: 20 },
    { id: 'vt_vaccines', name: 'vaccine appointment', names: { es: 'cita de vacunas' }, minutes: 15 },
    { id: 'vt_new', name: 'new patient exam', names: { es: 'primera consulta' }, minutes: 40, audience: 'new' },
  ],
  routing: [
    { target: 'front_desk', uri: 'tel:+17205550171', when: 'open' },
    { target: 'on_call', uri: 'tel:+17205550179', when: 'always' },
  ],
  faqs: [
    { id: 'faq_address', question: 'Where are you located? What is the address? Where do I park?', answer: 'We are at 88 Riverbend Road, Denver, with free parking in front of the clinic.' },
    { id: 'faq_payment', question: 'How do I pay? Do you take pet insurance?', answer: 'We take cards and cash. We give you an itemised invoice to send to your pet insurance.' },
    { id: 'faq_first_visit', question: 'What should I bring to the first visit?', answer: 'Bring any records from your previous vet, and bring dogs on a leash and cats in a carrier.' },
    { id: 'faq_boarding', question: 'Do you board pets? Do you offer grooming?', answer: 'We do not offer boarding or grooming. The front desk can suggest places nearby.' },
  ],
  emergencyTransferEnabled: true,
  emergencyHospital: { name: 'Front Range Pet Emergency', phone: '+17205550188', address: '1200 Larkspur Avenue, Denver' },
  afterHours: 'requests',
  address: '88 Riverbend Road, Denver',
  // texts during a call, after a yes: the demo shows them as not sent, since it has no Twilio
  texting: { enabled: true, links: [{ id: 'new_client', label: 'New client form', url: 'https://riverbend.example/new-client', when: 'a new client asks about paperwork or forms' }] },
});

/** The demo clinics, for the seed and the evals. */
export const DEMO_CLINICS = { maple: DEMO_CLINIC, cedar_park: CEDAR_PARK_CLINIC, riverbend: RIVERBEND_CLINIC } as const;
