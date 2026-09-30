// SPDX-License-Identifier: AGPL-3.0-only
import {
  addDays, type AuditLog, type ClinicConfig, type DomainEvent, emergencyNumberFor, type EventSink, findSlots, isClearYes, isMedicalQuestion, type KnowledgeBase, localDateOf, localName, MEDICAL_REFUSAL,
  type Messenger, NO_INFORMATION, PACKS, parseDob,
  type PatientDirectory, resolveTransfer, type SchedulerAdapter, speakSlot, type TaskQueue,
  ToolArgs, type ToolName, todaysHoursLine, weekHours, zonedInstant,
} from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { createHash } from 'node:crypto';
import type { CallState } from './call-state';
import { answerFromFaqs } from './knowledge';

export interface Backend {
  patients: PatientDirectory;
  scheduler: SchedulerAdapter;
  tasks: TaskQueue;
  audit: AuditLog;
  messenger: Messenger;
  /** The clinic's own documents. Without it, the assistant answers from the FAQ alone. */
  knowledge?: KnowledgeBase;
  /** The clinic's webhooks hear about bookings, cancellations and requests. */
  events?: EventSink;
}

export interface CallContext {
  clinic: ClinicConfig;
  callId: string;
  callerNumber: string | null;
  now: () => Date;
  log?: Logger;
}

/** What a tool hands back: data for the planner, and optionally a call-control action. */
export interface ToolResult {
  ok: boolean;
  data: Record<string, unknown>;
  action?: { type: 'transfer'; uri: string } | { type: 'hangup' };
}

const MAX_VERIFY_ATTEMPTS = 3;
const PATIENT_TOOLS = new Set<ToolName>(['list_appointments', 'propose_booking', 'propose_cancellation', 'commit_pending', 'create_refill_request']);
// tools that change something; they refuse to run for an outdated request
const WRITE_TOOLS = new Set<ToolName>(['propose_booking', 'propose_cancellation', 'commit_pending', 'create_refill_request', 'create_callback', 'transfer_call', 'end_call']);
// after an emergency the only things left to do are to hand the caller to a person
const EMERGENCY_ALLOWED = new Set<ToolName>(['transfer_call', 'create_callback', 'end_call', 'get_clinic_info']);
const MEDICAL = () => refuse('medical_question', `Do not answer it, and do not read anything from the clinic's documents. Say: "${MEDICAL_REFUSAL}" Offer to take a callback.`);

const refuse = (code: string, say: string): ToolResult => ({ ok: false, data: { error: code, say } });
const key = (...parts: (string | number)[]) => createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 32);

/**
 * Runs one tool call for the planner. The rules the product promises are enforced
 * here, in code, whatever the model asks for:
 *  - nothing patient-specific before the caller is verified by name and DOB;
 *  - a booking can only use a slot the caller was actually offered;
 *  - no write without a spoken read-back and a clear yes to it in the caller's own words;
 *  - every write carries an idempotency key, so a retry cannot book twice;
 *  - work for an outdated request, or after an emergency, is refused;
 *  - refills and callbacks become staff tasks, never decisions.
 */
export async function runTool(
  name: ToolName, rawArgs: unknown, state: CallState, ctx: CallContext, backend: Backend, revision = state.revision,
): Promise<ToolResult> {
  const parsed = ToolArgs[name].safeParse(rawArgs);
  if (!parsed.success) return refuse('invalid_arguments', 'Ask the caller to repeat that detail.');
  if (state.emergency && !EMERGENCY_ALLOWED.has(name)) {
    return refuse('emergency_in_progress', `Do not continue the task. Repeat that if this is an emergency they should call ${emergencyNumberFor(ctx.clinic)}.`);
  }
  if (WRITE_TOOLS.has(name) && revision !== state.revision) {
    return refuse('superseded', 'The caller has asked for something else since; do not act on this request.');
  }
  if (PATIENT_TOOLS.has(name) && !state.verifiedPatient) {
    return refuse('identity_required', 'Before that, ask for the caller\'s full name and date of birth.');
  }
  const { clinic } = ctx;
  const args = parsed.data as Record<string, unknown>;
  // never let a webhook problem undo or hold up what the caller was told
  const emit = (e: DomainEvent) => backend.events?.emit(clinic.id, e).catch((err: unknown) => ctx.log?.warn({ call_id: ctx.callId, type: e.type, err }, 'event not queued'));
  // everything said back to the caller is in the language they are speaking
  const lang = state.language;
  const pack = PACKS[lang];
  const when = (start: Date) => speakSlot(start, clinic.timezone, lang);
  const providerName = (id: string) => { const p = clinic.providers.find((x) => x.id === id); return p ? localName(p, lang) : undefined; };

  switch (name) {
    case 'verify_caller': {
      if (state.verifiedPatient) return { ok: true, data: { verified: true, first_name: state.verifiedPatient.firstName } };
      if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
      }
      state.verifyAttempts++;
      // numeric dates are month first only in North America
      const dob = parseDob(String(args.date_of_birth), ctx.now(), clinic.phoneNumbers[0]!.startsWith('+1') ? 'mdy' : 'dmy');
      if (!dob) return refuse('unclear_date_of_birth', 'Ask for the date of birth again, month, day and year.');
      const found = await backend.patients.findByNameAndDob(clinic.id, String(args.full_name), dob);
      if (found.status === 'found') {
        state.verifiedPatient = found.patient;
        return { ok: true, data: { verified: true, first_name: found.patient.firstName } };
      }
      if (found.status === 'ambiguous') return refuse('needs_staff', 'Say you need a colleague to confirm their record, and offer a callback.');
      // same answer for "no such patient" and "wrong DOB": never confirm a record exists
      return refuse('not_verified', 'Say you could not find a match and ask them to spell their last name and repeat their date of birth.');
    }

    case 'get_clinic_info': {
      const question = String(args.question);
      // the medical-advice rule wins over anything the FAQ or a document says. It checks
      // what the caller said too: the model may pass on a question it has softened
      if (isMedicalQuestion(question) || isMedicalQuestion(state.recentCallerText())) return MEDICAL();
      const hours = todaysHoursLine(clinic, ctx.now());
      const answer = answerFromFaqs(clinic.faqs, question);
      const passages = !answer && backend.knowledge ? await backend.knowledge.search(clinic.id, question) : [];
      // a question answered from the clinic's own words is a call the assistant handled
      if ((answer || passages.length) && state.outcome === 'abandoned') state.outcome = 'info';
      return {
        ok: true,
        data: {
          today: hours, next_7_days: weekHours(clinic, ctx.now()), answer: answer?.answer ?? null, source: answer?.id ?? null,
          ...(passages.length ? { passages: passages.map((p) => ({ title: p.title, text: p.text })) } : {}),
        },
      };
    }

    case 'search_knowledge': {
      const question = String(args.question);
      if (isMedicalQuestion(question) || isMedicalQuestion(state.recentCallerText())) return MEDICAL();
      const passages = backend.knowledge ? await backend.knowledge.search(clinic.id, question) : [];
      if (!passages.length) return { ok: true, data: { passages: [], say: `Nothing in the clinic's documents answers this. Say: "${NO_INFORMATION}" Offer to take a callback.` } };
      if (state.outcome === 'abandoned') state.outcome = 'info';
      return {
        ok: true,
        data: {
          passages: passages.map((p) => ({ title: p.title, text: p.text })),
          say: 'Answer only from these passages, in a sentence or two, in the caller\'s language. If they do not answer the question, say you do not have that information and offer a callback. Never add advice of your own.',
        },
      };
    }

    case 'find_slots': {
      const visitType = clinic.visitTypes.find((v) => v.id === args.visit_type_id);
      if (!visitType) return refuse('unknown_visit_type', `Ask which of these they need: ${clinic.visitTypes.map((v) => localName(v, lang)).join(', ')}.`);
      const providers = args.provider_id ? clinic.providers.filter((p) => p.id === args.provider_id) : clinic.providers;
      const now = ctx.now();
      const today = localDateOf(now, clinic.timezone);
      const requested = (args.from_date as string | null) ?? today;
      const from = requested < today ? today : requested;
      const days = 14;
      // busy time must cover the whole search window, however far out it starts
      const busy = await backend.scheduler.busy(clinic.id, providers.map((p) => p.id), now, zonedInstant(addDays(from, days + 1), '00:00', clinic.timezone));
      const slots = findSlots(clinic, busy, { visitType, providers, from, days, now, partOfDay: args.part_of_day as 'any' });
      for (const s of slots) state.offered.set(s.id, s);
      return {
        ok: true,
        data: {
          slots: slots.map((s) => ({ slot_id: s.id, when: when(s.start), provider: providerName(s.providerId) })),
          note: slots.length ? 'Offer these as written. Do not invent other times.' : 'No openings in the next two weeks; offer a callback.',
        },
      };
    }

    case 'list_appointments': {
      const upcoming = await backend.scheduler.upcoming(clinic.id, state.verifiedPatient!.id, ctx.now());
      return { ok: true, data: { appointments: upcoming.map((a) => ({ appointment_id: a.id, when: when(a.start), provider: providerName(a.providerId) })) } };
    }

    case 'propose_booking': {
      const slot = state.offered.get(String(args.slot_id));
      if (!slot) return refuse('slot_not_offered', 'Only offer times returned by find_slots. Look up slots again.');
      const replaces = (args.replaces_appointment_id as string | null) ?? null;
      let replacing: string | null = null;
      if (replaces) {
        const current = (await backend.scheduler.upcoming(clinic.id, state.verifiedPatient!.id, ctx.now())).find((a) => a.id === replaces);
        if (!current) return refuse('unknown_appointment', 'Use list_appointments to find the appointment being moved.');
        replacing = when(current.start);
      }
      const provider = providerName(slot.providerId) ?? 'the provider';
      const providerKind = clinic.providers.find((x) => x.id === slot.providerId)?.kind ?? 'person';
      const visitType = clinic.visitTypes.find((v) => v.id === slot.visitTypeId);
      const visit = visitType ? localName(visitType, lang) : 'visit';
      const readback = pack.readbackBooking({ when: when(slot.start), provider, providerKind, visit, replacing });
      state.pending = { kind: 'book', slot, replacesAppointmentId: replaces, readback, seq: ++state.proposals, proposedAtMs: state.lastMs(), readbackAtMs: null };
      return { ok: true, data: { say: `Read this back and ask for a clear yes: ${readback}.` } };
    }

    case 'propose_cancellation': {
      const upcoming = await backend.scheduler.upcoming(clinic.id, state.verifiedPatient!.id, ctx.now());
      const appt = upcoming.find((a) => a.id === args.appointment_id);
      if (!appt) return refuse('unknown_appointment', 'Use list_appointments to find the appointment first.');
      const readback = pack.readbackCancel({ when: when(appt.start) });
      state.pending = { kind: 'cancel', appointmentId: appt.id, readback, seq: ++state.proposals, proposedAtMs: state.lastMs(), readbackAtMs: null };
      return { ok: true, data: { say: `Ask them to confirm, with a clear yes, that you should ${readback}.` } };
    }

    case 'commit_pending': {
      const pending = state.pending;
      if (!pending) return refuse('nothing_pending', 'There is nothing to confirm. Propose the change first.');
      if (pending.readbackAtMs === null) return refuse('not_read_back', `Read it back first: ${pending.readback}.`);
      if (!isClearYes(state.answerToReadback(), clinic.languages)) return refuse('no_clear_yes', `Do not make the change yet. Ask again: ${pending.readback}?`);
      const patient = state.verifiedPatient!;

      if (pending.kind === 'cancel') {
        const cancelled = await backend.scheduler.cancel(clinic.id, { patientId: patient.id, appointmentId: pending.appointmentId, callId: ctx.callId, idempotencyKey: key(ctx.callId, 'cancel', pending.appointmentId, pending.seq) });
        state.pending = null;
        if (cancelled.status === 'not_found') return refuse('unknown_appointment', 'Say you could not find that appointment and offer a callback.');
        state.outcome = 'cancelled';
        if (cancelled.status === 'cancelled') {
          await emit({ type: 'appointment.cancelled', key: pending.appointmentId, data: { appointmentId: pending.appointmentId, patientId: patient.id, by: 'assistant', callId: ctx.callId, reason: 'patient_asked' } });
        }
        return { ok: true, data: { cancelled: true } };
      }

      const result = await backend.scheduler.book(clinic.id, {
        patientId: patient.id, slot: pending.slot, callId: ctx.callId, idempotencyKey: key(ctx.callId, 'book', pending.slot.id, pending.seq),
        replacesAppointmentId: pending.replacesAppointmentId,
      });
      state.pending = null;
      if (result.status === 'slot_taken') {
        state.offered.delete(pending.slot.id);
        return refuse('slot_taken', 'That time was just taken. Apologise and look up slots again.');
      }
      if (result.status === 'patient_busy') {
        state.offered.delete(pending.slot.id);
        return refuse('patient_busy', 'They already have an appointment at that time. Say so, and offer another time.');
      }
      let oldStillActive = false;
      if (pending.replacesAppointmentId) {
        const moved = await backend.scheduler.cancel(clinic.id, { patientId: patient.id, appointmentId: pending.replacesAppointmentId, callId: ctx.callId, idempotencyKey: key(ctx.callId, 'replace', pending.replacesAppointmentId, pending.seq) });
        oldStillActive = moved.status === 'not_found';
      }
      state.outcome = pending.replacesAppointmentId && !oldStillActive ? 'rescheduled' : 'booked';
      if (result.status === 'booked') {
        const a = result.appointment;
        const facts = { appointmentId: a.id, patientId: patient.id, providerId: a.providerId, visitTypeId: a.visitTypeId, startsAt: a.start.toISOString(), endsAt: a.end.toISOString(), by: 'assistant', callId: ctx.callId };
        await emit(state.outcome === 'rescheduled'
          ? { type: 'appointment.rescheduled', key: `${a.id}|${facts.startsAt}`, data: { ...facts, previousAppointmentId: pending.replacesAppointmentId } }
          : { type: 'appointment.booked', key: a.id, data: facts });
      }
      // the booking stands whatever happens to the text message; never report it as failed
      let smsSent = false;
      if (patient.phone) {
        try {
          await backend.messenger.sendTemplate(clinic.id, {
            to: patient.phone, template: 'booking_confirmed', idempotencyKey: key(ctx.callId, 'sms', result.appointment.id), language: lang,
            vars: { clinic: clinic.name, when: when(result.appointment.start), clinicPhone: clinic.phoneNumbers[0]! },
          });
          smsSent = true;
        } catch (err) {
          ctx.log?.warn({ call_id: ctx.callId, err }, 'confirmation text failed; the booking stands');
        }
      }
      return {
        ok: true,
        data: {
          booked: true, when: pending.readback, sms_sent: smsSent,
          ...(oldStillActive ? { old_appointment_still_active: true, say: 'The new time is booked, but the old appointment could not be cancelled; offer a callback to sort it out.' } : {}),
        },
      };
    }

    case 'create_refill_request': {
      const task = await backend.tasks.create(clinic.id, {
        type: 'refill', callId: ctx.callId, patientId: state.verifiedPatient!.id,
        idempotencyKey: key(ctx.callId, 'refill', String(args.medication).toLowerCase()),
        details: { medication: String(args.medication), pharmacy: String(args.pharmacy), callback_number: String(args.callback_number) },
      });
      state.outcome = 'task_created';
      if (task.created) await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, type: 'refill', patientId: state.verifiedPatient!.id, callId: ctx.callId } });
      return { ok: true, data: { task_id: task.id, say: 'Tell them the request is with the care team, who will review it. Do not promise approval or a time.' } };
    }

    case 'create_callback': {
      const task = await backend.tasks.create(clinic.id, {
        type: 'callback', callId: ctx.callId, patientId: state.verifiedPatient?.id ?? null,
        idempotencyKey: key(ctx.callId, 'callback', String(args.reason).toLowerCase()),
        details: { reason: String(args.reason), callback_number: String(args.callback_number) },
      });
      if (!state.emergency) state.outcome = 'task_created';
      if (task.created) await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, type: 'callback', patientId: state.verifiedPatient?.id ?? null, callId: ctx.callId } });
      return { ok: true, data: { task_id: task.id } };
    }

    case 'transfer_call': {
      const target = args.target as 'front_desk' | 'billing' | 'on_call';
      const resolved = resolveTransfer(clinic, target, ctx.now());
      if (!resolved.ok) return refuse(resolved.reason, 'Nobody is available on that line right now. Offer to take a callback.');
      await backend.audit.record(clinic.id, { actor: 'voice-agent', action: `call.transferred.${target}`, entity: 'call', entityId: ctx.callId, callId: ctx.callId });
      if (!state.emergency) state.outcome = 'transferred';
      return { ok: true, data: { transferring: target, say: 'Tell them you are connecting them now.' }, action: { type: 'transfer', uri: resolved.uri } };
    }

    case 'end_call':
      return { ok: true, data: { ending: true, say: 'Say goodbye warmly.' }, action: { type: 'hangup' } };
  }
}
