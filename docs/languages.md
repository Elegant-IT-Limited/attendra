# Languages

The assistant answers calls in English and Spanish. The dashboard is in English for every clinic; only what callers hear changes.

## What a clinic sets

Settings > Assistant and languages:

- **Assistant name.** One word of 2 to 24 letters, such as Maya. Without one the assistant is "the clinic's assistant". A name never counts as the AI disclosure: "Hi, I'm Maya" sounds like a person, so the greeting still has to say AI assistant (or the same in one of the clinic's languages), and a greeting without it is refused when it is saved. The software's own name never reaches a caller.
- **Languages.** Which of English and Spanish the assistant may speak on this clinic's calls.
- **Primary language.** Every call starts in it. The assistant switches when a caller speaks another language from the list, and switches back if they do.
- **Emergency number.** The number the emergency script gives. Leave it empty for the clinic's country: 911 for a +1 number, 999 for +44, 000 for +61 (Australia), 112 in the European Union and anywhere else. A clinic may choose only from its country's list (the United Kingdom and Australia also allow 112), so a typo like "91" is refused when settings are saved, and a number saved before this rule is replaced by the country's when a call runs.
- **Names in other languages.** A visit type or provider can have a name for each other language ("consulta por enfermedad" for sick visit), used in read-backs and offers. Without one the clinic's own name is said.

The greeting preview shows what a caller hears first, in the primary language, and what the assistant says when a caller switches to the other language.

## How a call picks its language

The backend keeps the call's language in `CallState.language`. It starts as the clinic's primary language, and after every caller turn `detectLanguage` looks at the last few turns and counts words that mark each of the clinic's languages. A tie goes to the primary language, and a language the clinic has not switched on is never chosen.

Everything the backend writes for the caller follows that language: offered times, read-backs, the text message, the emergency script, and the names of visit types and providers.

## What is the same in every language

- **The emergency guardrail checks every language's phrases on every call**, whatever the clinic has switched on. A caller does not choose their language by the clinic's settings. The script is said in the language the emergency was said in, when the clinic offers it, and otherwise in the call's language, with the clinic's emergency number.
- **A clear yes counts only in the clinic's languages, and a hedge in any language blocks it.** "Sí, pero espere" is not a yes, and neither is "yes, but not Monday".
- **Nothing is written without a read-back and a clear yes**, in whatever language the call is in.

## Spanish

US Spanish, always usted. Dates are said as "martes, 29 de septiembre a las 3:00 p.m.". The emergency phrases cover chest pain, not breathing, stroke signs, heavy bleeding, unconsciousness and seizures, self-harm, overdose and poison, and a closing throat. Yes words include sí (only on its own, since "si" is also "if"), claro, correcto, está bien, de acuerdo and perfecto; "vale" and "por favor" count only as the whole answer. Hedges include no, espere, mejor, tal vez, quizás, pero, prefiero, aunque and any question.

The 988 Suicide and Crisis Lifeline is given in Spanish at United States clinics. Five evals cover Spanish: a booking, a hedge, chest pain, a refill and three wrong dates of birth.

## Adding a language

A language is one pack: a file in `packages/core/src/locales/` (`en.ts`, `es.ts`) that holds, as data, everything a caller hears in it. Nothing else in the code holds a sentence a caller hears. A pack has:

- lines for the conversation prompt (register, tone, how to handle mixed speech);
- the default greeting, and the words that count as disclosing an AI assistant;
- how to say a date and time, and a phone number digit by digit;
- the read-back templates for a booking, a move and a cancellation, for a provider who is a person and one that is a room;
- the booking text message, which says when and where, never why;
- the emergency and self-harm scripts, which take the clinic's number;
- the emergency phrases, "not an emergency", the yes words, the words that are a yes only on their own, and the hedge words;
- marker words for choosing the call's language.

Patterns are written in lower case without Latin accents, because caller text is normalised the same way (`normalise` in `locales/types.ts`). Build them with `words()`, which matches whole words in any script (JavaScript's `\b` only knows ASCII letters) and folds the pattern the way the text is folded.

To add one:

1. Copy `en.ts` to `<code>.ts` and translate everything in it.
2. Add the code to `LANGUAGES` in `locales/types.ts` and the pack to `PACKS` in `locales/index.ts`.
3. Write emergency phrases for every kind in the English pack, with a test for each in `packages/core/test/languages.test.ts`, and have a clinician who works in that language review them (see [safety](safety.md)).
4. Add at least five evals in the language: a booking, a hedge, an emergency, a refill and a wrong date of birth.
5. If dates of birth are said differently, teach `parseDob` in `identity.ts`.
6. Have a native speaker check every line of the pack and listen to recorded test calls before it is used with patients.

A clinic configuration saved with a language code Attendra does not ship still loads: the code is dropped, and the primary language and greeting fall back to one the clinic still offers.
