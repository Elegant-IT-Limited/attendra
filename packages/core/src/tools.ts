// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { Gender, TransferTarget } from './clinic';

/**
 * Arguments for every backend tool, as the planner model must send them. The same
 * schemas become the JSON schema of the function tools, so the contract and the
 * validator cannot drift apart.
 */
export const ToolArgs = {
  // the patient's name and date of birth, and the phone number on their file: null means the number they are calling from
  verify_caller: z.object({ full_name: z.string().min(3), date_of_birth: z.string().min(4), phone: z.string().min(7).max(30).nullable().default(null) }),
  // a new patient, after verify_caller found nobody and the caller said they are new; guardian_name for anyone under 18
  register_patient: z.object({
    first_name: z.string().trim().min(1).max(60), last_name: z.string().trim().min(1).max(60), date_of_birth: z.string().min(4),
    // female, male, other, or undisclosed when they prefer not to say: asked, never guessed from a name or a voice
    gender: Gender,
    phone: z.string().min(7).max(30).nullable().default(null), guardian_name: z.string().trim().min(3).max(120).nullable().default(null),
  }),
  get_clinic_info: z.object({ question: z.string().min(2) }),
  // a short topic ("parking", "fasting before blood work"), never a name or other personal detail
  search_knowledge: z.object({ question: z.string().min(2).max(300) }),
  find_slots: z.object({
    visit_type_id: z.string(),
    provider_id: z.string().nullable(),
    // when the caller asks for a female or a male doctor
    provider_gender: z.enum(['female', 'male']).nullable().default(null),
    // the kind of doctor or department the caller asked for, as get_clinic_info lists it
    specialty: z.string().min(2).max(60).nullable().default(null),
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    part_of_day: z.enum(['morning', 'afternoon', 'any']),
    // the earliest time of day the caller wants, 24-hour local: "after 3" or "at 3:30" is 15:00 or 15:30; null when they said none
    from_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
  }),
  list_appointments: z.object({}),
  // the verified pet's next visits, its last one and its usual vet: dates, vets and kinds of visit, nothing medical
  visit_summary: z.object({}),
  // Writes happen in two steps. propose_* stores the change and returns the read-back
  // sentence; commit_pending performs it only if the caller has said yes since.
  propose_booking: z.object({ slot_id: z.string(), replaces_appointment_id: z.string().nullable() }),
  propose_cancellation: z.object({ appointment_id: z.string() }),
  commit_pending: z.object({}),
  // callback_number null: the number they are calling from, when the caller says that one is fine
  // text_updates: the caller's answer to the text offer (true yes, false no); null when it was not asked
  create_refill_request: z.object({ medication: z.string().min(2), pharmacy: z.string().min(2), callback_number: z.string().min(7).nullable().default(null), text_updates: z.boolean().nullable().default(null) }),
  create_callback: z.object({
    reason: z.string().min(3).max(200), callback_number: z.string().min(7).nullable().default(null),
    // one of the clinic's own request topics, as get_clinic_info lists them, when one fits
    topic: z.string().max(80).nullable().default(null),
  }),
  // text the caller something they just heard: the clinic's address, hours, emergency hospital, a doctor's details,
  // the answer just given (ref: its source id), or one of the clinic's links (ref: its id). Sent only after a spoken yes.
  send_text: z.object({
    kind: z.enum(['directions', 'hours', 'emergency_hospital', 'provider', 'answer', 'link']),
    ref: z.string().max(80).nullable().default(null),
    // null: the number they are calling from; a number only when it is the one on their file
    to: z.string().min(7).max(30).nullable().default(null),
  }),
  // after a booking, the caller's answer to the question about reminder texts
  set_reminder_consent: z.object({ agreed: z.boolean() }),
  transfer_call: z.object({ target: TransferTarget }),
  end_call: z.object({ reason: z.string().max(100) }),
} as const;

export type ToolName = keyof typeof ToolArgs;
export type ToolArgsOf<T extends ToolName> = z.infer<(typeof ToolArgs)[T]>;
export const TOOL_NAMES = Object.keys(ToolArgs) as ToolName[];
