// SPDX-License-Identifier: AGPL-3.0-only
import type { Slot } from '@attendra/core';

export interface Turn { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }

interface PendingBase {
  readback: string;
  seq: number; // one per proposal, so rebooking the same slot later in a call gets a fresh idempotency key
  proposedAtMs: number;
  /** Start of the first assistant turn after the proposal: the read-back itself. Null until it is spoken. */
  readbackAtMs: number | null;
}

export type PendingChange =
  | (PendingBase & { kind: 'book'; slot: Slot; replacesAppointmentId: string | null })
  | (PendingBase & { kind: 'cancel'; appointmentId: string });

/**
 * Everything the backend knows about one call. GPT-Live keeps the conversation;
 * this keeps the facts that decide what is allowed: who the caller is, what was
 * offered, what is waiting for a yes, and which request is current.
 */
export class CallState {
  readonly turns: Turn[] = [];
  verifiedPatient: { id: string; firstName: string; phone: string | null } | null = null;
  verifyAttempts = 0;
  /** Slots the caller has actually been offered. A booking can only use one of these. */
  readonly offered = new Map<string, Slot>();
  pending: PendingChange | null = null;
  proposals = 0;
  /** Bumped on every delegation. Work finishing under an old revision is discarded. */
  revision = 0;
  emergency: { kind: string; atMs: number } | null = null;
  /** Every emergency kind already answered, so a new kind (bleeding after chest pain) is answered too. */
  readonly emergencyKinds = new Set<string>();
  outcome: 'booked' | 'rescheduled' | 'cancelled' | 'task_created' | 'transferred' | 'info' | 'emergency' | 'abandoned' = 'abandoned';

  /** Transcript deltas arrive in fragments; consecutive fragments from one speaker join into one turn. */
  addTranscript(speaker: Turn['speaker'], delta: string, startMs: number, endMs: number) {
    const last = this.turns.at(-1);
    const startsTurn = !last || last.speaker !== speaker;
    if (startsTurn && speaker === 'agent' && this.pending && this.pending.readbackAtMs === null && startMs >= this.pending.proposedAtMs) {
      this.pending.readbackAtMs = startMs;
    }
    if (last && last.speaker === speaker) {
      last.text = `${last.text}${delta.startsWith(' ') || last.text.endsWith(' ') ? '' : ' '}${delta}`.replace(/\s+/g, ' ');
      last.endMs = endMs;
    } else {
      this.turns.push({ speaker, text: delta.trim(), startMs, endMs });
    }
  }

  /**
   * The caller's latest turn after the read-back began, for the confirmation check.
   * Only the latest: "hmm, maybe" followed later by a clear "yes" is a yes, and a
   * "yeah" said before the read-back never counts.
   */
  answerToReadback(): string {
    const at = this.pending?.readbackAtMs;
    if (at === null || at === undefined) return '';
    return this.turns.filter((t) => t.speaker === 'caller' && t.startMs > at).at(-1)?.text ?? '';
  }

  /** The last stretch of caller speech, for the emergency guardrail's rolling window. */
  recentCallerText(chars = 240): string {
    const text = this.turns.filter((t) => t.speaker === 'caller').slice(-3).map((t) => t.text).join(' ');
    return text.slice(-chars);
  }

  lastMs(): number {
    return this.turns.at(-1)?.endMs ?? 0;
  }
}
