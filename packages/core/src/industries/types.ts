// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from 'zod';
import type { EmergencyPhrases } from '../emergency';
import type { Language } from '../locales/types';
import type { ToolName } from '../tools';

export const INDUSTRIES = ['clinic', 'vet'] as const;
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

/** Where an emergency script sends the caller: the clinic's emergency hospital, when it set one, and the emergency number. */
export interface EmergencyDestination {
  hospital: { name: string; phone: string; address: string } | null;
  emergencyNumber: string;
  /** The clinic texts the hospital's details: offer it once, after the script. */
  textOffer?: boolean;
}

/**
 * Everything one industry adds to the engine, as data. The engine (booking, the
 * identity check, the emergency guardrail, requests, knowledge, the audit log) is
 * the same for every industry; a pack names things, says how a caller is
 * identified, adds the trade's emergencies, and adds the prompt lines that depend on
 * the trade. Adding an industry means adding one of these, with its evals;
 * docs/industries.md explains how.
 */
export interface IndustryPack {
  id: Industry;
  /** For the dashboard and the docs. */
  name: string;
  terms: Terms;
  /**
   * Who a booking is for and how they are found. `person`: the patient's full name,
   * date of birth and phone. `pet`: the owner's name, the pet's name and the owner's
   * phone; the record is the pet's, with the owner as its guardian.
   */
  identity: 'person' | 'pet';
  /** Lines for the conversation prompt, each in its place. */
  prompt: {
    /** How to find out who a booking is for and how to look them up, or add them. */
    identify: string[];
    /** Preferences a caller may have about who they see. */
    preferences: string[];
    /** What the assistant must never do in this trade. */
    limits: string[];
  };
  /** Lines for the backend planner's instructions. */
  planner: {
    /** Identity, choosing who to book with, and passing details on as said. */
    rules: string[];
    /** What the backend must never do in this trade. */
    limits: string[];
    /** Tool descriptions that differ from the clinic's. */
    descriptions?: Partial<Record<ToolName, string>>;
  };
  /** Tool arguments that differ from the clinic's (the identity tools, for pets). */
  toolArgs?: Partial<Record<ToolName, z.ZodType>>;
  /**
   * Emergencies of the trade (an animal in danger), checked before the language's own.
   * The person on the phone is still covered by the engine's list: chest pain or
   * self-harm gets the engine's script, whatever the pack.
   */
  emergency?: {
    phrases: EmergencyPhrases;
    /** The fixed instruction for the trade's emergencies, in the caller's language. */
    script: (language: Language, to: EmergencyDestination) => string;
    /**
     * What a caller says when the animal is safe after all ("he's fine now", "it's not an
     * emergency"). Heard after the script, it lets the call go on. Never for a person in danger.
     */
    safe?: Partial<Record<Language, RegExp>>;
  };
}
