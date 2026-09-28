// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig } from './clinic';

/**
 * The demo clinic. Fictional throughout: the name, the providers, the 555-01xx
 * numbers (reserved for fiction in North America) and every patient in the seed.
 */
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
  holidays: ['2026-11-26', '2026-12-25'],
  greeting: 'Thanks for calling Maple Street Family Medicine. I am the clinic\'s AI assistant. How can I help you today?',
  providers: [
    { id: 'prov_okafor', name: 'Dr. Nkem Okafor', visitTypeIds: ['vt_sick', 'vt_annual', 'vt_new'] },
    { id: 'prov_lindqvist', name: 'Dr. Ann Lindqvist', visitTypeIds: ['vt_sick', 'vt_annual'],
      hours: { '2': [{ open: '09:00', close: '15:00' }], '4': [{ open: '09:00', close: '15:00' }] } },
  ],
  visitTypes: [
    { id: 'vt_sick', name: 'sick visit', minutes: 20 },
    { id: 'vt_annual', name: 'annual physical', minutes: 40 },
    { id: 'vt_new', name: 'new patient visit', minutes: 60 },
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
