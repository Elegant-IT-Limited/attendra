# Languages

The assistant answers calls in English, Spanish and Bangla. Bangla is experimental. The dashboard is in English for every clinic; only what callers hear changes.

## What a clinic sets

Settings > Assistant and languages:

- **Assistant name.** One word of 2 to 24 letters, such as Maya. Without one the assistant is "the clinic's assistant". A name never counts as the AI disclosure: "Hi, I'm Maya" sounds like a person, so the greeting still has to say AI assistant (or the same in one of the clinic's languages), and a greeting without it is refused when it is saved. The software's own name never reaches a caller.
- **Languages.** Which of English, Spanish and Bangla the assistant may speak on this clinic's calls.
- **Primary language.** Every call starts in it. The assistant switches when a caller speaks another language from the list, and switches back if they do.
- **Emergency number.** The number the emergency script gives. Leave it empty for the clinic's country: 911 for a +1 number, 999 for +880 (Bangladesh) and +44, 000 for +61 (Australia), 112 in the European Union and anywhere else. A clinic may choose only from its country's list (the United Kingdom and Australia also allow 112), so a typo like "91" is refused when settings are saved, and a number saved before this rule is replaced by the country's when a call runs.
- **Names in other languages.** A visit type or provider can have a name for each other language ("রক্ত পরীক্ষা" for blood test), used in read-backs and offers. Without one the clinic's own name is said.

The greeting preview shows what a caller hears first, in the primary language, and what the assistant says when a caller switches to each other language.

## How a call picks its language

The backend keeps the call's language in `CallState.language`. It starts as the clinic's primary language, and after every caller turn `detectLanguage` looks at the last few turns and counts words that mark each of the clinic's languages. Bengali script counts double, because a transcriber that returns it has heard Bangla. A tie goes to the primary language, and a language the clinic has not switched on is never chosen.

Everything the backend writes for the caller follows that language: offered times, read-backs, the text message, the emergency script, and the names of visit types and providers.

## What is the same in every language

- **The emergency guardrail checks every language's phrases on every call**, whatever the clinic has switched on. A caller does not choose their language by the clinic's settings. The script is said in the language the emergency was said in, when the clinic offers it, and otherwise in the call's language, with the clinic's emergency number.
- **A clear yes is checked in every language at once.** Any language's yes counts, and any language's hedge blocks it: "sí, pero espere" and "ji, pore" are not a yes.
- **Nothing is written without a read-back and a clear yes**, in whatever language the call is in.

## What is in a language pack

Each language is one file in `packages/core/src/locales/`: `en.ts`, `es.ts`, `bn.ts`. A pack holds, as data:

- lines for the conversation prompt (register, tone, how to handle mixed speech);
- the default greeting, and the words that count as disclosing an AI assistant;
- how to say a date and time, and a phone number digit by digit;
- the read-back templates for a booking, a move and a cancellation;
- the two text-message templates, which say when and where, never why;
- the emergency and self-harm scripts, which take the clinic's number;
- the emergency phrases, "not an emergency", the yes words and the hedge words;
- marker words for choosing the call's language.

Patterns are written in lower case without Latin accents, because caller text is normalised the same way (`normalise` in `locales/types.ts`). Build them with `words()`, which matches whole words in any script. JavaScript's `\b` only knows ASCII letters, and `words()` also folds the pattern the way the text is folded. Some Bengali letters (ড়, ঢ়, য়) have no composed canonical form, so a pattern typed with the composed letter would otherwise never match.

## Spanish

US Spanish, always usted. Dates are said as "martes, 29 de septiembre a las 3:00 p.m.". The emergency phrases cover chest pain, not breathing, stroke signs, heavy bleeding, unconsciousness and seizures, self-harm, overdose and a closing throat. Yes words include sí (only at the start, since "si" is also "if"), claro, correcto, está bien, de acuerdo and perfecto. Hedges include no, espere, mejor, tal vez, quizás and any question.

The 988 Suicide and Crisis Lifeline is given in Spanish at United States clinics. Five evals cover Spanish: a booking, a hedge, chest pain, a refill and three wrong dates of birth.

## Bangla (experimental)

Standard spoken Bangla (cholito bhasha), always apni, never tumi. Callers often mix Bangla and English ("test er report kobe pabo"), and a transcriber may return either script, so every phrase is written in Bengali script and in the romanised spellings people use.

- Dates are said the way Dhaka says them: "সোমবার, ৬ অক্টোবর, বিকেল ৩টা" (somobar, 6 October, bikel 3 ta), with the part of the day (sokal, dupur, bikel, sondhya, raat) and Bengali digits.
- Phone numbers are read digit by digit, with +880 said as 0. Prices are in taka.
- Yes: জি, হ্যাঁ, ঠিক আছে, আচ্ছা, করুন, and ji, ha, thik ache, accha, korun, confirm. Hedges: না, দাঁড়ান, পরে, মনে হয়, অন্য দিন, একটু, and na, daran, pore, mone hoy, onno din, ektu, and any question.
- Emergency phrases, in both scripts: chest pain, cannot breathe, unconscious, heavy bleeding, suicide and self-harm, and the words joruri, emergency, ambulance and 999. The script says "এটা যদি জরুরি অবস্থা হয়, দয়া করে এখনই ফোন রেখে ৯৯৯ নম্বরে কল করুন।"
- Dates of birth can be said with Bengali digits and month names ("১২ মে ১৯৭৯"). A numeric date is read day first outside North America, so 20/02/1992 is 20 February.
- Names are passed to the backend in English letters, as a Bangladeshi clinic's register writes them. A caller who gives their name in Bengali script is matched only if the model writes it in English letters, which the prompt asks it to do.

Bangla shows an Experimental badge in Settings, with this line: **Check the voice with a native speaker before using it with patients.** Six evals cover it: a booking with "ji", the hedge "na, pore", when reports are ready, a price, an emergency with 999, and a caller mixing Bangla and English.

The second demo clinic, Dhanmondi Diagnostic Centre, runs in Bangla first. Sign in to the demo as `frontdesk@dhanmondi-demo.test` to see it; that login sees only this clinic.

### What Bangla needs before it stops being experimental

- A native speaker, ideally someone who has worked a Dhaka front desk, reviews every line in `bn.ts`, the greeting and the emergency script, and listens to a set of recorded test calls.
- The emergency phrases are reviewed by a Bangladeshi clinician, as the English ones are (see [safety](safety.md)).
- The live evals (`pnpm eval --live`) pass for the Bangla scenarios with the production voice model, several times over, with transcripts checked for register (apni) and for mixed-language callers.
- Name matching works for names spoken in Bengali script.

## Adding a language

1. Copy `en.ts` to `<code>.ts` and translate everything in it. Mark it `experimental: true`.
2. Add the code to `LANGUAGES` in `locales/types.ts` and the pack to `PACKS` in `locales/index.ts`.
3. Write emergency phrases for every kind in the English pack, with a test for each in `packages/core/test/languages.test.ts`, and have a clinician who works in that language review them.
4. Add at least five evals in the language: a booking, a hedge, an emergency, a refill and a wrong date of birth.
5. If dates of birth are said differently, teach `parseDob` in `identity.ts`.
6. Have a native speaker check the voice, as for Bangla above, before taking the badge off.
