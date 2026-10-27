# Safety

Attendra talks to patients who may be ill, frightened, elderly, or in an emergency. These are the commitments, and where each one is enforced.

## The agent never gives medical advice

The conversation prompt says so, and so does the planner prompt, but the real guarantee is structural: the backend has no tool that interprets symptoms, triages, or decides on a prescription. Refills become staff tasks with the wording "the care team will review it". Scenarios list forbidden phrases ("approved", "you should take", "probably nothing"); that check is meaningful in `pnpm eval --live`, where a real model writes the words. In scripted mode the scripts, not a model, produce the output.

## Emergencies

`detectEmergency` in `packages/core/src/emergency.ts` runs on every caller transcript fragment, over a rolling window so a phrase split across fragments is still caught. It is a phrase list, not a classifier, and it deliberately errs toward false positives: telling someone with a cough to call 911 costs a moment of confusion; missing chest pain costs far more. The phrases live in the language packs (`packages/core/src/locales/`), and every language's phrases are checked on every call, whatever languages the clinic offers (see [languages](languages.md)).

On a match, the backend immediately:

1. sends a fixed instruction to stop the task and say "If this is a medical emergency, please hang up and call 911 right away" (for self-harm language, the 988 Suicide and Crisis Lifeline script). The script is in the language the emergency was said in when the clinic offers it, otherwise in the call's language, and gives the clinic's emergency number: 911 by default in the United States, and the country's own elsewhere (999, 112, 000). 988 is named only at United States clinics;
2. drops any change waiting for confirmation, refuses every further write for the rest of the call, and discards any request already in flight;
3. marks the call as an emergency for staff review;
4. if the clinic enabled it and the match is a specific medical kind (not just the word "emergency"), transfers to the on-call line after a short delay, so the caller hears the emergency number first.

The guardrail keeps listening after the first match: a different kind later in the call ("and now he has passed out") gets its own instruction. The one negation it honours is "it is not an emergency", and only for the bare word; "no chest pain" style negations are too easy to mishear.

No clinic setting turns the guardrail off.

### Review

Two reviews, and both are recorded:

1. **Each clinic reviews the lists before its calls go live.** `GET /api/v1/clinics/:clinicId/emergency-review` shows a clinician (a veterinarian, at a veterinary clinic) every kind of emergency the assistant acts on, examples of what callers say, and the exact words callers hear, with the clinic's own emergency hospital and emergency number in them. `POST` to the same address records who reviewed it, their role and when, in the clinic's settings and the audit log. The review carries a fingerprint of the lists; a release that changes a list makes every clinic's review out of date until it is done again. Settings cannot change or remove a review.
2. **A change to a list or a script is reviewed in its pull request**, by a clinician where one is available, and always against the published sources listed below; the pull request says which.

The Spanish lists need a reviewer who works in Spanish.

What the lists catch is what their tests show, and no more: a phrase list catches the phrases on it and the spellings written into it, and a caller who says it another way is not caught. The tests are in `packages/core/test/safety-rules.test.ts` (English) and `packages/core/test/languages.test.ts` (Spanish).

| Kind | English | Spanish |
|---|---|---|
| Cardiac | chest pain, heart attack | me duele el pecho |
| Breathing | can't breathe | no puedo respirar |
| Stroke | face drooping, slurred speech | no puede hablar bien, tiene la cara caída |
| Bleeding | won't stop bleeding | sangrando mucho |
| Unresponsive | passed out, not waking up | inconsciente |
| Self-harm | don't want to be alive | quitarme la vida |
| Overdose or poison | took too many, took a whole bottle, overdose, poison, swallowed bleach | se tomó todas las pastillas, veneno |
| Severe allergic reaction | throat is swelling | se me está cerrando la garganta |

Every pack's phrases are checked on every call, whichever languages the clinic offers.

### Animal emergencies (the veterinary pack)

A clinic on the veterinary industry pack (see [industries](industries.md)) has a second list, checked before the language's own: an animal in danger. Its script sends the caller to the clinic's chosen 24-hour emergency hospital (name, address and phone, set as `emergencyHospital`), or to the nearest 24-hour emergency vet when none is set, and then tells a person who is hurt or in danger to call the emergency number. It gives no first-aid advice and asks no questions about symptoms. Staff cannot end the call until the hospital's name has been said, or the grace period has passed.

The person on the phone is still covered by the engine's list: someone with chest pain calling a vet hears the 911 script, and self-harm language always gets the crisis script first, before anything about an animal.

The animal list is reviewed like the person list (see Review above): by each clinic's veterinarian before its calls go live, and in the pull request that changes it. Its tests are in `packages/core/test/vet-pack.test.ts`.

What the list covers follows published guidance for pet owners on when to get emergency care at once: the AVMA's pet first aid guidance ([brochure, 2025](https://ebusiness.avma.org/files/ProductDownloads/mcm-client-brochures-pet-first-aid-2025.pdf): severe bleeding, choking and breathing trouble, seizures, heatstroke, snake bites) and the ASPCA Animal Poison Control Center's list of foods that are toxic to pets ([people foods to avoid](https://www.aspca.org/pet-care/aspca-poison-control/people-foods-avoid-feeding-your-pets): chocolate, xylitol, grapes and raisins, onions and garlic, and others). The list sends the owner to the emergency hospital; it never decides that a case is safe.

| Kind | English | Spanish |
|---|---|---|
| Toxin or swallowed object | ate chocolate, got into the rat poison, licked antifreeze, swallowed a sock | se comió chocolate, tomó anticongelante |
| Breathing | can't breathe, gums are blue, open-mouth breathing | no puede respirar |
| Trauma | hit by a car, bleeding a lot, bitten by a snake | lo atropelló un carro |
| Collapse or seizure | collapsed, having a seizure, dying | está convulsionando |
| Bloat | belly swollen and hard, retching, trying to throw up and nothing comes | panza hinchada, quiere vomitar y no puede |
| Can't urinate | can't pee, straining to urinate | no puede orinar |
| Heat | heatstroke, left in a hot car | golpe de calor |
| Birth | in labour for hours, a puppy is stuck | cachorro atorado |

## Identity

Patient-specific actions need a match on full name and date of birth. The calling number is only a hint: families share phones and numbers can be spoofed. Three failed attempts end the check and offer a callback. "No such patient" and "wrong date of birth" get the same answer, so a caller cannot probe whether someone is a patient. Two records with the same name and date of birth go to staff; the agent never picks one.

At a veterinary clinic, a pet is found by its owner's full name, its own name and the phone on file, with the same three tries, the same answer whichever detail was wrong, and two pets with the same name on one number going to staff.

### What the assistant may say about an owner's pets, by how much it knows

Each level allows what the one before it allows, plus more. It is enforced in `runTool` (`verify_caller` and `visit_summary` in `packages/agent/src/tools.ts`), not only in the prompt, and every read is audited.

| What the assistant knows | What it may say |
|---|---|
| Nothing yet (unknown or hidden number) | Nothing from the records. It asks the owner's name and which pet. |
| The calling number only (caller ID matched a number on file) | "Am I speaking with <owner first name>?" (only when one owner is on file for the number); how many times and when this number called; whether a request from those calls is still open. Never what a call was about, never a pet. |
| Caller ID matched, and the caller said yes to the owner's name | The first names of that owner's pets on this number, to pick from: "Is this for Biscuit or Max, or a new pet?" (at most three, then "or another one"). Only with real caller ID: a number the caller only says (a browser test call, a hidden number) never unlocks it. On a family number, only the confirmed owner's pets. Audited as `patient.pets_on_number.read`. |
| Fully verified (owner's name, pet's name and phone matched) | Visit facts only, for that pet: its next visits (date, time, vet, kind of visit), its last visit (date, vet, kind of visit) and its usual vet, always said as "the last visit I can see", because Attendra knows only the visits booked or recorded in it. Never a list read out unasked, never a count of visits. Audited as `patient.visits.read.call`. |
| Never, at any level | Medical details: diagnoses, test results, medicines and doses, weights, vet notes, invoices, the full history or copies of records. Records go to the team as a records request (`create_callback`, "Records request: ..."), and staff send them in writing. Medical questions get the usual refusal and an offer of the team. |

A pet not on file is registered under the same number. Pets are grouped by the owner's phone.

## Writes

Every booking, reschedule and cancellation is two steps: propose (which produces the read-back) and commit (which runs only if the caller's own words since the read-back are a clear yes: "maybe", "actually" and questions do not count). Every write carries an idempotency key, and the database refuses two overlapping bookings for one provider whatever the application does.

## Abusive callers

A caller who is upset, or swears out of frustration ("what the hell is going on"), is helped like anyone else and offered a callback. Insults or threats aimed at the person on the line ("you idiot", "shut up", "I'll find you", "eres un idiota") are counted once per caller turn, from the words alone (`isAbusive` in packages/core):

1. The first time, the assistant stays calm and polite and carries on.
2. The second time, it says once that it will need to end the call if the language continues, and offers a call back from the clinic.
3. The third time, it ends the call politely ("You're welcome to call back any time").

It never argues or swears back, and it never ends a call during an emergency. The call shows "Abusive caller" in what the assistant did, and is always flagged for review.
