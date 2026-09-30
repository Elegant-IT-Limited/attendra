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

const SAT_TO_THU = [{ open: '08:00', close: '20:00' }];
const MORNINGS = [{ open: '08:00', close: '14:00' }];

/**
 * The second demo clinic: a diagnostic centre in Dhaka that speaks Bangla first and
 * English second, open Saturday to Thursday. It shows the Bangla voice (experimental)
 * and that one Attendra serves clinics that never see each other. Fictional
 * throughout: the centre, the doctors, the prices, and the numbers in the +880 10
 * range, which no Bangladeshi operator gives to subscribers.
 */
export const DHANMONDI_CLINIC = ClinicConfig.parse({
  id: 'clinic_demo_dhanmondi',
  name: 'Dhanmondi Diagnostic Centre',
  timezone: 'Asia/Dhaka',
  phoneNumbers: ['+8801000000100'],
  hours: { '6': SAT_TO_THU, '0': SAT_TO_THU, '1': SAT_TO_THU, '2': SAT_TO_THU, '3': SAT_TO_THU, '4': SAT_TO_THU },
  holidays: ['2026-12-16'],
  greeting: 'ধানমন্ডি ডায়াগনস্টিক সেন্টারে ফোন করার জন্য ধন্যবাদ। আমি এখানকার এআই সহকারী। আপনাকে কীভাবে সাহায্য করতে পারি?',
  languages: ['bn', 'en'],
  primaryLanguage: 'bn',
  emergencyNumber: '999',
  providers: [
    { id: 'prov_farhana', name: 'Dr. Farhana Rahman', names: { bn: 'ডা. ফারহানা রহমান' }, visitTypeIds: ['vt_consult', 'vt_ultrasound'] },
    { id: 'prov_kamal', name: 'Dr. Kamal Hossain', names: { bn: 'ডা. কামাল হোসেন' }, visitTypeIds: ['vt_consult', 'vt_ecg'],
      hours: { '6': [{ open: '16:00', close: '20:00' }], '0': [{ open: '16:00', close: '20:00' }], '2': [{ open: '16:00', close: '20:00' }], '4': [{ open: '16:00', close: '20:00' }] } },
    // not a person: the collection room's time, booked like a provider's
    { id: 'prov_collection', name: 'the sample collection room', names: { bn: 'নমুনা সংগ্রহ কক্ষ' }, visitTypeIds: ['vt_blood', 'vt_home'],
      hours: { '6': MORNINGS, '0': MORNINGS, '1': MORNINGS, '2': MORNINGS, '3': MORNINGS, '4': MORNINGS } },
  ],
  visitTypes: [
    { id: 'vt_blood', name: 'blood test', names: { bn: 'রক্ত পরীক্ষা' }, minutes: 10 },
    { id: 'vt_home', name: 'home sample collection', names: { bn: 'বাসা থেকে নমুনা সংগ্রহ' }, minutes: 30 },
    { id: 'vt_ultrasound', name: 'ultrasound', names: { bn: 'আল্ট্রাসনোগ্রাম' }, minutes: 20 },
    { id: 'vt_ecg', name: 'ECG', names: { bn: 'ইসিজি' }, minutes: 15 },
    { id: 'vt_consult', name: 'doctor consultation', names: { bn: 'ডাক্তার দেখানো' }, minutes: 15 },
  ],
  routing: [{ target: 'front_desk', uri: 'tel:+8801000000101', when: 'open' }],
  faqs: [
    { id: 'faq_reports', question: 'When will my report be ready? রিপোর্ট কবে পাবো? report kobe pabo, result',
      answer: 'রক্ত পরীক্ষার রিপোর্ট সাধারণত একই দিন সন্ধ্যা ৭টার মধ্যে পাওয়া যায়। আল্ট্রাসনোগ্রাম আর ইসিজির রিপোর্ট পরীক্ষার এক ঘণ্টার মধ্যে দেওয়া হয়। Blood test reports are usually ready by 7 pm the same day; ultrasound and ECG reports within an hour.' },
    { id: 'faq_fasting', question: 'Do I need to fast before a blood test? খালি পেটে আসতে হবে? khali pete fasting',
      answer: 'ফাস্টিং ব্লাড সুগার আর লিপিড প্রোফাইলের জন্য ৮ থেকে ১২ ঘণ্টা খালি পেটে আসবেন, পানি খেতে পারবেন। অন্য পরীক্ষায় খালি পেটের দরকার নেই। Fast for 8 to 12 hours before a fasting sugar or lipid profile; water is fine.' },
    { id: 'faq_home', question: 'Which areas do you cover for home sample collection? বাসা থেকে নমুনা সংগ্রহ কোন এলাকায়? basha home collection area',
      answer: 'ধানমন্ডি, মোহাম্মদপুর, লালমাটিয়া, কলাবাগান আর জিগাতলায় বাসা থেকে নমুনা সংগ্রহ করা হয়, সার্ভিস চার্জ ৩০০ টাকা। We collect at home in Dhanmondi, Mohammadpur, Lalmatia, Kalabagan and Jigatola, for a 300 taka service charge.' },
    { id: 'faq_prices', question: 'How much does a test cost? পরীক্ষার দাম কত টাকা? dam koto taka price cost',
      answer: 'সিবিসি ৪০০ টাকা, ফাস্টিং ব্লাড সুগার ১৫০ টাকা, লিপিড প্রোফাইল ৯০০ টাকা, ইসিজি ৫০০ টাকা, পেটের আল্ট্রাসনোগ্রাম ১৮০০ টাকা, ডাক্তার দেখানো ৮০০ টাকা। CBC 400 taka, fasting sugar 150, lipid profile 900, ECG 500, abdominal ultrasound 1,800, consultation 800.' },
  ],
  emergencyTransferEnabled: false,
});

/** Both demo clinics, for the seed and the evals. */
export const DEMO_CLINICS = { maple: DEMO_CLINIC, dhanmondi: DHANMONDI_CLINIC } as const;
