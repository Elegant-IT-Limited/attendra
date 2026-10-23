// SPDX-License-Identifier: AGPL-3.0-only
import { crisisLineFor, detectEmergencies, isAbusive, detectLanguage, emergencyNumberFor, hospitalFor, industryPack, isPetEmergency, type Language, normalise, PACKS, resolveTransfer, textingOf, todayLine, todaysHoursLine, TRANSFER_KINDS, type ToolName } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import type { CallState } from './call-state';
import { coachingInstruction, DOING, type LiveEvent, shortName, TAKE_OVER_LINE } from './live';
import type { Planner } from './planner';
import { type Backend, type CallContext, runTool, type ToolResult } from './tools';

/** The assistant's words that promise the team will be in touch ("I'll pass that along", "someone will call you back"). */
const CALLBACK_PROMISE = /\b(pass (that|this|it|your (message|request|details)) (along|on)|(have|get|ask) (someone|the team|our team|a team member|the clinic|staff|the staff|a vet|the vet|a veterinarian)( from the clinic)? (to )?(call|ring|get back to|contact) you|(will|'ll|is going to) (call|ring|get back to|contact) you|call you back|be in touch|let the team know|le (llamar[aá]n|llamaremos|devolver[aá]n la llamada)|alguien (le|te) llamar[aá])/i;

/** What the voice engine should send or do. The engine owns the socket; the agent owns the decisions. */
export type Outbound =
  | { type: 'thinking' | 'commentary'; delegationId: string; content: string }
  | { type: 'instructions'; delegationId: null; content: string }
  | { type: 'transfer'; uri: string; afterMs?: number; quiet?: boolean }
  | { type: 'hangup'; afterMs?: number };

// GPT-Live accepts at most 500 tokens per append. Names, digits and addresses
// tokenize worse than prose, so cap at about 2.4 characters per token.
const MAX_APPEND_CHARS = 1200;
export const clamp = (s: string) => (s.length <= MAX_APPEND_CHARS ? s : `${s.slice(0, MAX_APPEND_CHARS - 1)}…`);

// Call control waits for the spoken result: "I'll connect you now" before the ring,
// the goodbye before the line drops.
const AFTER_SPEECH_MS = 3500;
/** A VIP hears the greeting and one line first: at least this long, then until the assistant is quiet. */
const VIP_AFTER_MS = 6000;
/** How long a request may run before the caller hears that it is still being worked on. */
const HOLD_AFTER_MS = 7000;
/** What the voice hears while a request runs. Not to be said: the answer usually comes in a moment. */
export const PROGRESS_NOTE = 'Looking it up. Do not tell the caller you are working on it or checking; the answer comes in a moment, then say it.';
// and the emergency number before an emergency transfer starts ringing
const AFTER_EMERGENCY_SCRIPT_MS = 8000;

/** Before "he's fine" in the same clause: a no, a doubt or a wish ("I don't think he's okay", "I hope she's fine", "no está bien"). */
const NOT_SAFE_BEFORE = /\b(no|not|never|nunca|hope|hoping|ojala|espero|if|si|whether|maybe|quizas|tal vez)\b|n't\b/;
/** Where a clause starts again: what comes before it does not change it. */
const CLAUSE = /[.,;:!]|\b(but|pero|and now|y ahora)\b/g;

/**
 * Said, not asked or doubted: the caller states the animal is safe. A question ("do you
 * think she's okay?"), a negation or a hedge before the words in the same clause does not
 * lift the emergency.
 */
function saidSafe(text: string, safe: RegExp | undefined): boolean {
  if (!safe || /[?¿]/.test(text)) return false;
  const m = safe.exec(text);
  if (!m) return false;
  const before = text.slice(0, m.index);
  let start = 0;
  for (const c of before.matchAll(CLAUSE)) start = c.index + c[0].length;
  return !NOT_SAFE_BEFORE.test(before.slice(start));
}

/**
 * A caller who insults or threatens: the first time, the assistant stays calm and carries
 * on; the second, it says once that the call will end if it goes on, and offers a call
 * back; the third, it ends the call politely. Never during an emergency, and never for
 * a caller who is only upset (see isAbusive). The call is flagged for the clinic.
 */
/** The three steps, with the warning and the goodbye in the language of the call, word for word. */
const abuseLines = (language: Language) => [
  'The caller used insulting or threatening language. Stay calm and polite, do not comment on it, do not apologise for it, and keep helping with their request.',
  `The caller is still using insulting or threatening language. Say calmly, once, exactly: "${PACKS[language].abuseWarning}" Then keep helping.`,
  `Stop the current task. Say exactly: "${PACKS[language].abuseGoodbye}" Then say nothing more.`,
] as const;
const ABUSE_STEPS = 3;
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
    // the trade's own emergencies (an animal in danger) are checked too, before the engine's
    const trade = industryPack(clinic.industry);
    const fresh = detectEmergencies(this.state.recentCallerText(), trade.emergency?.phrases).filter((m) => !this.state.emergencyKinds.has(m.kind));
    // a person in danger of harming themselves always comes first; then the trade's
    // emergency, whose script also tells a person in danger to call the emergency number
    const match = trade.emergency ? fresh.find((m) => m.kind === 'self_harm') ?? fresh.find((m) => isPetEmergency(m.kind)) ?? fresh[0] : fresh[0];
    if (!match) return [...this.maybeClearEmergency(delta), ...this.checkAbuse()];
    this.state.emergencyCleared = false; // a new emergency holds the call again

    for (const m of fresh) this.state.emergencyKinds.add(m.kind);
    this.state.emergency ??= { kind: match.kind, atMs: endMs };
    this.state.outcome = 'emergency';
    this.state.pending = null; // nothing half-booked survives an emergency
    this.state.textOffer = null; // nor a text offered before it
    this.state.revision++; // and any request already in flight is dropped, not spoken over the script
    this.log.warn({ call_id: this.ctx.callId, emergency_kind: match.kind }, 'emergency guardrail triggered');
    this.emit({ type: 'emergency', kind: match.kind });
    this.emitState();

    // The script is said in the language the emergency was said in, when the clinic
    // offers it, and otherwise in the language of the call. The number is the clinic's.
    const language = clinic.languages.includes(match.language) ? match.language : this.state.language;
    const pack = PACKS[language];
    const number = emergencyNumberFor(clinic);
    // an animal in danger (or the bare word "emergency" at a clinic for animals) gets the trade's script
    const forTrade = trade.emergency && (isPetEmergency(match.kind) || match.kind === 'general');
    // the clinic's first choice of hospital that is open now; none open, the nearest 24-hour one
    const hospital = hospitalFor(clinic, this.ctx.now());
    const script = match.kind === 'self_harm' ? pack.selfHarmScript(number, crisisLineFor(clinic))
      : forTrade ? trade.emergency!.script(language, { hospital, emergencyNumber: number, textOffer: textingOf(clinic).enabled && textingOf(clinic).kinds.emergency_hospital })
        : pack.emergencyScript(number);
    const out: Outbound[] = [{ type: 'instructions', delegationId: null, content: script }];
    // what the caller must hear before anyone may end the call: the hospital's name, or the number
    this.emergencyScript = { content: script, number: forTrade && hospital ? hospital.name : number, sentAt: this.ctx.now().getTime(), said: false, heard: '' };
    // once per call, the first time a kind serious enough is heard: "this is an emergency"
    // on its own does not ring anyone, and must not stop the chest pain after it from doing so
    if (!this.state.emergencyTransferSent && this.ctx.clinic.emergencyTransferEnabled && TRANSFER_KINDS.has(match.kind)) {
      const onCall = resolveTransfer(this.ctx.clinic, 'on_call', this.ctx.now());
      if (onCall.ok) {
        // after the script has been said: the runner waits until the assistant is quiet
        out.push({ type: 'transfer', uri: onCall.uri, afterMs: AFTER_EMERGENCY_SCRIPT_MS, quiet: true });
        this.state.emergencyTransferSent = true;
      }
    }
    return out;
  }

  /**
   * After an animal emergency's script has been said, a caller who says the animal is
   * safe ("he's fine now, I just want a check-up") may carry on: a broad list sends some
   * calm owners to the script by mistake, and they must not be stuck. Only when every
   * emergency on the call was an animal's (or the bare word "emergency" at a vet clinic):
   * never after a person in danger. The emergency stays on the call's record.
   */
  private maybeClearEmergency(delta: string): Outbound[] {
    const s = this.state;
    const safe = industryPack(this.ctx.clinic.industry).emergency?.safe;
    if (!s.emergencyLocked || !safe || !this.canEndByStaff()) return [];
    if (![...s.emergencyKinds].every((k) => isPetEmergency(k) || k === 'general')) return [];
    const text = normalise(delta);
    if (!this.ctx.clinic.languages.some((l) => saidSafe(text, safe[l]))) return [];
    s.emergencyCleared = true;
    s.revision++;
    this.log.info({ call_id: this.ctx.callId, emergency_kind: s.emergency?.kind }, 'caller said the animal is safe; the call goes on');
    this.emit({ type: 'emergency', kind: 'cleared' });
    this.emitState();
    return [{ type: 'instructions', delegationId: null, content: 'The caller says the animal is safe and it is not an emergency. You may help with what they ask now, including booking a visit. If anything they say sounds urgent again, repeat where to take the animal.' }];
  }

  onAgentTranscript(delta: string, startMs: number, endMs: number) {
    this.state.addTranscript('agent', delta, startMs, endMs);
    this.emit({ type: 'caption', speaker: 'agent', text: delta, atMs: startMs });
    const s = this.emergencyScript;
    if (s && !s.said) {
      s.heard = (s.heard + delta).slice(-400);
      // a number ("9-1-1") or a hospital's name ("City Pet ER"), however it was spaced or punctuated
      const plain = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      s.said = plain(s.heard).includes(plain(s.number));
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
    if (this.state.emergencyLocked && this.emergencyScript) out.push({ type: 'instructions', delegationId: null, content: this.emergencyScript.content });
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
    if (this.state.emergencyLocked && this.emergencyScript) out.push({ type: 'instructions', delegationId: null, content: this.emergencyScript.content });
    return out;
  }

  /**
   * The caller finished speaking and the assistant has said nothing since, with no tool
   * at work: a word to answer now. The first time, answer, or ask them to repeat what
   * was missed; the second, apologise for the wait too. Counted for the call's quality.
   */
  onSilence(nth: number): Outbound[] {
    this.state.silenceNudges++;
    this.log.info({ call_id: this.ctx.callId, nth }, 'assistant nudged after a silence');
    return [{
      type: 'instructions', delegationId: null,
      content: nth <= 1
        ? 'The caller finished speaking and is waiting for you. Answer them now, in one or two short sentences. If you did not catch what they said, say so briefly and ask them to say it again.'
        : 'The caller has been waiting in silence. Apologise briefly for the wait, then answer them, or ask them to repeat what they said.',
    }];
  }

  /**
   * The assistant told the caller the team will call them back, or that it passed something
   * on, and no request exists: it is told to make it now. A promise to call back is kept by
   * a request with the caller's number, never by the model's word. Twice at most per call.
   */
  private promiseChecked = -1;
  onPromiseCheck(): Outbound[] {
    const s = this.state;
    if (s.requestMade || s.ending || s.emergencyLocked || s.promiseNudges >= 2) return [];
    let i = s.turns.length - 1;
    while (i >= 0 && s.turns[i]!.speaker !== 'agent') i--;
    if (i < 0 || i === this.promiseChecked) return [];
    this.promiseChecked = i;
    if (!CALLBACK_PROMISE.test(s.turns[i]!.text)) return [];
    s.promiseNudges++;
    this.log.info({ call_id: this.ctx.callId, nth: s.promiseNudges }, 'the assistant promised a callback that is not recorded: asking for it');
    return [{ type: 'instructions', delegationId: null, content: 'You told the caller the team will get back to them, but no request exists yet. If the caller wants a callback, ask the backend now to create it with what they need; their number is the one they are calling from unless they gave another. Do not mention this note.' }];
  }

  /** A person takes the call: the assistant says so, then the call is transferred. Work in flight is dropped. */
  takeOver(uri: string, by: string | null = null): Outbound[] {
    this.state.revision++;
    this.state.pending = null;
    if (!this.state.emergencyLocked) this.state.outcome = 'transferred';
    this.emit({ type: 'staff', action: 'taken_over', by });
    this.emitState();
    return [
      { type: 'instructions', delegationId: null, content: `Stop the current task. Say exactly: "${TAKE_OVER_LINE}" Then say nothing more.` },
      { type: 'transfer', uri, afterMs: AFTER_SPEECH_MS, quiet: true },
    ];
  }

  /**
   * A caller the clinic marked VIP: after the greeting, the assistant says it is
   * connecting them and the call goes to the front desk. A failed transfer is
   * handled like a staff takeover's: the assistant stays and offers a callback.
   */
  vip(uri: string): Outbound[] {
    this.state.revision++;
    this.state.outcome = 'transferred';
    this.emit({ type: 'staff', action: 'vip' });
    this.emitState();
    return [
      { type: 'instructions', delegationId: null, content: `This caller is on the clinic's VIP list. Right after your greeting, say exactly: "${TAKE_OVER_LINE}" Then say nothing more.` },
      // after the greeting and the line, whatever their length: the runner waits for quiet
      { type: 'transfer', uri, afterMs: VIP_AFTER_MS, quiet: true },
    ];
  }

  /** Insults or threats, counted once per caller turn: calm, then a warning, then a polite end. */
  private checkAbuse(): Outbound[] {
    const s = this.state;
    const turn = s.turns.filter((t) => t.speaker === 'caller').length;
    // once the call is being ended for it, nothing more is said or scheduled
    if (s.abuseTurn === turn || s.endedByStaff || (s.abuse >= ABUSE_STEPS && !s.emergencyLocked) || !isAbusive(s.lastTurn('caller'))) return [];
    s.abuseTurn = turn;
    s.abuse++;
    // an emergency is never cut short: the assistant stays calm and keeps to the script
    const ending = s.abuse >= ABUSE_STEPS && !s.emergencyLocked;
    const lines = abuseLines(s.language);
    this.log.warn({ call_id: this.ctx.callId, abuse: s.abuse, ending }, 'insulting or threatening language from the caller');
    void this.actions?.record({ tool: 'abusive_caller', argsRedacted: {}, result: { step: ending ? 'ended' : s.abuse === 1 ? 'noted' : 'warned' }, revision: s.revision })
      .catch((err) => this.log.warn({ call_id: this.ctx.callId, err }, 'recording the abusive caller failed'));
    if (!ending) return [{ type: 'instructions', delegationId: null, content: s.emergencyLocked ? lines[0] : lines[Math.min(s.abuse, 2) - 1]! }];
    s.revision++; // whatever was in flight is dropped, not spoken over the goodbye
    s.pending = null;
    s.endedForAbuse = true;
    this.emitState();
    return [
      { type: 'instructions', delegationId: null, content: lines[2] },
      { type: 'hangup', afterMs: AFTER_SPEECH_MS },
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
    // once the goodbye has been said (staff ended the call, or an abusive caller), nothing more is planned or spoken
    if (this.state.ending) return [{ type: 'thinking', delegationId, content: 'The call is being ended. Say nothing more.' }];
    const revision = ++this.state.revision;
    const out: Outbound[] = [];
    // a note for the voice, not words for the caller: most answers come back within a second or
    // two, and a reply that opens with "working on it" every time sounds like a machine
    const progress: Outbound = { type: 'thinking', delegationId, content: PROGRESS_NOTE };
    if (emit) emit(progress); else out.push(progress);
    // a long wait is never silence: once, the caller hears that we are still on it
    const hold = emit ? setTimeout(() => {
      if (revision === this.state.revision) emit({ type: 'thinking', delegationId, content: 'Still working on it. Tell the caller in a few words that you are still checking.' });
    }, HOLD_AFTER_MS) : null;

    const controls: Outbound[] = [];
    const execute = async (name: ToolName, args: unknown): Promise<ToolResult> => {
      this.doing = DOING[name] ?? null;
      this.emit({ type: 'tool', tool: name, status: 'started', code: null });
      this.emitState();
      const result = await runTool(name, args, this.state, this.ctx, this.backend, revision);
      const code = typeof result.data.error === 'string' ? result.data.error : null;
      this.emit({ type: 'tool', tool: name, status: code ? 'refused' : 'ok', code });
      // the patient this call is about, as staff watching it see them: it changes when a parent moves on to the next child
      if ((name === 'create_callback' || name === 'create_refill_request') && result.ok) this.state.requestMade = true;
      if ((name === 'verify_caller' || name === 'register_patient') && result.data.verified !== false && (result.data.verified === true || result.data.registered === true)) {
        const a = (args ?? {}) as { full_name?: unknown; first_name?: unknown; last_name?: unknown; pet_name?: unknown };
        // a pet is shown by its own name
        const spoken = a.pet_name ? '' : name === 'verify_caller' ? String(a.full_name ?? '') : `${String(a.first_name ?? '')} ${String(a.last_name ?? '')}`;
        this.verified = a.pet_name ? String(result.data.pet_name ?? a.pet_name) : shortName(spoken) ?? String(result.data.first_name ?? 'Verified');
      }
      this.emitState();
      // the step already happened (a booking is booked): a failed write of its record is
      // logged, and never turned into "I couldn't do that" for the caller
      try {
        await this.actions?.record({
          tool: name,
          argsRedacted: Object.keys((args ?? {}) as object), // argument names only; values can be PHI
          result: { ok: result.ok, ...pick(result.data, ['error', 'verified', 'booked', 'cancelled', 'transferring', 'texted', 'template', 'consent_at_ms']) },
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
        clinic: this.ctx.clinic, state: this.state, callerNumber: this.ctx.callerNumber, history: this.ctx.history ?? null,
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
      if (hold) clearTimeout(hold);
      this.doing = this.state.pending ? 'waiting for a yes' : null;
      this.emitState();
    }
    return out;
  }
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}
