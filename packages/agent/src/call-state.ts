// SPDX-License-Identifier: AGPL-3.0-only
import type { Language, Slot } from '@attendra/core';

export interface Turn { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }

interface PendingBase {
  readback: string;
  seq: number; // one per proposal, so rebooking the same slot later in a call gets a fresh idempotency key
  proposedAtMs: number;
  /** When the assistant first spoke after the proposal: the read-back itself. Null until it is spoken. */
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
  /** The on-call transfer an emergency asks for has been queued: it rings once per call. */
  emergencyTransferSent = false;
  /** Staff pressed End call: the record says so, not that the assistant hung up on its own. */
  endedByStaff = false;
  /** Every emergency kind already answered, so a new kind (bleeding after chest pain) is answered too. */
  readonly emergencyKinds = new Set<string>();
  /**
   * The language the caller is being answered in: the clinic's primary language until
   * the caller's own words say otherwise. Read-backs, texts and the emergency script
   * follow it.
   */
  language: Language = 'en';
  outcome: 'booked' | 'rescheduled' | 'cancelled' | 'task_created' | 'transferred' | 'info' | 'emergency' | 'abandoned' = 'abandoned';

  /** Transcript deltas arrive in fragments; consecutive fragments from one speaker join into one turn. */
  addTranscript(speaker: Turn['speaker'], delta: string, startMs: number, endMs: number) {
    const last = this.turns.at(-1);
    // The assistant often starts talking ("Sure, let me book that") before the proposal
    // is back and reads it out in the same breath, so any assistant speech after the
    // proposal counts as the read-back, not only a new turn.
    if (speaker === 'agent' && this.pending && this.pending.readbackAtMs === null && endMs > this.pending.proposedAtMs) {
      this.pending.readbackAtMs = Math.max(startMs, this.pending.proposedAtMs);
    }
    if (last && last.speaker === speaker) {
      last.text = `${last.text}${delta.startsWith(' ') || last.text.endsWith(' ') ? '' : ' '}${delta}`.replace(/\s+/g, ' ');
      last.endMs = endMs;
    } else {
      this.turns.push({ speaker, text: delta.trim(), startMs, endMs });
    }
  }

  /**
   * The caller's latest words after the read-back began, for the confirmation check.
   * Only the latest: "hmm, maybe" followed later by a clear "yes" is a yes, and a
   * "yeah" said before the read-back never counts. Sounds the transcriber marks in
   * brackets ([breath], [clear throat]) are not words, so they change nothing.
   */
  answerToReadback(): string {
    const at = this.pending?.readbackAtMs;
    if (at === null || at === undefined) return '';
    const said = this.turns
      .filter((t) => t.speaker === 'caller' && t.startMs > at)
      .map((t) => t.text.replace(/\[[^\]]*(\]|$)/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return said.at(-1) ?? '';
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
