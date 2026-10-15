// SPDX-License-Identifier: AGPL-3.0-only

export const INDUSTRIES = ['clinic'] as const;
export type Industry = (typeof INDUSTRIES)[number];

/**
 * What things are called in one industry, in English: the dashboard and the
 * conversation prompt are written in English whatever languages callers speak.
 */
export interface Terms {
  /** The place callers ring: "clinic". */
  business: string;
  /** Who a booking is for: "patient", "patients". */
  patient: string;
  patients: string;
  /** Who can be booked: "doctor", "doctors". */
  provider: string;
  providers: string;
}

/**
 * Everything one industry adds to the engine, as data. The engine (booking, the
 * identity check, the emergency guardrail, requests, knowledge, the audit log) is
 * the same for every industry; a pack only names things and adds the lines of the
 * conversation prompt that depend on the trade. Adding an industry means adding one
 * of these, with its evals; docs/industries.md explains how.
 */
export interface IndustryPack {
  id: Industry;
  /** For the dashboard and the docs. */
  name: string;
  terms: Terms;
  /** Lines for the conversation prompt, each in its place. */
  prompt: {
    /** How to find out who a booking is for and how to look them up, or add them. */
    identify: string[];
    /** Preferences a caller may have about who they see. */
    preferences: string[];
    /** What the assistant must never do in this trade. */
    limits: string[];
  };
}
