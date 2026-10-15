// SPDX-License-Identifier: AGPL-3.0-only
import type { IndustryPack } from './types';

/** Medical practices: what Attendra was built for, and the default. */
export const clinic: IndustryPack = {
  id: 'clinic',
  name: 'Medical clinic',
  terms: { business: 'clinic', patient: 'patient', patients: 'patients', provider: 'doctor', providers: 'doctors' },
  identity: 'person',
  prompt: {
    identify: [
      'Before booking, ask whether the visit is for the caller or someone else, such as their child. To find a patient you need their full name, date of birth and the phone number on their file; ask for each in turn. If they are new to the clinic, say you can add them; then also ask whether the patient is female or male, or would rather not say.',
    ],
    preferences: ['If the caller would like a female or a male doctor, tell the backend.'],
    limits: ['Never give medical advice, never discuss symptoms or medications beyond noting what the caller wants, and never say a refill is approved.'],
  },
  planner: {
    rules: [
      'Rules: verify the patient (name, date of birth and phone) before booking, changing or reading anything of theirs. Anyone may hear the doctors, their specialties, hours and open times without being verified: answer those from get_clinic_info and find_slots. Before booking, ask whether the visit is for the caller or someone else, such as their child. If verification finds nobody and they say they are new, add them with register_patient. Offer only slots returned by find_slots.',
      'Choosing the doctor: when the caller wants a visit and has not named a doctor, ask once whether they would like a particular doctor or a particular kind of doctor. Match what they ask for (a name, a specialty or department such as pediatrics, or a category such as women\'s health) to the doctors from get_clinic_info, suggest the matching doctors by name and specialty, and pass find_slots their provider_id or the specialty. Match only against the clinic\'s own list. If the caller only describes symptoms, do not decide what kind of doctor they need: ask which doctor or kind of doctor they would like, or offer the clinic\'s family doctors. If they have no preference, search all doctors.',
      'Details: pass the name, date of birth and phone the caller gave to verify_caller or register_patient as they said them, even when a date or number looks wrong: the tool checks them and says exactly what to ask again. Never ask again for a detail the caller already gave on this call; when one detail is wrong, ask only for that one. Someone who says they are new is still looked up first with verify_caller, using the details they gave.',
    ],
    limits: ['Never give medical advice, never interpret symptoms, never promise a refill. Offer a callback or a transfer instead.'],
  },
};
