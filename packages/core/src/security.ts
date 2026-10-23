// SPDX-License-Identifier: AGPL-3.0-only
import { normalise } from './locales';
import { TOOL_NAMES } from './tools';

/**
 * Security on the phone, in code: no model is trusted to keep its own rules when a caller
 * pushes. Three checks, each on what was said, never on the model's view of it:
 * - a caller trying to change the assistant's rules or get at its instructions;
 * - the assistant saying something it must never say (its tools, its instructions, the
 *   companies behind it);
 * - card and social security numbers, which are cut out of everything we keep.
 */

/** "Ignore your instructions", "repeat your system prompt", "you are now in developer mode", in English and Spanish. */
const INJECTION = new RegExp([
  String.raw`\b(ignore|forget|disregard|override|bypass)\b.{0,30}\b(instructions?|rules?|prompt|programming|guidelines|previous|above)\b`,
  String.raw`\b(system|developer|hidden|secret|initial)\s+(prompt|message|instructions?)\b`,
  String.raw`\b(repeat|read|tell|show|print|say|recite|list)\b.{0,25}\b(your|the)\s+(instructions|prompt|rules|tools|functions|configuration|settings)\b`,
  String.raw`\b(developer|debug|admin|maintenance|test|god|jailbreak)\s+mode\b`,
  String.raw`\b(you are|you're) now\b`,
  String.raw`\bpretend (to be|you are)\b`,
  String.raw`\b(last|previous|other) (caller|client|customer|person)'?s?\b.{0,30}\b(details|number|name|address|information|record)`,
  String.raw`\b(ignora|olvida)\b.{0,30}\b(instrucciones|reglas)\b`,
  String.raw`\bmodo (desarrollador|administrador|prueba)\b`,
  String.raw`\b(dime|digame|repite|repita|lee|lea)\b.{0,20}\b(tus|sus) (instrucciones|reglas)\b`,
].join('|'));

/** Someone on the phone claiming a role that would open records: staff, a vet, support, the owner of the business, the police. */
const AUTHORITY = /\b(this is|i'?m|i am|calling from|soy|llamo de)\b.{0,30}\b(dr\.?|doctor|the vet|veterinarian|receptionist|front desk|practice manager|clinic manager|office manager|the owner of the (clinic|practice|hospital)|it department|tech support|support team|attendra|the police|police officer|detective|fbi|soporte|polic[ií]a)\b/;

/** The caller is trying to change the assistant's rules or get at its instructions. */
export function isInjectionAttempt(callerText: string): boolean {
  return INJECTION.test(normalise(callerText));
}

/** The caller says they are staff, a vet, support or the police: a role that would open records if it were believed. */
export function claimsAuthority(callerText: string): boolean {
  return AUTHORITY.test(normalise(callerText));
}

const VENDORS = /\b(openai|open ai|chatgpt|chat gpt|gpt[- ]?\d|gpt-live|gpt live|realtime api|anthropic|claude|gemini|google ai|twilio|attendra|elegant tech|elegant it|large language model|language model|llm)\b/;
const INTERNALS = /\b(system prompt|my (instructions|prompt|programming|rules say)|developer message|delegat(e|ion)|the backend|function call|tool call|json)\b/;
const TOOLS = new RegExp(`\\b(${TOOL_NAMES.join('|')})\\b`);

/** What in the assistant's words it must never say: a tool's name, its instructions, a company or model behind it. Null when nothing. */
export function leakIn(agentText: string): string | null {
  const t = normalise(agentText);
  return TOOLS.exec(t)?.[0] ?? VENDORS.exec(t)?.[0] ?? INTERNALS.exec(t)?.[0] ?? null;
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

/**
 * A card number (13 to 19 digits that pass the Luhn check, however spaced) or a social
 * security number (3-2-4) cut out of a line we keep. Phone numbers, dates and times are
 * left alone: a 10- or 11-digit phone never passes as a card, and an SSN needs its dashes
 * or spaces in place.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[card number removed]' : m))
    .replace(/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, '[SSN removed]');
}
