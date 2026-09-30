// SPDX-License-Identifier: AGPL-3.0-only
import type { LanguagePack } from './types';

const when = (start: Date, timeZone: string) => {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(start);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(start);
  return `${day} at ${time}`;
};

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export const en: LanguagePack = {
  code: 'en',
  name: 'English',
  nativeName: 'English',
  locale: 'en-US',
  prompt: [
    'In English, say dates and times the way they are given to you.',
  ],
  greeting: ({ assistantName, clinicName }) => `Thanks for calling ${clinicName}. ${assistantName ? `I'm ${assistantName}, the` : "I'm the"} clinic's AI assistant. How can I help you today?`,
  disclosure: /\b(ai|artificial intelligence|automated|virtual)\b.{0,20}\b(assistant|receptionist|agent)\b/i,
  speakWhen: when,
  speakPhone: (e164) => e164.replace(/\D/g, '').split('').map((d) => DIGITS[Number(d)]).join(' '),
  readbackBooking: ({ when: w, provider, providerKind, visit, replacing }) =>
    `${w} ${providerKind === 'room' ? `in the ${provider.replace(/^the /i, '').replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase())}` : `with ${provider}`} for ${/^[aeiou]/i.test(visit) ? 'an' : 'a'} ${visit}${replacing ? `, moving it from ${replacing}` : ''}`,
  readbackCancel: ({ when: w }) => `cancel the appointment on ${w}`,
  sms: {
    booking_confirmed: (v) => `${v.clinic}: you're booked for ${v.when}. To change or cancel, call ${v.clinicPhone}.`,
  },
  emergencyScript: (n) =>
    'The caller may be describing a medical emergency. Stop the current task now. Say, calmly and clearly: ' +
    `"If this is a medical emergency, please hang up and call ${n} right away." ` +
    'Do not give medical advice, do not ask about symptoms, and do not continue booking. ' +
    'If the caller says they are safe and it is not an emergency, you may continue.',
  selfHarmScript: (n, crisis) =>
    'The caller may be at risk of harming themselves. Stop the current task. Say, calmly and kindly: ' +
    `"I'm really glad you called. If you are in danger right now, please call ${n}.` +
    (crisis ? ` You can also call or text ${crisis} to reach the Suicide and Crisis Lifeline, any time, day or night."` : '"') +
    ' Stay warm and brief. Do not give medical advice.',
  emergencyPhrases: [
    ['cardiac', /\b(chest (pain|pressure|tightness|hurts?)|heart attack|pain (in|down) my (left )?arm)\b/],
    ['breathing', /\b(can'?t|cannot|can not|hard to|trouble|struggling to) breathe?\b|\bnot breathing\b|\bshort(ness)? of breath\b|\bchoking\b/],
    ['stroke', /\b(stroke|face (is )?droop(ing)?|slurr(ed|ing) (speech|words)|can'?t (move|feel) (my )?(arm|leg|face))\b/],
    ['bleeding', /\b(won'?t stop bleeding|bleeding (a lot|heavily|badly)|lots of blood|coughing (up )?blood|vomiting blood)\b/],
    ['unresponsive', /\b(unconscious|passed out|not (waking|responding)|unresponsive|seizure|fitting)\b/],
    ['self_harm', /\b(kill (myself|me)|end (it all|my life)|suicid(e|al)|hurt myself|(don'?t|do not) (really |even )?want to (live|be alive|be here)( anymore)?|better off dead)\b/],
    ['overdose', /\b(overdos(e|ed|es|ing)|took too (many|much)|took a (whole|full) bottle|swallowed (a bottle|the whole|bleach|poison)|poison(ed|ing|ous)?|drank (bleach|poison))\b/],
    ['allergic', /\b(throat (is )?(closing|swelling)|anaphyla(xis|ctic)|tongue (is )?swelling)\b/],
    ['general', /\b(emergency|call (an )?ambulance|911)\b/],
  ],
  notAnEmergency: /\b(not an? emergency|isn'?t an emergency|no emergency|not urgent)\b/,
  yes: /\b(yes|yeah|yep|yup|correct|that'?s (right|correct|fine|good|perfect)|sounds good|perfect|please do|go ahead|book it|do it|sure)\b/,
  yesAlone: /^(ok|okay|confirm|confirmed)$/,
  hedge: /\b(no|nope|not|don'?t|wait|actually|hold on|hmm|maybe|instead|rather|change|different|other|but|although|though)\b|\?/,
  markers: /\b(the|and|you|my|is|appointment|please|thank|what|when|book|need|want|have|can|this|that|to|for|with)\b/g,
};
