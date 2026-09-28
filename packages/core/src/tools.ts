// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { TransferTarget } from './clinic';

/**
 * Arguments for every backend tool, as the planner model must send them. The same
 * schemas become the JSON schema of the function tools, so the contract and the
 * validator cannot drift apart.
 */
export const ToolArgs = {
  verify_caller: z.object({ full_name: z.string().min(3), date_of_birth: z.string().min(4) }),
  get_clinic_info: z.object({ question: z.string().min(2) }),
  find_slots: z.object({
    visit_type_id: z.string(),
    provider_id: z.string().nullable(),
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    part_of_day: z.enum(['morning', 'afternoon', 'any']),
  }),
  list_appointments: z.object({}),
  // Writes happen in two steps. propose_* stores the change and returns the read-back
  // sentence; commit_pending performs it only if the caller has said yes since.
  propose_booking: z.object({ slot_id: z.string(), replaces_appointment_id: z.string().nullable() }),
  propose_cancellation: z.object({ appointment_id: z.string() }),
  commit_pending: z.object({}),
  create_refill_request: z.object({ medication: z.string().min(2), pharmacy: z.string().min(2), callback_number: z.string().min(7) }),
  create_callback: z.object({ reason: z.string().min(3).max(200), callback_number: z.string().min(7) }),
  transfer_call: z.object({ target: TransferTarget }),
  end_call: z.object({ reason: z.string().max(100) }),
} as const;

export type ToolName = keyof typeof ToolArgs;
export type ToolArgsOf<T extends ToolName> = z.infer<(typeof ToolArgs)[T]>;
export const TOOL_NAMES = Object.keys(ToolArgs) as ToolName[];
