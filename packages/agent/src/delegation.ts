// SPDX-License-Identifier: AGPL-3.0-only
import { crisisLineFor, detectEmergencies, detectLanguage, emergencyNumberFor, PACKS, resolveTransfer, todayLine, todaysHoursLine, TRANSFER_KINDS, type ToolName } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import type { CallState } from './call-state';
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
    const { clinic } = this.ctx;
    if (clinic.languages.length > 1) this.state.language = detectLanguage(this.state.recentCallerText(600), clinic.languages, clinic.primaryLanguage);
    const fresh = detectEmergencies(this.state.recentCallerText()).filter((m) => !this.state.emergencyKinds.has(m.kind));
    const match = fresh[0];
    if (!match) return [];

    const first = !this.state.emergency;
    for (const m of fresh) this.state.emergencyKinds.add(m.kind);
    this.state.emergency ??= { kind: match.kind, atMs: endMs };
    this.state.outcome = 'emergency';
    this.state.pending = null; // nothing half-booked survives an emergency
    this.state.revision++; // and any request already in flight is dropped, not spoken over the script
    this.log.warn({ call_id: this.ctx.callId, emergency_kind: match.kind }, 'emergency guardrail triggered');

    // The script is said in the language the emergency was said in, when the clinic
    // offers it, and otherwise in the language of the call. The number is the clinic's.
    const pack = PACKS[clinic.languages.includes(match.language) ? match.language : this.state.language];
    const number = emergencyNumberFor(clinic);
    const script = match.kind === 'self_harm' ? pack.selfHarmScript(number, crisisLineFor(clinic)) : pack.emergencyScript(number);
    const out: Outbound[] = [{ type: 'instructions', delegationId: null, content: script }];
    if (first && this.ctx.clinic.emergencyTransferEnabled && TRANSFER_KINDS.has(match.kind)) {
      const onCall = resolveTransfer(this.ctx.clinic, 'on_call', this.ctx.now());
      if (onCall.ok) out.push({ type: 'transfer', uri: onCall.uri, afterMs: AFTER_EMERGENCY_SCRIPT_MS });
    }
    return out;
  }

  onAgentTranscript(delta: string, startMs: number, endMs: number) {
    this.state.addTranscript('agent', delta, startMs, endMs);
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
      const result = await runTool(name, args, this.state, this.ctx, this.backend, revision);
      await this.actions?.record({
        tool: name,
        argsRedacted: Object.keys((args ?? {}) as object), // argument names only; values can be PHI
        result: { ok: result.ok, ...pick(result.data, ['error', 'verified', 'booked', 'cancelled', 'transferring']) },
        revision,
        patientId: this.state.verifiedPatient?.id ?? null,
      });
      if (result.action) controls.push({ ...result.action, afterMs: AFTER_SPEECH_MS });
      return result;
    };

    try {
      const plan = await this.planner.plan({ clinic: this.ctx.clinic, state: this.state, nowLine: `${todayLine(this.ctx.clinic, this.ctx.now())} ${todaysHoursLine(this.ctx.clinic, this.ctx.now())}` }, execute);
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
    }
    return out;
  }
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}
