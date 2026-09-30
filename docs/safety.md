# Safety

Attendra talks to patients who may be ill, frightened, elderly, or in an emergency. These are the commitments, and where each one is enforced.

## The agent never gives medical advice

The conversation prompt says so, and so does the planner prompt, but the real guarantee is structural: the backend has no tool that interprets symptoms, triages, or decides on a prescription. Refills become staff tasks with the wording "the care team will review it". Scenarios list forbidden phrases ("approved", "you should take", "probably nothing"); that check is meaningful in `pnpm eval --live`, where a real model writes the words. In scripted mode the scripts, not a model, produce the output.

## Emergencies

`detectEmergency` in `packages/core/src/emergency.ts` runs on every caller transcript fragment, over a rolling window so a phrase split across fragments is still caught. It is a phrase list, not a classifier, and it deliberately errs toward false positives: telling someone with a cough to call 911 costs a moment of confusion; missing chest pain costs far more. The phrases live in the language packs (`packages/core/src/locales/`), and every language's phrases are checked on every call, whatever languages the clinic offers (see [languages](languages.md)).

On a match, the backend immediately:

1. sends a fixed instruction to stop the task and say "If this is a medical emergency, please hang up and call 911 right away" (for self-harm language, the 988 Suicide and Crisis Lifeline script). The script is in the language the emergency was said in when the clinic offers it, otherwise in the call's language, and gives the clinic's emergency number: 911 by default in the United States, 999 in Bangladesh. 988 is named only at United States clinics;
2. drops any change waiting for confirmation, refuses every further write for the rest of the call, and discards any request already in flight;
3. marks the call as an emergency for staff review;
4. if the clinic enabled it and the match is a specific medical kind (not just the word "emergency"), transfers to the on-call line after a short delay, so the caller hears the emergency number first.

The guardrail keeps listening after the first match: a different kind later in the call ("and now he has passed out") gets its own instruction. The one negation it honours is "it is not an emergency", and only for the bare word; "no chest pain" style negations are too easy to mishear.

No clinic setting turns the guardrail off.

### Before any release

The phrase list and both scripts must be reviewed by a licensed clinician, and the review recorded in the pull request that changes them. The Spanish and Bangla lists need a clinician who works in that language.

What the lists catch is what their tests show, and no more: a phrase list catches the phrases on it and the spellings written into it, and a caller who says it another way is not caught. The tests are in `packages/core/test/safety-rules.test.ts` (English) and `packages/core/test/languages.test.ts` (Spanish and Bangla).

| Kind | English | Spanish | Bangla (both scripts) |
|---|---|---|---|
| Cardiac | chest pain, heart attack | me duele el pecho | বুকে ব্যথা, buke betha |
| Breathing | can't breathe | no puedo respirar | শ্বাস নিতে পারছি না, শ্বাস নিতে কষ্ট হচ্ছে, shash nite kosto |
| Stroke | face drooping, slurred speech | no puede hablar bien, tiene la cara caída | স্ট্রোক করেছে, মুখ বেঁকে গেছে, hat pa obosh |
| Bleeding | won't stop bleeding | sangrando mucho | রক্ত পড়ছে থামছে না, onek rokto |
| Unresponsive | passed out, not waking up | inconsciente | অজ্ঞান, oggan |
| Self-harm | don't want to be alive | quitarme la vida | আত্মহত্যা, bachte chai na |
| Overdose or poison | took too many, took a whole bottle, overdose, poison, swallowed bleach | se tomó todas las pastillas, veneno | বিষ খেয়েছে, bish kheyeche |
| Severe allergic reaction | throat is swelling | se me está cerrando la garganta | গলা ফুলে যাচ্ছে, gola fule jacche |

Every pack's phrases are checked on every call, whichever languages the clinic offers. Bangla is experimental and off by default (a clinic offers English only until someone switches another language on), and stays experimental until a Bangladeshi clinician has reviewed its list.

## Identity

Patient-specific actions need a match on full name and date of birth. The calling number is only a hint: families share phones and numbers can be spoofed. Three failed attempts end the check and offer a callback. "No such patient" and "wrong date of birth" get the same answer, so a caller cannot probe whether someone is a patient. Two records with the same name and date of birth go to staff; the agent never picks one.

## Writes

Every booking, reschedule and cancellation is two steps: propose (which produces the read-back) and commit (which runs only if the caller's own words since the read-back are a clear yes: "maybe", "actually" and questions do not count). Every write carries an idempotency key, and the database refuses two overlapping bookings for one provider whatever the application does.
