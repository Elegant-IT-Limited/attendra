// SPDX-License-Identifier: AGPL-3.0-only
import { crisisLineFor, detectEmergencies, detectLanguage, emergencyNumberFor, PACKS, resolveTransfer, todayLine, todaysHoursLine, TRANSFER_KINDS, type ToolName } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import type { CallState } from './call-state';
import { coachingInstruction, DOING, type LiveEvent, shortName, TAKE_OVER_LINE } from './live';
import type { Planner } from './planner';
import { type Backend, type CallContext, runTool, type ToolResult } from './tools';

/** What the voice engine should send or do. The engine owns the socket; the agent owns the decisions. */
export type Outbound =
  | { type: 'thinking' | 'commentary'; delegationId: string; content: string }
  | { type: 'instructions'; delegationId: null; content: string }
  | { type: 'transfer'; uri: string; afterMs?: number }
  | { type: 'hangup'; afterMs?: number };

// GPT-Live accepts at most 500 tokens per append. Names, digits and addresses
// tokenize worse than prose, so cap at about 2.4 characters per token.
const MAX_APPEND_CHARS = 1200;
export const clamp = (s: string) => (s.length <= MAX_APPEND_CHARS ? s : `${s.slice(0, MAX_APPEND_CHARS - 1)}…`);

// Call control waits for the spoken result: "I'll connect you now" before the ring,
// the goodbye before the line drops.
const AFTER_SPEECH_MS = 3500;
// and the emergency number before an emergency transfer starts ringing
const AFTER_EMERGENCY_SCRIPT_MS = 8000;
// Staff cannot end a call before the caller has heard the emergency number. The
// script counts as said once the assistant speaks the number; if its captions never
// show it, staff may end the call this long after the script was sent.
const EMERGENCY_SCRIPT_GRACE_MS = 20_000;

export interface ActionRecorder {
  /** `patientId` is set once the caller is verified, so the call record can be linked to them. */
  record(entry: { tool: string; argsRedacted: unknown; result: unknown; revision: number; patientId?: string | null }): Promise<void>;
}

/**
 * The per-call brain. The voice engine feeds it transcript fragments and
 * delegations; it returns what to append or do. It holds no socket and no timers,
 * so the same object runs under GPT-Live, under the Realtime fallback and in the
 * text-mode simulator.
 */
export class CallAgent {
  /** Receives every live event for staff watching the call. Set by the voice service. */
  observer: ((e: LiveEvent) => void) | null = null;
  private verified: string | null = null;
  private doing: string | null = null;
  /** The emergency script sent last, when it was sent, and whether the caller has heard the number yet. */
  private emergencyScript: { content: string; number: string; sentAt: number; said: boolean; heard: string } | null = null;

  constructor(
    readonly state: CallState,
    private readonly ctx: CallContext,
    private readonly backend: Backend,
    private readonly planner: Planner,
    private readonly log: Logger,
    private readonly actions?: ActionRecorder,
  ) {
    if (!state.turns.length) state.language = ctx.clinic.primaryLanguage;
  }

  /**
   * Every caller fragment passes the emergency guardrail before anything else, and
   * the guardrail acts on its own: it does not wait for a delegation, and no clinic
   * setting turns it off. It keeps listening after the first match, so a second,
   * different emergency later in the call gets its own instruction.
   */
  onCallerTranscript(delta: string, startMs: number, endMs: number): Outbound[] {
    this.state.addTranscript('caller', delta, startMs, endMs);
    this.emit({ type: 'caption', speaker: 'caller', text: delta, atMs: startMs });
    const { clinic } = this.ctx;
    if (clinic.languages.length > 1) this.state.language = detectLanguage(this.state.recentCallerText(600), clinic.languages, clinic.primaryLanguage);
    const fresh = detectEmergencies(this.state.recentCallerText()).filter((m) => !this.state.emergencyKinds.has(m.kind));
    const match = fresh[0];
    if (!match) return [];

    for (const m of fresh) this.state.emergencyKinds.add(m.kind);
    this.state.emergency ??= { kind: match.kind, atMs: endMs };
    this.state.outcome = 'emergency';
    this.state.pending = null; // nothing half-booked survives an emergency
    this.state.revision++; // and any request already in flight is dropped, not spoken over the script
    this.log.warn({ call_id: this.ctx.callId, emergency_kind: match.kind }, 'emergency guardrail triggered');
    this.emit({ type: 'emergency', kind: match.kind });
    this.emitState();

    // The script is said in the language the emergency was said in, when the clinic
    // offers it, and otherwise in the language of the call. The number is the clinic's.
    const pack = PACKS[clinic.languages.includes(match.language) ? match.language : this.state.language];
    const number = emergencyNumberFor(clinic);
    const script = match.kind === 'self_harm' ? pack.selfHarmScript(number, crisisLineFor(clinic)) : pack.emergencyScript(number);
    const out: Outbound[] = [{ type: 'instructions', delegationId: null, content: script }];
    this.emergencyScript = { content: script, number, sentAt: this.ctx.now().getTime(), said: false, heard: '' };
    // once per call, the first time a kind serious enough is heard: "this is an emergency"
    // on its own does not ring anyone, and must not stop the chest pain after it from doing so
    if (!this.state.emergencyTransferSent && this.ctx.clinic.emergencyTransferEnabled && TRANSFER_KINDS.has(match.kind)) {
      const onCall = resolveTransfer(this.ctx.clinic, 'on_call', this.ctx.now());
      if (onCall.ok) {
        out.push({ type: 'transfer', uri: onCall.uri, afterMs: AFTER_EMERGENCY_SCRIPT_MS });
        this.state.emergencyTransferSent = true;
      }
    }
    return out;
  }

  onAgentTranscript(delta: string, startMs: number, endMs: number) {
    this.state.addTranscript('agent', delta, startMs, endMs);
    this.emit({ type: 'caption', speaker: 'agent', text: delta, atMs: startMs });
    const s = this.emergencyScript;
    if (s && !s.said) {
      s.heard = (s.heard + delta).slice(-400);
      s.said = s.heard.replace(/[\s-]/g, '').includes(s.number);
    }
  }

  /**
   * Whether staff may end the call now. During an emergency, not until the assistant
   * has said the emergency script (its number is in the captions), or the grace period
   * has passed: a caller must never be cut off before hearing where to get help.
   */
  canEndByStaff(): boolean {
    const s = this.emergencyScript;
    return !s || s.said || this.ctx.now().getTime() - s.sentAt >= EMERGENCY_SCRIPT_GRACE_MS;
  }

  /**
   * A staff member's note for the assistant. It goes to the voice model as an
   * instruction marked as staff's, and changes nothing in code: every rule in runTool
   * still applies to whatever the model does with it.
   */
  coach(note: string, by: string | null = null): Outbound[] {
    this.emit({ type: 'staff', action: 'coached', by, note });
    const out: Outbound[] = [{ type: 'instructions', delegationId: null, content: coachingInstruction(note) }];
    // a note never replaces the emergency script: it is sent again after the note
    if (this.state.emergency && this.emergencyScript) out.push({ type: 'instructions', delegationId: null, content: this.emergencyScript.content });
    return out;
  }

  /**
   * A transfer or a hang-up did not go through: the caller is still on the line with
   * the assistant. Staff see it on the live page (and can act again), and the
   * assistant offers a callback instead of leaving the caller waiting.
   */
  onControlFailed(kind: 'transfer' | 'hangup'): Outbound[] {
    this.log.warn({ call_id: this.ctx.callId, kind }, 'call control failed');
    this.emit({ type: 'staff', action: kind === 'transfer' ? 'transfer_failed' : 'end_failed' });
    const out: Outbound[] = [{
      type: 'instructions', delegationId: null,
      content: kind === 'transfer'
        ? 'The transfer did not go through: the caller is still with you. Apologise briefly, and offer to have someone from the clinic call them back. If they want that, take a callback with create_callback.'
        : 'The call could not be ended: the caller is still with you. Ask if there is anything else, and offer to have someone from the clinic call them back.',
    }];
    if (this.state.emergency && this.emergencyScript) out.push({ type: 'instructions', delegationId: null, content: this.emergencyScript.content });
    return out;
  }

  /** A person takes the call: the assistant says so, then the call is transferred. Work in flight is dropped. */
  takeOver(uri: string, by: string | null = null): Outbound[] {
    this.state.revision++;
    this.state.pending = null;
    if (!this.state.emergency) this.state.outcome = 'transferred';
    this.emit({ type: 'staff', action: 'taken_over', by });
    this.emitState();
    return [
      { type: 'instructions', delegationId: null, content: `Stop the current task. Say exactly: "${TAKE_OVER_LINE}" Then say nothing more.` },
      { type: 'transfer', uri, afterMs: AFTER_SPEECH_MS },
    ];
  }

  /** Staff end the call: the assistant says goodbye, then hangs up. */
  endByStaff(by: string | null = null): Outbound[] {
    this.state.endedByStaff = true;
    this.state.revision++;
    this.state.pending = null;
    this.emit({ type: 'staff', action: 'ended', by });
    this.emitState();
    return [
      { type: 'instructions', delegationId: null, content: 'Stop the current task. Thank the caller and say goodbye warmly, in one short sentence. Then say nothing more.' },
      { type: 'hangup', afterMs: AFTER_SPEECH_MS },
    ];
  }

  private emit(e: LiveEvent) {
    try { this.observer?.(e); } catch (err) { this.log.warn({ call_id: this.ctx.callId, err }, 'live observer failed'); }
  }

  private emitState() {
    this.emit({ type: 'state', verified: this.verified, pending: this.state.pending?.readback ?? null, doing: this.doing });
  }

  /**
   * One delegated request. `emit` sends the quiet progress note straight away, while
   * the tools run. Revisions guard against the caller changing their mind meanwhile
   * ("Thursday, not Friday"): a newer delegation or an emergency bumps the revision,
   * this request's writes are refused, and its result is dropped instead of spoken.
   */
  async onDelegation(delegationId: string, emit?: (o: Outbound) => void): Promise<Outbound[]> {
    const revision = ++this.state.revision;
    const out: Outbound[] = [];
    const progress: Outbound = { type: 'thinking', delegationId, content: 'Working on it.' };
    if (emit) emit(progress); else out.push(progress);

    const controls: Outbound[] = [];
    const execute = async (name: ToolName, args: unknown): Promise<ToolResult> => {
      this.doing = DOING[name] ?? null;
      this.emit({ type: 'tool', tool: name, status: 'started', code: null });
      this.emitState();
      const result = await runTool(name, args, this.state, this.ctx, this.backend, revision);
      const code = typeof result.data.error === 'string' ? result.data.error : null;
      this.emit({ type: 'tool', tool: name, status: code ? 'refused' : 'ok', code });
      // the patient this call is about, as staff watching it see them: it changes when a parent moves on to the next child
      if ((name === 'verify_caller' || name === 'register_patient') && result.data.verified !== false && (result.data.verified === true || result.data.registered === true)) {
        const a = (args ?? {}) as { full_name?: unknown; first_name?: unknown; last_name?: unknown };
        const spoken = name === 'verify_caller' ? String(a.full_name ?? '') : `${String(a.first_name ?? '')} ${String(a.last_name ?? '')}`;
        this.verified = shortName(spoken) ?? String(result.data.first_name ?? 'Verified');
      }
      this.emitState();
      // the step already happened (a booking is booked): a failed write of its record is
      // logged, and never turned into "I couldn't do that" for the caller
      try {
        await this.actions?.record({
          tool: name,
          argsRedacted: Object.keys((args ?? {}) as object), // argument names only; values can be PHI
          result: { ok: result.ok, ...pick(result.data, ['error', 'verified', 'booked', 'cancelled', 'transferring']) },
          revision,
          patientId: this.state.verifiedPatient?.id ?? null,
        });
      } catch (err) {
        this.log.error({ call_id: this.ctx.callId, tool: name, err: { name: (err as Error).name, code: (err as { code?: string }).code } }, 'call action not recorded');
      }
      if (result.action) controls.push({ ...result.action, afterMs: AFTER_SPEECH_MS });
      return result;
    };

    try {
      // the clinic as it is now: a doctor added or a day off set in the dashboard counts from the next request
      if (this.ctx.reloadClinic) {
        const fresh = await this.ctx.reloadClinic().catch((err: unknown) => {
          this.log.warn({ call_id: this.ctx.callId, err: { message: (err as Error).message } }, 'could not reload the clinic settings; keeping the ones the call has');
          return null;
        });
        if (fresh) this.ctx.clinic = fresh;
      }
      const plan = await this.planner.plan({
        clinic: this.ctx.clinic, state: this.state, callerNumber: this.ctx.callerNumber,
        nowLine: `${todayLine(this.ctx.clinic, this.ctx.now())} ${todaysHoursLine(this.ctx.clinic, this.ctx.now())}`,
      }, execute);
      if (revision !== this.state.revision) {
        this.log.info({ call_id: this.ctx.callId, revision, current: this.state.revision }, 'discarding result of an outdated request');
        return [];
      }
      if (plan.say) out.push({ type: 'commentary', delegationId, content: clamp(plan.say) });
      out.push(...controls);
    } catch (err) {
      this.log.error({ call_id: this.ctx.callId, err }, 'delegation failed');
      // never claim success on failure; hand the caller to a person instead
      out.push({ type: 'commentary', delegationId, content: 'I\'m sorry, I couldn\'t complete that just now. I can have someone from the clinic call you back.' });
    } finally {
      this.doing = this.state.pending ? 'waiting for a yes' : null;
      this.emitState();
    }
    return out;
  }
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}
