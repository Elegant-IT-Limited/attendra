import { ClinicConfig, RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { describe, expect, it } from 'vitest';
// the voice's own prompt lives in the voice engine, which builds on this package; read here as source so the
// one table covers both prompts without a dependency the wrong way round
import { conversationPrompt, openingInstruction } from '../../voice-engine/src/prompt';
import { type Backend, CallState, runTool, systemPrompt } from '../src';

/**
 * Every setting reaches the call in one of these ways, on purpose:
 * - prompt: in the voice's or the planner's instructions;
 * - clinic_info: in what get_clinic_info returns, which any caller may hear;
 * - code: a rule the backend enforces without saying it (booking rules, transfers, texts);
 * - staff_only: for the team, never told to callers (a caller who asks gets a callback offer);
 * - verified_only: told only about the verified caller's own record.
 * A new setting with no row here fails the first test: decide which it is before it ships.
 */
type Way = 'prompt' | 'clinic_info' | 'code' | 'staff_only' | 'verified_only';

const AUDIT: Record<string, Way> = {
  id: 'code',
  name: 'prompt',
  address: 'clinic_info',
  website: 'clinic_info',
  industry: 'code', // which pack: the words and the rules of a veterinary clinic or a medical one
  timezone: 'code',
  phoneNumbers: 'clinic_info', // the clinic's own line, for "what's your number?"; the first is the one calls arrive on
  hours: 'clinic_info',
  holidays: 'clinic_info',
  'booking.noPreference': 'code',
  'booking.usualWithinDays': 'code',
  'booking.tieBreak': 'code',
  'booking.matchAnimal': 'code',
  voiceEngine: 'code', // set by the operator
  answeringPaused: 'code', // set by the hosting layer
  'specialDays[].date': 'clinic_info',
  'specialDays[].windows[].open': 'clinic_info',
  'specialDays[].windows[].close': 'clinic_info',
  'specialDays[].note': 'clinic_info',
  greeting: 'prompt',
  greetings: 'prompt',
  'talk.pace': 'prompt',
  'talk.style': 'prompt',
  'talk.acknowledgements': 'prompt',
  assistantName: 'prompt',
  languages: 'prompt',
  primaryLanguage: 'prompt',
  emergencyNumber: 'code', // the emergency script says it
  voice: 'code',
  'providers[].id': 'code',
  'providers[].name': 'clinic_info',
  'providers[].names': 'clinic_info',
  'providers[].kind': 'clinic_info',
  'providers[].gender': 'clinic_info',
  'providers[].specialty': 'clinic_info',
  'providers[].categories': 'clinic_info',
  'providers[].ages.min': 'clinic_info',
  'providers[].ages.max': 'clinic_info',
  'providers[].acceptingNewPatients': 'clinic_info',
  'providers[].hours': 'clinic_info',
  'providers[].timeOff[].from': 'clinic_info',
  'providers[].timeOff[].to': 'clinic_info',
  'providers[].timeOff[].note': 'staff_only', // why a vet is away is theirs: callers hear when, not why
  'providers[].timeOff[].start': 'clinic_info',
  'providers[].timeOff[].end': 'clinic_info',
  'providers[].visitTypeIds': 'clinic_info',
  'providers[].placeholder': 'code', // the stand-in steps aside once anyone else is listed
  'providers[].credentials': 'clinic_info',
  'providers[].custom': 'clinic_info', // under the field's label, unless the field is kept for the team
  'visitTypes[].id': 'code',
  'visitTypes[].name': 'clinic_info',
  'visitTypes[].names': 'clinic_info',
  'visitTypes[].minutes': 'clinic_info',
  'visitTypes[].audience': 'clinic_info',
  'visitTypes[].description': 'clinic_info',
  'visitTypes[].staffOnly': 'clinic_info',
  'visitTypes[].noticeHours': 'code',
  'visitTypes[].maxDaysAhead': 'code',
  'visitTypes[].bufferMinutes': 'code',
  'routing[].target': 'code',
  'routing[].uri': 'code',
  'routing[].when': 'code',
  'routing[].priority': 'code',
  'faqs[].id': 'code',
  'faqs[].question': 'code', // what a caller's question is matched on
  'faqs[].answer': 'clinic_info',
  'offers[].id': 'code',
  'offers[].title': 'clinic_info',
  'offers[].details': 'clinic_info',
  'offers[].from': 'code', // an offer is told only while it runs
  'offers[].to': 'clinic_info',
  'requestTopics[].id': 'code',
  'requestTopics[].name': 'clinic_info',
  'requestTopics[].collect': 'clinic_info',
  'menuLinks[].label': 'staff_only',
  'menuLinks[].url': 'staff_only',
  // pets' and patients' own fields: filled in by the team, never told on a call
  'customFields[].id': 'staff_only',
  'customFields[].label': 'staff_only',
  'customFields[].kind': 'staff_only',
  'customFields[].options': 'staff_only',
  'customFields[].required': 'staff_only',
  'customFields[].column': 'staff_only',
  'customFields[].tellCallers': 'staff_only', // not offered on these: they are never told
  // a vet's or doctor's own fields: the values are told under these labels (providers[].custom)
  'providerFields[].id': 'code',
  'providerFields[].label': 'clinic_info',
  'providerFields[].kind': 'code',
  'providerFields[].options': 'code',
  'providerFields[].required': 'staff_only',
  'providerFields[].column': 'staff_only',
  'providerFields[].tellCallers': 'code',
  'requestFields[].id': 'staff_only',
  'requestFields[].label': 'staff_only',
  'requestFields[].kind': 'staff_only',
  'requestFields[].options': 'staff_only',
  'requestFields[].required': 'staff_only',
  'requestFields[].column': 'staff_only',
  'requestFields[].tellCallers': 'staff_only',
  // the order of the dashboard's pick lists; the values themselves reach callers on each vet
  'lists.specialties': 'staff_only',
  'lists.categories': 'staff_only',
  'lists.species': 'staff_only',
  'texting.enabled': 'code',
  'texting.kinds.change_confirmed': 'code',
  'texting.kinds.directions': 'code',
  'texting.kinds.hours': 'code',
  'texting.kinds.emergency_hospital': 'code',
  'texting.kinds.provider': 'code',
  'texting.kinds.answer': 'code',
  'texting.kinds.link': 'code',
  'texting.mapUrl': 'code',
  'texting.links[].id': 'clinic_info',
  'texting.links[].label': 'clinic_info',
  'texting.links[].url': 'code', // in the text, never read out
  'texting.links[].when': 'clinic_info',
  'texting.wording': 'code',
  'texting.reminders.enabled': 'code',
  'texting.reminders.hoursBefore': 'code',
  'texting.reminders.quietFrom': 'code',
  'texting.reminders.quietTo': 'code',
  'texting.reminders.askOnBooking': 'code',
  'vipCallers[].name': 'code', // the VIP opening greets them by it
  'vipCallers[].phone': 'code',
  emergencyTransferEnabled: 'code',
  'emergencyHospital.name': 'clinic_info',
  'emergencyHospital.phone': 'clinic_info',
  'emergencyHospital.address': 'clinic_info',
  'emergencyHospital.hours.open': 'clinic_info',
  'emergencyHospital.hours.close': 'clinic_info',
  'moreEmergencyHospitals[].name': 'clinic_info',
  'moreEmergencyHospitals[].phone': 'clinic_info',
  'moreEmergencyHospitals[].address': 'clinic_info',
  'moreEmergencyHospitals[].hours.open': 'clinic_info',
  'moreEmergencyHospitals[].hours.close': 'clinic_info',
  afterHours: 'code',
  averageVisitValue: 'staff_only', // the weekly report
  'emergencyReview.reviewerName': 'staff_only',
  'emergencyReview.reviewerRole': 'staff_only',
  'emergencyReview.reviewedAt': 'staff_only',
  'emergencyReview.version': 'staff_only',
  retentionDays: 'code', // older call records are deleted
  'recording.enabled': 'clinic_info',
  'recording.notice': 'prompt',
};

/** A clinic with every setting a caller may hear filled in, each with a value found nowhere else. */
const SAMPLE = ClinicConfig.parse({
  ...RIVERBEND_CLINIC,
  website: 'https://riverbend.example',
  phoneNumbers: ['+17205550170', '+17205550172'],
  hours: { ...RIVERBEND_CLINIC.hours, '1': [{ open: '07:45', close: '18:15' }] },
  holidays: ['2026-10-26'],
  specialDays: [{ date: '2026-10-20', windows: [{ open: '09:15', close: '12:45' }], note: 'Vet conference' }],
  greetings: { es: 'Gracias por llamar a Riverbend. Le habla Juniper, el asistente de IA de la clínica. ¿En qué le puedo ayudar?' },
  talk: { pace: 'brisk', style: 'professional', acknowledgements: false },
  providers: [
    { ...RIVERBEND_CLINIC.providers[0]!, names: { es: 'Dra. Elena Ruiz' }, ages: { min: 2, max: 15 }, acceptingNewPatients: false, hours: { '2': [{ open: '07:30', close: '11:45' }] },
      timeOff: [{ from: '2026-10-05', to: '2026-10-05', start: '13:00', end: '17:00', note: 'Dentist appointment' }], credentials: ['Fear Free Certified'], custom: { quals: 'DVM, 12 years with cats' } },
    ...RIVERBEND_CLINIC.providers.slice(1),
  ],
  visitTypes: RIVERBEND_CLINIC.visitTypes.map((v) => (v.id === 'vt_vaccines' ? { ...v, description: 'Bring the vaccine card.', staffOnly: true } : v)),
  offers: [{ id: 'off_dental', title: 'Dental month', details: '20% off dental cleanings.', from: '2026-09-01', to: '2026-10-31' }],
  requestTopics: [{ id: 'boarding', name: 'Boarding inquiry', collect: 'The dates and the pet' }],
  providerFields: [{ id: 'quals', label: 'Qualifications', kind: 'text' }],
  emergencyHospital: { ...RIVERBEND_CLINIC.emergencyHospital!, hours: { open: '07:00', close: '23:00' } },
  moreEmergencyHospitals: [{ name: 'Night Owl Vet ER', phone: '+17205550189', address: '5 Elm Street, Denver', hours: { open: '18:00', close: '08:00' } }],
  recording: { enabled: true, notice: 'This call may be recorded for quality.' },
});

/** For each row a caller may hear: a value from SAMPLE, as it shows in what the assistant is given. */
const SAMPLES: Record<string, string> = {
  name: 'Riverbend Animal Hospital',
  address: '88 Riverbend Road',
  website: 'https://riverbend.example',
  phoneNumbers: '+17205550172',
  hours: '07:45 to 18:15',
  holidays: '2026-10-26',
  'specialDays[].date': '2026-10-20',
  'specialDays[].windows[].open': '09:15',
  'specialDays[].windows[].close': '12:45',
  'specialDays[].note': 'Vet conference',
  greeting: 'How can I help you and your pet today?',
  greetings: '¿En qué le puedo ayudar?',
  'talk.pace': 'brisk, efficient pace',
  'talk.style': 'calm and professional',
  'talk.acknowledgements': 'without filler acknowledgements',
  assistantName: 'You are Juniper',
  languages: 'You may also speak Spanish',
  primaryLanguage: 'Speak English',
  'providers[].name': 'Dr. Elena Ruiz',
  'providers[].names': 'Dra. Elena Ruiz',
  'providers[].kind': '"kind":"person"',
  'providers[].gender': '"gender":"female"',
  'providers[].specialty': 'General practice',
  'providers[].categories': 'Dentistry',
  'providers[].ages.min': 'ages 2 to 15',
  'providers[].ages.max': 'ages 2 to 15',
  'providers[].acceptingNewPatients': '"accepting_new_patients":false',
  'providers[].hours': 'Tue 07:30-11:45',
  'providers[].timeOff[].from': '2026-10-05 13:00 to 17:00',
  'providers[].timeOff[].to': '2026-10-05 13:00 to 17:00',
  'providers[].timeOff[].start': '2026-10-05 13:00 to 17:00',
  'providers[].timeOff[].end': '2026-10-05 13:00 to 17:00',
  'providers[].visitTypeIds': '"visit_types":["wellness exam","sick visit","vaccine appointment","new patient exam"]',
  'providers[].credentials': 'Fear Free Certified',
  'providers[].custom': 'DVM, 12 years with cats',
  'visitTypes[].name': 'vaccine appointment',
  'visitTypes[].names': 'cita de vacunas',
  'visitTypes[].minutes': '"minutes":40',
  'visitTypes[].audience': 'patients already on file only',
  'visitTypes[].description': 'Bring the vaccine card.',
  'visitTypes[].staffOnly': 'the team only: take a request',
  'faqs[].answer': 'itemised invoice',
  'offers[].title': 'Dental month',
  'offers[].details': '20% off dental cleanings.',
  'offers[].to': '2026-10-31',
  'requestTopics[].name': 'Boarding inquiry',
  'requestTopics[].collect': 'The dates and the pet',
  'providerFields[].label': '"Qualifications":"DVM, 12 years with cats"',
  'texting.links[].id': 'new_client',
  'texting.links[].label': 'New client form',
  'texting.links[].when': 'a new client asks about paperwork',
  'emergencyHospital.name': 'Front Range Pet Emergency',
  'emergencyHospital.phone': '+17205550188',
  'emergencyHospital.address': '1200 Larkspur Avenue',
  'emergencyHospital.hours.open': '07:00 to 23:00',
  'emergencyHospital.hours.close': '07:00 to 23:00',
  'moreEmergencyHospitals[].name': 'Night Owl Vet ER',
  'moreEmergencyHospitals[].phone': '+17205550189',
  'moreEmergencyHospitals[].address': '5 Elm Street, Denver',
  'moreEmergencyHospitals[].hours.open': '18:00 to 08:00',
  'moreEmergencyHospitals[].hours.close': '18:00 to 08:00',
  'recording.enabled': 'callers hear a notice',
  'recording.notice': 'This call may be recorded for quality.',
};

type Def = { type: string; innerType?: Schema; in?: Schema; out?: Schema; element?: Schema; shape?: Record<string, Schema> };
type Schema = { _zod: { def: Def } };
const WRAPPERS = new Set(['optional', 'default', 'nullable', 'prefault', 'readonly']);
const unwrap = (s: Schema): Schema => {
  const d = s._zod.def;
  if (WRAPPERS.has(d.type)) return unwrap(d.innerType!);
  // a preprocessed or transformed value: the object it checks
  if (d.type === 'pipe') return unwrap(d.out!._zod.def.type === 'transform' ? d.in! : d.out!);
  return s;
};
/** Every setting, as a path: "providers[].timeOff[].note". Objects and lists of objects are opened; anything else is one setting. */
function settingsOf(s: Schema, prefix = ''): string[] {
  const d = unwrap(s)._zod.def;
  if (d.type === 'object') return Object.entries(d.shape!).flatMap(([k, v]) => settingsOf(v, prefix ? `${prefix}.${k}` : k));
  if (d.type === 'array' && unwrap(d.element!)._zod.def.type === 'object') return settingsOf(d.element!, `${prefix}[]`);
  return [prefix];
}

// Monday 28 September 2026, 10:00 at Riverbend: open
const NOW = zonedInstant('2026-09-28', '10:00', SAMPLE.timezone);

async function clinicInfo(question: string, language: 'en' | 'es'): Promise<string> {
  const state = new CallState();
  state.language = language;
  const r = await runTool('get_clinic_info', { question }, state, { clinic: SAMPLE, callId: 'coverage', callerNumber: null, now: () => NOW }, {} as Backend);
  expect(r.ok).toBe(true);
  return JSON.stringify(r.data);
}

describe('every setting reaches the assistant, or is kept from callers on purpose', () => {
  it('has a row for every setting in ClinicConfig, and none for a setting that is gone', () => {
    const settings = settingsOf(ClinicConfig as unknown as Schema);
    expect(settings.filter((k) => !(k in AUDIT)), 'settings with no row: say how each reaches the call').toEqual([]);
    expect(Object.keys(AUDIT).filter((k) => !settings.includes(k)), 'rows for settings that no longer exist').toEqual([]);
  });

  it('shows a sample of every setting a caller may hear in what the assistant is given', async () => {
    const given: Record<'prompt' | 'clinic_info', string> = {
      prompt: [conversationPrompt(SAMPLE, NOW), openingInstruction(SAMPLE), systemPrompt(SAMPLE, 'Today is Monday.')].join('\n'),
      // the FAQ answer comes back for the question it answers; local names, for a caller speaking that language
      clinic_info: [await clinicInfo('how do I pay, do you take pet insurance', 'en'), await clinicInfo('opening hours', 'es')].join('\n'),
    };
    const missing = Object.entries(AUDIT).flatMap(([key, way]) => {
      if (way !== 'prompt' && way !== 'clinic_info') return [];
      const sample = SAMPLES[key];
      return sample && given[way].includes(sample) ? [] : [`${key} (${way}): ${sample ? `"${sample}" not found` : 'no sample value'}`];
    });
    expect(missing).toEqual([]);
    expect(Object.keys(SAMPLES).filter((k) => AUDIT[k] !== 'prompt' && AUDIT[k] !== 'clinic_info'), 'samples for rows callers never hear').toEqual([]);
  });

  it('gives callers nothing that is kept for the team', async () => {
    const info = await clinicInfo('opening hours', 'en');
    expect(info).not.toContain('Dentist appointment');
  });
});
