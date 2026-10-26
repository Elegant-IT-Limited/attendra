// SPDX-License-Identifier: AGPL-3.0-only
import type { LanguagePack } from './types';

const when = (start: Date, timeZone: string) => {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(start);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(start);
  return `${day} at ${time}`;
};

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * A text to one person: "Hi Sam, Scout's check-up with Dr. Ruiz…" when the call gave the names,
 * "Your visit…" when it did not. name is the person the text goes to (the owner, the patient or the
 * parent), pet the pet, provider the vet or doctor, visit the kind of visit (pets only: a person's visit
 * type is never put in a text). Each is left out when unknown, never shown empty.
 */
const hi = (v: Record<string, string>, rest: string) => (v.name ? `Hi ${v.name}, ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1));
const whose = (v: Record<string, string>) => (v.pet ? `${v.pet}'s` : 'your');
const visitOf = (v: Record<string, string>) => `${whose(v)} ${v.visit || 'visit'}${v.provider ? ` with ${v.provider}` : ''}`;

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
    booking_confirmed: (v) => `${v.clinic}: ${hi(v, `${visitOf(v)} is booked for ${v.when}.`)} To change or cancel, call ${v.clinicPhone}. Reply STOP to opt out.`,
    request_ready: (v) => `${v.clinic}: ${hi(v, `${whose(v)} request is ready to pick up.`)} Questions? Call ${v.clinicPhone}. Reply STOP to opt out.`,
    refill_sent: (v) => `${v.clinic}: ${hi(v, `${whose(v)} request was sent to ${v.pharmacy}.`)} Questions? Call ${v.clinicPhone}. Reply STOP to opt out.`,
    refill_not_approved: (v) => `${v.clinic}: ${hi(v, `about ${whose(v)} recent request, please call us on ${v.clinicPhone}.`)} Reply STOP to opt out.`,
    change_confirmed: (v) => `${v.clinic}: ${hi(v, `${visitOf(v)} has moved to ${v.when}.`)} To change or cancel, call ${v.clinicPhone}. Reply STOP to opt out.`,
    cancel_confirmed: (v) => `${v.clinic}: ${hi(v, `${visitOf(v)} on ${v.when} is cancelled.`)} To book again, call ${v.clinicPhone}. Reply STOP to opt out.`,
    directions: (v) => `${v.clinic}: ${v.address}. Map: ${v.mapUrl}. Reply STOP to opt out.`,
    hours: (v) => `${v.clinic} hours: ${v.hours}. Reply STOP to opt out.`,
    emergency_hospital: (v) => `${v.clinic}: emergency vet: ${v.hospital}, ${v.hospitalAddress}, ${v.hospitalPhone}. If a person is hurt or in danger, call ${v.emergencyNumber}. Reply STOP to opt out.`,
    provider: (v) => `${v.clinic}: ${v.provider}${v.details ? `, ${v.details}` : ''}. Questions? Call ${v.clinicPhone}. Reply STOP to opt out.`,
    answer: (v) => `${v.clinic}: ${v.answer} Questions? Call ${v.clinicPhone}. Reply STOP to opt out.`,
    link: (v) => `${v.clinic}: ${v.label}: ${v.url} Reply STOP to opt out.`,
    reminder: (v) => `${v.clinic}: ${hi(v, `a reminder of ${visitOf(v)} on ${v.when}.`)} Reply C to confirm, or call ${v.clinicPhone} to change it. Reply STOP to opt out.`,
  },
  textOffer: ({ target }) => (target === 'file' ? 'Would you like me to text that to the number on your file?' : "Would you like me to text that to the number you're calling from?"),
  textSent: "Done, I've just sent it.",
  textRefused: ({ reason }) => (reason === 'opted_out' ? "That number has asked not to get texts from us, so I'll read it out instead." : "I can't send texts, so I'll say it slowly."),
  reminderOffer: 'Would you like a reminder text the day before the visit? Message and data rates may apply, and you can reply STOP anytime.',
  refillTextOffer: 'Would you like a text at that number when the team has decided? Message and data rates may apply, and you can reply STOP anytime.',
  phoneQuestion: ({ callerId }) => (callerId ? "Is the number you're calling from the best one for you?" : "What's the best number to reach you?"),
  confirmTextNote: ({ target }) => (target === 'calling' ? "I'll text you a confirmation at the number you're calling from, unless you'd rather not" : "I'll text you a confirmation at the number on file, unless you'd rather not"),
  smsConfirmed: ({ clinic, when }) => `${clinic}: thank you, your visit on ${when} is confirmed.`,
  shortDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  smsNoReplies: ({ clinicPhone }) => `This number does not read replies. Please call ${clinicPhone}.`,
  abuseWarning: 'I want to help you, but if this language continues I will need to end the call. I can also have someone from the clinic call you back.',
  abuseGoodbye: 'I\'m going to end the call now. You\'re welcome to call back any time. Goodbye.',
  takeOver: 'I\'m connecting you with a member of our team now.',
  tooSlow: 'I\'m sorry, that\'s taking longer than it should. I can have someone from the clinic call you back about it, if you\'d like.',
  couldNotFinish: 'I\'m sorry, I couldn\'t complete that just now. I can have someone from the clinic call you back.',
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
    ['breathing', /\b(can'?t|cannot|can not|hard to|trouble|struggling to) breathe?\b|\b(not|isn'?t|wasn'?t) breathing\b|\bshort(ness)? of breath\b|\bchoking\b/],
    ['stroke', /\b(stroke|face (is )?droop(ing)?|slurr(ed|ing) (speech|words)|can'?t (move|feel) (my )?(arm|leg|face))\b/],
    ['bleeding', /\b(won'?t stop bleeding|bleeding (a lot|heavily|badly)|lots of blood|coughing (up )?blood|vomiting blood)\b/],
    ['unresponsive', /\b(unconscious|passed out|not (waking|responding)|unresponsive|seizure|fitting)\b/],
    ['self_harm', /\b(kill (myself|me)|end (it all|my life)|suicid(e|al)|hurt myself|(don'?t|do not) (really |even )?want to (live|be alive|be here)( anymore)?|better off dead)\b/],
    ['overdose', /\b(overdos(e|ed|es|ing)|took too (many|much)|took a (whole|full) bottle|swallowed (a bottle|the whole|bleach|poison)|poison(ed|ing|ous)?|drank (bleach|poison))\b/],
    ['allergic', /\b(throat (is )?(closing|swelling)|anaphyla(xis|ctic)|tongue (is )?swelling)\b/],
    ['general', /\b(emergency|call (an )?ambulance|911)\b/],
  ],
  // also a question about emergencies, not a report of one: "is this an emergency?", "what counts as an emergency?"
  notAnEmergency: /\b(not an? emergency|isn'?t an emergency|no emergency|not urgent|is (this|that|it) an emergency|counts? as an emergency|emergency (fees?|charges?|prices?|costs?|policy))\b/,
  yes: /\b(yes|yeah|yep|yup|correct|that'?s (right|correct|fine|good|perfect)|sounds good|perfect|please do|go ahead|book it|do it|sure)\b/,
  yesAlone: /^(ok|okay|confirm|confirmed)$/,
  hedge: /\b(no|nope|not|don'?t|wait|actually|hold on|hmm|maybe|instead|rather|change|different|other|but|although|though)\b|\?/,
  markers: /\b(the|and|you|my|is|appointment|please|thank|what|when|book|need|want|have|can|this|that|to|for|with)\b/g,
  saysNew: /(?<!\bwhat)\b(is|are|am|'s|'re|'m) (brand |completely |totally )?new\b(?! (phone|number|cell|mobile|address|email))|\b((a |an )?new (patient|client|pet)|new (here|to (you|the clinic|your clinic|this clinic|the practice))|not (registered|on file|in (your|the) (system|records))|(never|not|hasn'?t|haven'?t|isn'?t|wasn'?t) (been )?(registered|been (there|here|in|to (you|the clinic|your clinic|this clinic)))|first (time|visit) (here|with you|at (the|your) clinic)|(his|her|their|its|a) first (check-?up|visit|exam)|just (adopted|got (a|him|her|them|my|our))|(want|like|need) to register|register (my|our|a|him|her|them))\b/,
  saysOnFile: /\b((not|isn'?t|aren'?t) new|already (a |an )?(patient|client|registered|on file|in (your|the) (system|records))|(has|have|'s|'ve) been (there|here|in|to (you|the clinic|your clinic|this clinic)) before|(might|may|could|should) (already )?be (on file|registered|in (your|the) (system|records)))\b/,
};
