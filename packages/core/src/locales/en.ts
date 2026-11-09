// SPDX-License-Identifier: AGPL-3.0-only
import { clock12, dateParts, wallClock } from './dates';
import { type Clock, type LanguagePack, type OfferDay, type Pronoun } from './types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Wednesday, November 4". */
const fullDay = (date: string) => { const d = dateParts(date); return `${WEEKDAYS[d.weekday]}, ${MONTHS[d.month - 1]} ${d.day}`; };
const period = (hour: number) => (hour < 12 ? 'AM' : 'PM');
/** "Wednesday, November 4, at 5:20 PM": the weekday, the date and the time, every time, never the year. */
const fullWhen = (start: Date, timeZone: string) => {
  const w = wallClock(start, timeZone);
  const c = clock12(w.hour, w.minute);
  return `${fullDay(w.date)}, at ${c.hour}:${c.minutes} ${period(w.hour)}`;
};
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** "a, b or c". */
const orList = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : items[0] ?? '');
/** One day's times: "8:00, 8:40 or 9:20 AM"; AM or PM said once per run, and with each time when the vets differ. */
const dayTimes = (day: OfferDay) => {
  const withVets = day.times.some((t) => t.provider);
  return orList(day.times.map((t, i) => {
    const next = day.times[i + 1];
    const c = clock12(t.hour, t.minute);
    const showPeriod = withVets || !next || period(next.hour) !== period(t.hour);
    return `${c.hour}:${c.minutes}${showPeriod ? ` ${period(t.hour)}` : ''}${t.provider ? ` with ${t.provider}` : ''}`;
  }));
};

/** "a, b and c". */
const andList = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
/** "9", "9:30", the way a front desk says an hour in a sentence about hours ("from 9 to 1"). */
const hourWords = (t: Clock) => { const c = clock12(t.hour, t.minute); return t.minute ? `${c.hour}:${c.minutes}` : String(c.hour); };
/** "4:00 PM". */
const timeWords = (t: Clock) => { const c = clock12(t.hour, t.minute); return `${c.hour}:${c.minutes} ${period(t.hour)}`; };
/** Weekdays Monday first, runs of three or more as a range: "Wednesday to Friday and Sunday". */
const daysWords = (days: number[]) => {
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
  const runs: number[][] = [];
  for (const d of order) {
    const last = runs.at(-1);
    const prev = last?.at(-1);
    if (last && prev !== undefined && [1, 2, 3, 4, 5, 6, 0].indexOf(d) === [1, 2, 3, 4, 5, 6, 0].indexOf(prev) + 1) last.push(d); else runs.push([d]);
  }
  return andList(runs.flatMap((r) => (r.length >= 3 ? [`${WEEKDAYS[r[0]!]} to ${WEEKDAYS[r.at(-1)!]}`] : r.map((d) => WEEKDAYS[d]!))));
};
const subject = (provider: string, p: Pronoun) => (p === 'female' ? 'She\'s' : p === 'male' ? 'He\'s' : `${provider} is`);
const possessive = (provider: string, p: Pronoun) => (p === 'female' ? 'her' : p === 'male' ? 'his' : `${provider}'s`);
const noticeText = (hours: number) => (hours % 24 === 0 ? `${hours / 24} ${hours === 24 ? 'day' : 'days'}'` : `${hours} hours'`);
const capitalFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "a sick visit", "an exam". */
const withArticle = (s: string) => `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s}`;

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** A note written to follow a comma, said as a sentence of its own. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A text to one person: "Hi Sam, Scout's check-up with Dr. Ruiz…" when the call gave the names,
 * "Your visit…" when it did not. name is the person the text goes to (the owner, the patient or the
 * parent), pet the pet, provider the vet or doctor, visit the kind of visit (pets only: a person's visit
 * type is never put in a text). Each is left out when unknown, never shown empty.
 */
const hi = (v: Record<string, string>, rest: string) => (v.name ? `Hi ${v.name}, ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1));
const whose = (v: Record<string, string>) => (v.pet ? `${v.pet}'s` : 'your');
/** The request's number, so a caller and the team talk about the same one: " (R-1042)". */
const ref = (v: Record<string, string>) => (v.ref ? ` (${v.ref})` : '');
const visitOf = (v: Record<string, string>) => `${whose(v)} ${v.visit || 'visit'}${v.provider ? ` with ${v.provider}` : ''}`;

export const en: LanguagePack = {
  code: 'en',
  name: 'English',
  nativeName: 'English',
  locale: 'en-US',
  prompt: [
    'In English, say dates and times the way they are given to you.',
    'In English, warmth is short and plain: "mm-hm" or "okay" while they talk, "Oh no, I\'m sorry to hear that" for bad news.',
  ],
  greeting: ({ assistantName, clinicName }) => `Thanks for calling ${clinicName}. ${assistantName ? `I'm ${assistantName}, the` : "I'm the"} clinic's AI assistant. How can I help you today?`,
  disclosure: /\b(ai|artificial intelligence|automated|virtual)\b.{0,20}\b(assistant|receptionist|agent)\b/i,
  // in full every time (2026-11-14): "today at 2:30" left the date to the caller, and a move to the next week went unsaid
  speakWhen: (start, timeZone) => fullWhen(start, timeZone),
  fullWhen,
  fullDay,
  speakPhone: (e164) => e164.replace(/\D/g, '').split('').map((d) => DIGITS[Number(d)]).join(' '),
  readbackBooking: ({ when: w, provider, providerKind, visit, replacing, pet, shift }) => {
    const where = providerKind === 'room' ? `in the ${provider.replace(/^the /i, '').replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase())}` : `with ${provider}`;
    // a move says both times in full, and how the day shifts when it does
    return replacing
      ? `move ${pet ? `${pet}'s` : 'your'} ${visit.toLowerCase()} from ${replacing} to ${w} ${where}${shift ? `, ${shift}` : ''}`
      : `${w} ${where} for ${/^[aeiou]/i.test(visit) ? 'an' : 'a'} ${visit}`;
  },
  readbackCancel: ({ when: w }) => `cancel the appointment on ${w}`,
  sms: {
    booking_confirmed: (v) => `${v.clinic}: ${hi(v, `${visitOf(v)} is booked for ${v.when}.`)} To change or cancel, call ${v.clinicPhone}. Reply STOP to opt out.`,
    request_ready: (v) => `${v.clinic}: ${hi(v, `${whose(v)} request${ref(v)} is ready to pick up.`)} Questions? Call ${v.clinicPhone}. Reply STOP to opt out.`,
    refill_sent: (v) => `${v.clinic}: ${hi(v, `${whose(v)} request${ref(v)} was sent to ${v.pharmacy}.`)} Questions? Call ${v.clinicPhone}. Reply STOP to opt out.`,
    refill_not_approved: (v) => `${v.clinic}: ${hi(v, `about ${whose(v)} recent request${ref(v)}, please call us on ${v.clinicPhone}.`)} Reply STOP to opt out.`,
    change_confirmed: (v) => `${v.clinic}: ${hi(v, `${visitOf(v)} has moved ${v.from ? `from ${v.from} ` : ''}to ${v.when}.`)} To change or cancel, call ${v.clinicPhone}. Reply STOP to opt out.`,
    cancel_confirmed: (v) => `${v.clinic}: ${hi(v, `${visitOf(v)} on ${v.when} is cancelled.`)} To book again, call ${v.clinicPhone}. Reply STOP to opt out.`,
    vet_changed: (v) => `${v.clinic}: ${hi(v, `${whose(v)} ${v.visit || 'visit'} on ${v.when} is now with ${v.provider}, at the same time.`)} To change or cancel, call ${v.clinicPhone}. Reply STOP to opt out.`,
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
  noProviderForVisit: ({ visit, pets }) => `No ${pets ? 'vet' : 'doctor'} does ${visit}: callers can't book it`,
  textRefused: ({ reason }) => (reason === 'opted_out' ? "That number has asked not to get texts from us, so I'll read it out instead." : "I can't send texts, so I'll say it slowly."),
  reminderOffer: 'Would you like a reminder text the day before the visit? Message and data rates may apply, and you can reply STOP anytime.',
  refillTextOffer: 'Would you like a text at that number when the team has decided? Message and data rates may apply, and you can reply STOP anytime.',
  sameNumberQuestion: "Is the number you're calling from the best one for you?",
  callbackNumberQuestion: "What's the best number to reach you?",
  yourNameQuestion: 'And your name?',
  thanksOwner: ({ owner }) => `Thanks, ${owner}.`,
  whichPetVerified: ({ owner, names, more, offerNew }) => `Thanks, ${owner}. Is this for ${orList(names)}${more ? ', or another one' : offerNew ? ', or a new pet' : ''}?`,
  whichWeek: ({ first, second }) => `This ${fullDay(first)}, or ${fullDay(second)}?`,
  bookedByCallerNote: ({ name }) => `booked by caller: ${name}`,
  foundByLastFourNote: 'found on the call by the last four digits of the number and the pet\'s name',
  memory: {
    species: {
      dog: 'dog', puppy: 'dog', pup: 'dog', doggy: 'dog', cat: 'cat', kitten: 'cat', kitty: 'cat', rabbit: 'rabbit', bunny: 'rabbit',
      bird: 'bird', parrot: 'parrot', parakeet: 'parakeet', 'guinea pig': 'guinea pig', hamster: 'hamster', ferret: 'ferret',
      lizard: 'lizard', snake: 'snake', turtle: 'turtle', tortoise: 'tortoise',
    },
    female: /\b(female|a girl|(?:she|it)'?s a girl|spayed)\b/g,
    male: /\b(male|a boy|(?:he|it)'?s a boy|neutered)\b/g,
    she: /\b(she|her|she'?s)\b/,
    he: /\b(he|him|his|he'?s)\b/,
    age: /\b(\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen)[ -](years?|months?|weeks?)[ -]old\b/g,
    numbers: { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, eighteen: 18 },
    intent: {
      book: /\b(book|come in|bring (?:him|her|them|it) in|see (?:a|the) vet|schedule)\b/g,
      visit: /\b(appointment|check-?up|visit|exam)\b/g,
      want: /\b(need|needs|want|wants|wanted|like|get|make|due|have to|has to)\b/g,
      move: /\b(move|reschedule|change (?:it|the|my|that|his|her|our) (?:appointment|visit|time)|change it to|make it|another time instead)\b/g,
      cancel: /\b(cancel)\b/g,
    },
    weekdays: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    months: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
    today: /\b(today|this (?:afternoon|morning|evening))\b/g,
    tomorrow: /\b(tomorrow)\b/g,
    thisWord: 'this',
    nextWord: 'next',
    anyVet: /\b(any (?:family )?(?:doctor|vet|veterinarian|one)|anyone|anybody|whoever|no preference|(?:it )?doesn'?t matter (?:who|which))\b/g,
    anyDay: /\b(any ?day|first (?:available|opening|time)|earliest|soonest|whenever)\b/g,
    time: /\b(?:(at|around|about|after|before|earlier than|no later than|make it|move it to|change it to|how about|what about)\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*(a\.?m\b\.?|p\.?m\b\.?|in the (?:morning|afternoon|evening)|o'?clock))?(?!\s*(?:years?|months?|weeks?|days?|hours?|minutes?|pets?|dogs?|cats?|of)\b)(?![\d:-])/g,
    after: /^after$/,
    before: /^(?:before|earlier than|no later than)$/,
    around: /^(?:around|about)$/,
    pm: /p\.?m|afternoon|evening/,
    am: /a\.?m|morning/,
  },
  whichPet: ({ names, more }) => (names.length > 1
    ? `I see ${names.slice(0, -1).join(', ')} and ${names.at(-1)} under this number. Which one is it for${more ? ', or is it another one' : ', or is it a new pet'}?`
    : `I see ${names[0]} under this number. Is this for ${names[0]}, ${more ? 'or another one' : 'or a new pet'}?`),
  lastVisitSeen: ({ pet, when: w, provider, visit }) => `The last visit I can see for ${pet} was on ${w}${provider ? ` with ${provider}` : ''}${visit ? `, for ${/^[aeiou]/i.test(visit) ? 'an' : 'a'} ${visit.toLowerCase()}` : ''}.`,
  recordsOffer: "I can't go into medical details on the phone, but I can ask the team to send you the records in writing. Would you like that?",
  phoneAsGiven: ({ digits }) => `I have ${digits}. I'll keep it just as you gave it.`,
  petNewQuestion: ({ pet }) => `Is ${pet} new to us?`,
  profileNumberQuestion: ({ last4 }) => (last4 ? `Sure. Is your pet's profile under the number you're calling from, ending ${last4}?` : "Sure. What phone number is your pet's profile under?"),
  phoneReadback: ({ grouped }) => `That's ${grouped}?`,
  foundPet: ({ pet, species }) => (species ? `I found ${pet}, your ${species.toLowerCase()}.` : `I found ${pet}.`),
  notSeenPet: ({ pet }) => `I don't see ${pet} under that number.`,
  noPetsOnNumber: "I don't see a profile under that number.",
  numberNotOpened: "I can't open a profile with those details on this call. I can take a message so the team can call you back.",
  lastFourQuestion: ({ after }) => (after === 'no_profile'
    ? "What are the last four digits of the number the profile might be under, and your pet's name? Or if your pet is new to us, I can add them."
    : "Let's try another way. What are the last four digits of the number the profile is under, and your pet's name?"),
  lastFourNoMatch: "I couldn't find one profile with those details.",
  teamBooks: ({ visit, notice, related }) => `Our team books ${visit.toLowerCase()} themselves${notice ? `, with at least ${notice}' notice` : ''}. I can take a request for the team${related ? `, or book ${/^[aeiou]/i.test(related) ? 'an' : 'a'} ${related.toLowerCase()} first` : ''}. Which would you like?`,
  confirmTextNote: ({ target }) => (target === 'calling' ? "I'll text you a confirmation at the number you're calling from, unless you'd rather not" : "I'll text you a confirmation at the number on file, unless you'd rather not"),
  smsConfirmed: ({ clinic, when }) => `${clinic}: thank you, your visit on ${when} is confirmed.`,
  shortDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  smsNoReplies: ({ clinicPhone }) => `This number does not read replies. Please call ${clinicPhone}.`,
  abuseWarning: 'I want to help you, but if this language continues I will need to end the call. I can also have someone from the clinic call you back.',
  abuseGoodbye: 'I\'m going to end the call now. You\'re welcome to call back any time. Goodbye.',
  takeOver: 'I\'m connecting you with a member of our team now.',
  returnedCallLine: ({ clinic }) => `This is ${clinic}'s phone assistant. The clinic doesn't usually call out from this line, so the call you got may not have come from us. Are you a client of ${clinic}, or can I take a message for the team?`,
  slots: {
    exactFree: ({ date, time, provider }) => `Yes, ${timeWords(time)} on ${fullDay(date)} is free${provider ? ` with ${provider}` : ''}. Shall I book it?`,
    notAt: ({ time, day }) => `Not at ${clock12(time.hour, time.minute).hour}:${clock12(time.hour, time.minute).minutes}, but ${dayTimes(day)} on ${fullDay(day.date)}.`,
    nearest: ({ day }) => `The nearest ${day.times.length > 1 ? 'are' : 'is'} ${dayTimes(day)} on ${fullDay(day.date)}.`,
    vetHours: ({ provider, weekday, starts, ends }) => (starts
      ? `${provider} starts at ${hourWords(starts)} on ${WEEKDAYS[weekday]}s.`
      : `${provider} finishes at ${hourWords(ends!)} on ${WEEKDAYS[weekday]}s.`),
    frontDesk: ({ weekday, provider, from, to, clinicOpens, clinicCloses, oneDay }) => (oneDay
      ? `The clinic's front desk is closed on ${fullDay(oneDay)}, but ${provider} sees patients that day from ${hourWords(from)} to ${hourWords(to)}.`
      : clinicOpens && clinicCloses
      ? from.hour * 60 + from.minute < clinicOpens.hour * 60 + clinicOpens.minute
        ? `The clinic's front desk opens at ${hourWords(clinicOpens)} on ${WEEKDAYS[weekday]}s, but ${provider} sees patients from ${hourWords(from)}.`
        : `The clinic's front desk closes at ${hourWords(clinicCloses)} on ${WEEKDAYS[weekday]}s, but ${provider} sees patients until ${hourWords(to)}.`
      : `The clinic's front desk is closed on ${WEEKDAYS[weekday]}s, but ${provider} sees patients ${WEEKDAYS[weekday]} from ${hourWords(from)} to ${hourWords(to)}.`),
    doesntDoType: ({ provider, pronoun, visit, theirVisits, others }) => `${provider} doesn't do ${visit}; ${possessive(provider, pronoun)} visits are ${andList(theirVisits)}. `
      + (others.length ? `${andList(others)} ${others.length > 1 ? 'do' : 'does'} ${visit}. Shall I look with ${others.length > 1 ? 'them' : others[0]}?` : `Nobody here does ${visit} at the moment. Shall I take a request for the team?`),
    notWorkingThatDay: ({ provider, pronoun, weekday, days }) => `${provider} doesn't work on ${WEEKDAYS[weekday]}s. ${days.length ? `${subject(provider, pronoun)} in ${daysWords(days)}.` : `${subject(provider, pronoun)} not on the schedule this week.`}`,
    fullyBooked: ({ provider, date }) => `${provider ? `${provider} is` : 'We\'re'} fully booked on ${fullDay(date)}.`,
    nothingThrough: ({ provider, date }) => `I can't find a free time${provider ? ` with ${provider}` : ''} through ${fullDay(date)}.`,
    tooFarAhead: ({ visit, days, lastDate }) => `${capitalFirst(withArticle(visit))} can be booked up to ${days} days ahead, so the last day I can book it is ${fullDay(lastDate)}.`,
    notice: ({ visit, hours, firstDate }) => `${capitalFirst(withArticle(visit))} needs ${noticeText(hours)} notice, so the first day I can book it is ${fullDay(firstDate)}.`,
    clinicClosed: ({ date, note }) => `The clinic is closed on ${fullDay(date)}${note ? ` (${note})` : ''}.`,
  },
  tooSlow: 'I\'m sorry, that\'s taking longer than it should. I can have someone from the clinic call you back about it, if you\'d like.',
  couldNotFinish: 'I\'m sorry, I couldn\'t complete that just now. I can have someone from the clinic call you back.',
  spoken: {
    readback: ({ readback, textNote, move }) => (move
      ? `So I'd ${readback}. ${textNote ? `${sentence(textNote)}. ` : ''}Shall I go ahead?`
      : `I have ${readback}. ${textNote ? `${sentence(textNote)}. ` : ''}Shall I book it?`),
    cancelReadback: ({ readback, textNote }) => `So I'd ${readback}. ${textNote ? `${sentence(textNote)}. ` : ''}Is that right?`,
    done: ({ kind, textSent, then }) => `${kind === 'booked' ? 'All set, that\'s booked.' : kind === 'rescheduled' ? 'All set, it\'s moved.' : 'Done, that appointment is cancelled.'}${textSent ? ' I\'ve sent you a confirmation text.' : ''} ${then}`,
    anythingElse: 'Is there anything else I can help you with?',
    goodbye: 'Take care, goodbye!',
    callbackTaken: ({ sameNumber }) => `Okay, I've passed that on to the team, and someone will call you back at ${sameNumber ? 'this number' : 'the number you gave me'}. Is there anything else I can help you with?`,
    refillTaken: 'I\'ve sent the refill request to the team; they\'ll review it and get back to you. Is there anything else I can help you with?',
    urgentRequestTaken: 'I\'ve sent that to the team as urgent, and someone will call you back as soon as they can.',
    textSent: 'Done, I\'ve just sent it. Is there anything else I can help you with?',
    reminders: ({ agreed }) => `${agreed ? 'Great, you\'ll get a reminder text the day before the visit.' : 'No problem, no reminder texts.'} Is there anything else I can help you with?`,
    noVetForAnimal: ({ vet, animals, pet }) => `${vet && animals ? `${vet} sees ${animals} only` : 'None of our vets is listed for that kind of animal'}, so I can't book that here myself. Shall I take a request so the team can book ${pet}?`,
    noTransfer: 'I can\'t put you through right now, but I\'ll have the team call you back. What\'s it about?',
    lookingUp: ({ kind, day, pet }) => kind === 'times_on' && day ? `Let me check ${day}${/\d$/.test(day) ? ',' : ''} for you.`
      : kind === 'times' ? 'One moment, I\'ll look at the times.'
      : kind === 'pet' && pet ? `Let me find ${pet}.`
      : kind === 'visits' && pet ? `Let me look at ${pet}'s visits.`
      : kind === 'number' ? 'Let me check that number.'
      : 'Let me look that up.',
    oneMoment: 'One moment.',
    dayWord: ({ daysFromToday, weekday }) => (daysFromToday === 0 ? 'today' : daysFromToday === 1 ? 'tomorrow' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekday]!),
    offerTimes: ({ days, provider }) => {
      if (!days.length) return '';
      const [first, ...rest] = days.map((d) => ({ day: fullDay(d.date), times: dayTimes(d) }));
      const others = rest.map((d, i) => `${i === rest.length - 1 ? 'or ' : ''}on ${d.day}, ${d.times}`);
      return `On ${first!.day}, I have ${[first!.times, ...others].join(', ')}${provider ? ` with ${provider}` : ''}.`;
    },
    dayShift: ({ days, day }) => {
      const n = Math.abs(days);
      const phrase = days === 1 ? 'the next day' : days === -1 ? 'the day before'
        : n % 7 === 0 && n <= 28 ? `${n === 7 ? 'one week' : `${NUMBER_WORDS[n / 7]} weeks`} ${days > 0 ? 'later' : 'earlier'}`
          : n < 7 ? `${NUMBER_WORDS[n]} days ${days > 0 ? 'later' : 'earlier'}` : 'a different day';
      return `that's ${phrase}, ${day}`;
    },
  },
  petEmergencyNext: ({ pet, transfer }) => `I can't book a routine visit for ${pet ?? 'your pet'} while this is going on. ${transfer
    ? 'I can put you through to our team right now. Would you like that?'
    : 'I can send our team an urgent message to call you back as soon as they can. Would you like that?'}`,
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
    ['allergic', /\b(throat (is )?(closing|swelling|swollen)|anaphyla(xis|ctic)|tongue (is )?(swelling|swollen))\b/],
    ['general', /\b(emergency|call (an )?ambulance|911)\b/],
  ],
  // also a question about emergencies, not a report of one: "is this an emergency?", "what counts as an emergency?"
  notAnEmergency: /\b(not an? emergency|isn'?t an emergency|no emergency|not urgent|is (this|that|it) an emergency|counts? as an emergency|emergency (fees?|charges?|prices?|costs?|policy))\b/,
  yes: /\b(yes|yeah|yep|yup|correct|that'?s (right|correct|fine|good|perfect)|sounds good|perfect|please do|go ahead|book it|do it|sure)\b/,
  yesAlone: /^(ok|okay|confirm|confirmed)$/,
  hedge: /\b(no|nope|not|don'?t|wait|actually|hold on|hmm|maybe|instead|rather|change|different|other|but|although|though)\b|\?/,
  markers: /\b(the|and|you|my|is|appointment|please|thank|what|when|book|need|want|have|can|this|that|to|for|with)\b/g,
  saysNew: /(?<!\bwhat)\b(is|are|am|'s|'re|'m) (brand |completely |totally )?new\b(?! (phone|number|cell|mobile|address|email))|\b((a |an )?new (patient|client|pet)|new (here|to (you|the clinic|your clinic|this clinic|the practice))|not (registered|on file|in (your|the) (system|records))|(never|not|hasn'?t|haven'?t|isn'?t|wasn'?t) (been )?(registered|been (there|here|in|to (you|the clinic|your clinic|this clinic)))|first (time|visit) (here|with you|at (the|your) clinic)|(his|her|their|its|a) first (check-?up|visit|exam)|just (adopted|got (a|him|her|them|my|our))|(want|like|need) to register|register (my|our|a|him|her|them))\b/,
  describesPet: /\b((\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen)[ -](years?|months?|weeks?)[ -]old|(female|male|spayed|neutered))\b/,
  pointsAtPet: /^(?=.*\b(the|my|our|his|her|their|this|that|other|another|both)\b)(?:(?:the|my|our|his|her|their|this|that|other|another|both|not|one|ones|of|them|older|younger|old|young|big|little|small|dog|cat|pet|puppy|kitten|rabbit|bird)(?:[\s,.!?]+|$))+$/,
  saysOnFile: /\b((not|isn'?t|aren'?t) new|already (a |an )?(patient|client|registered|on file|in (your|the) (system|records))|(has|have|'s|'ve) been (there|here|in|to (you|the clinic|your clinic|this clinic)) before|(might|may|could|should) (already )?be (on file|registered|in (your|the) (system|records)))\b/,
};
