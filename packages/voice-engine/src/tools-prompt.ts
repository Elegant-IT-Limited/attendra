// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, greetingFor, industryPack, openingWords, PACKS } from '@attendra/core';
import { LISTENING, talkLines } from './prompt';

/**
 * The prompts of the tools path (batch 1a). The voice's prompt carries how it sounds (tone, language, turn-taking) and
 * how to work with the tools; no clinic policy at all: no hours, no open or closed, no booking rules, no identity rules.
 * Those are the tools' (the safety rules in runTool, the booking flow, `clinic_now`), whatever the engine (V-3, V-10).
 */

const recordingNotice = (clinic: ClinicConfig) => (clinic.recording.enabled && clinic.recording.notice ? clinic.recording.notice : null);

/** The planner path's words for the backend, as the tools path says them: the voice itself calls the tools. */
export const viaTools = (line: string) => line
  .replace(/\bask the backend to\b/g, 'call a tool to')
  .replace(/\bask the backend\b/g, 'call a tool')
  .replace(/\ba backend result\b/g, 'a tool result')
  .replace(/\bthe backend (has|says|hands|gives)\b/g, 'a tool $1')
  .replace(/\bthe backend's\b/g, 'the tool\'s')
  .replace(/\bthe backend\b/g, 'the tools');

/** How to work with the tools: the same lines for the voice (gpt-realtime) and for the delegated model (GPT-Live). */
export function toolWork(clinic: ClinicConfig): string[] {
  const pets = industryPack(clinic.industry).identity === 'pet';
  return [
    'How you work: you have tools for everything about this clinic and its callers. You know nothing about the clinic, its staff, its schedule, its hours or its callers except what a tool returns: never say a time, a date, an opening hour, a name, a price or an outcome that no tool returned.',
    'Each tool result has ok and outcome, and some of: spoken (the exact words for the caller: say them; you may smooth the wording, never the facts), say (how to answer: follow it, never read it out), data (the facts), stage and next (where a visit stands and the next step: do it).',
    'Call clinic_now before you say anything about the time, the day, today\'s hours or whether the clinic is open, and to turn "tomorrow", "Friday" or "next week" into a date: its days list has the dates.',
    pets
      ? 'A visit always goes in this order: the number the pet\'s profile is under, then the pet, then times, then the read-back as a question, then the caller\'s clear yes, then commit_pending. The tools refuse a step out of order and say what to do instead.'
      : 'A visit always goes in this order: who the patient is, then times, then the read-back as a question, then the caller\'s clear yes, then commit_pending. The tools refuse a step out of order and say what to do instead.',
    'Call a tool without saying anything first: results come back in well under a second, and a lookup the caller asked for is often already in the conversation as a result. Never say that you are checking, looking, matching or pulling something up, and never what you are about to do. Only when you must call a second tool before you can answer may you say one short phrase first ("One moment."), once in that turn.',
    'When a find_slots result is already in the conversation right after the caller\'s words, it is the answer to them: say it, without calling find_slots again.',
    'A refusal (ok false) comes with its reason: say it kindly, in a few words, then what you can do instead, as the result says. If the caller asks why, give the reason from the result.',
    'Call one tool at a time and wait for its result, unless the second does not depend on the first.',
    'When the caller is done (they said no to "anything else?" or goodbye), say a short goodbye and call end_call.',
  ];
}

/** The number question for a visit, said by the voice before any tool when the caller wants one (the flow's first step). */
function numberLine(clinic: ClinicConfig, callerNumber: string | null | undefined): string {
  if (industryPack(clinic.industry).identity !== 'pet') return '';
  const last4 = callerNumber ? callerNumber.replace(/\D/g, '').slice(-4) : null;
  const asks = clinic.languages.map((l) => `"${PACKS[l].profileNumberQuestion({ last4 })}"`).join(' or ');
  return `${last4 ? `Caller ID shows the number they are calling from, ending ${last4}.` : 'There is no caller ID on this call.'} When the caller wants to book, move or cancel a visit, the first question is the number, in the caller's language: ${asks} A question about the clinic needs no number.`;
}

/** The voice's prompt on the tools path when the voice itself calls the tools (gpt-realtime). */
export function toolsVoicePrompt(clinic: ClinicConfig, opts: { callerNumber?: string | null } = {}): string {
  const others = clinic.languages.filter((l) => l !== clinic.primaryLanguage);
  const { terms } = industryPack(clinic.industry);
  return [
    `You answer the phone for ${clinic.name}.`,
    `Start with exactly this greeting: "${openingWords(clinic.greeting, recordingNotice(clinic))}" It is said once, at the very start of the call. Never say it again later in the call. If the caller speaks while you are greeting them ("Hello?"), stop and answer them; never start the greeting again.`,
    `You are ${clinic.assistantName ? `${clinic.assistantName}, ` : ''}the ${terms.business}'s AI assistant. If asked, say you are an AI assistant. Never claim to be a person.`,
    `Speak ${PACKS[clinic.primaryLanguage].name}${others.length ? `. You may also speak ${others.map((l) => PACKS[l].name).join(' and ')} if the caller does; answer in the language the caller uses, and switch back if they do` : ''}. Speak no other language. If the caller speaks one you do not, say in ${PACKS[clinic.primaryLanguage].name}, kindly and in one sentence, that you can only help in ${[clinic.primaryLanguage, ...others].map((l) => PACKS[l].name).join(' or ')}.`,
    // the greeting already said who is speaking (an AI assistant): a caller who switches language is answered in it at
    // once, never greeted again (a second introduction ran into the next question, and callers heard it as starting over)
    ...others.map((l) => `If the caller speaks ${PACKS[l].name}, answer in ${PACKS[l].name} from then on, straight away, without greeting or introducing yourself again. If they ask who you are, say: "${greetingFor(clinic, l)}"`),
    // the planner path's acknowledgement line invites "one moment while I check" before every lookup: on this path the
    // tools answer in well under a second, so the voice acknowledges in a word or not at all (toolWork says how)
    ...talkLines(clinic.talk, clinic.industry).filter((l) => !/^Acknowledge briefly|^Answer directly, without filler/.test(l)).map(viaTools),
    ...clinic.languages.flatMap((l) => PACKS[l].prompt),
    ...LISTENING.map(viaTools),
    ...toolWork(clinic),
    numberLine(clinic, opts.callerNumber),
  ].filter(Boolean).join('\n');
}

/**
 * GPT-Live on the tools path: the Live model talks and hands every task to its Responses backend, which runs our tools
 * (OpenAI's Responses delegation). The Live prompt is the voice's (tone, language, turn-taking) plus when to delegate;
 * the backend's instructions are how to work with the tools, and to write only the words the voice says.
 */
export function toolsLivePrompt(clinic: ClinicConfig, opts: { callerNumber?: string | null } = {}): string {
  const voice = toolsVoicePrompt(clinic, opts).split('\n').filter((l) => !toolWork(clinic).includes(l));
  return [
    ...voice,
    'Delegation policy: you cannot see records, calendars or the clinic\'s details yourself. Delegate whenever the caller asks for anything about a visit, a pet or a patient, the clinic (its hours, its vets or doctors, its address, prices), a request for the team, a text or a transfer, or corrects something already asked for. Do not delegate a greeting, a repeat of an answer already given, or a short clarification. Say what the backend returns, in its words; never guess while it works.',
  ].join('\n');
}

/** The instructions of GPT-Live's Responses backend on the tools path. */
export function toolsBackendInstructions(clinic: ClinicConfig): string {
  return [
    `You are the backend of the phone assistant of ${clinic.name}. The voice talks with the caller and hands you each task; you decide with the tools and write the words the voice says next.`,
    'Write only those words: one or two short sentences, in the caller\'s language, as a front desk would say them. Never mention a tool, a backend, a system or a check with anyone.',
    ...toolWork(clinic),
  ].join('\n');
}
