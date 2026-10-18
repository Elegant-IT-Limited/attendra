# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/); until 1.0, minor versions may change behaviour.

## [Unreleased]

### Added

- **Refills ready to pick up.** A refill request closes as "Approved, ready to pick up" (the worker texts the number the caller left, once, from the clinic's number, never naming the medication), "Not approved, called back", or "Sent to the pharmacy" as before. Migration 0025. The worker texts only with `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` set.
- **Records requests** at a veterinary clinic: the pet is found first, then the request goes to the team, starting "Records request:". Records are never read out on the phone.
- **Settings**: "While you are closed" (book, or take requests), and the emergency hospital for a veterinary clinic. A pet's page shows its kind of animal and its owner; patient cards in the API carry `species`.
- **Demo**: Riverbend Animal Hospital's call scenarios are recorded into its call history, like Maple Street's.
- **Test-call allowance.** A clinic can be given a total of test-call time (`pnpm db:test-call-limit`, migration 0026); the Test call page shows what is left, and a call ends when it runs out. Without one, nothing changes.
- **A vet clinic's Today** shows the refills waiting for a vet and the emergencies of the last 7 days; each card opens the list behind it (`/requests?type=refill`, `/calls?emergency=true`). Pets are listed with their kind of animal and owner.
- **Quality**: bookings made after hours, emergencies, and refill requests, week by week. A new setting, the average visit value, is what the weekly report counts each booking made after hours as.
- **Extra menu links for owners** from `ATTENDRA_ACCOUNT_LINKS`, for a hosting layer's billing or setup pages.
- **Provisioning** for a hosting layer, behind `ATTENDRA_PROVISIONING_TOKEN`: open an account (organization, clinic from the pack's first settings, owner), confirm its email, set test-call time, point and release numbers, read phone minutes and the weekly report. See `docs/provisioning.md`. `pnpm db:add-number` uses the same code.
- **The clinic's review of the emergency lists.** `GET /clinics/:clinicId/emergency-review` shows every kind of emergency the assistant acts on, examples, and the exact words callers hear with the clinic's own hospital and emergency number; `POST` records who reviewed it (name, role, time, and a fingerprint of the lists, so a list change makes the review out of date). Audited; Settings cannot change it. `docs/safety.md` names the published sources the animal list follows.
- **Two-step sign-in can be optional** (`ATTENDRA_TWO_FACTOR=optional`), for a hosted service without patient health information. Required stays the default.

### Changed

- **Texts end with how to opt out** ("Reply STOP to opt out.", in Spanish "Responda STOP para no recibir más mensajes."), as US carriers expect for A2P 10DLC registration. Twilio handles STOP replies itself.
- **Sign-in needs a confirmed email address.** Accounts made with `pnpm add-member`, the Team page or the seed are confirmed when they are made, so nothing changes for them; an account opened through provisioning waits for its confirmation.

### Added (customising)

- **Offers and announcements** (Settings): what the clinic is running now, with optional start and end dates. The assistant answers from them when callers ask, only while they run.
- **Visit types the team books itself**: a "Team books it" switch. The assistant never offers times for such a visit; it takes a request for the team instead (refusal `staff_books`). Each visit type can also carry a short description the assistant gives callers who ask what it includes.
- **Qualifications and certifications** for each doctor or veterinarian, on the Doctors page and in what the assistant says when asked.
- **Kinds of request** (Settings): the clinic's own request topics (boarding inquiry, insurance question) with what to ask for each. The assistant asks for it and labels the callback request with the topic; `create_callback` takes an optional `topic`, and only the clinic's own topics are kept.
- **Fields on each patient or pet** (Settings): up to 20 of the clinic's own details (microchip, insurer, a reminder date), each text, yes or no, or a date. Staff fill them in under Details on the record; they are encrypted like the rest of it (schema v27, `patients.custom_enc`), saved with `PUT /patients/:patientId/fields`, and audited without the values. Not used on calls yet.
- **Urgent requests and due days** (Requests): the front desk marks an open request urgent, which puts it first in the open queue, and gives it a due day, shown as Due or Overdue. `POST /tasks/:taskId/plan` (schema v28, `tasks.urgent`, `tasks.due_on`), audited as `task.planned`; the MCP `list_open_requests` tool returns both.
- **When a visit may be booked** (Settings, Visit types): minimum notice in hours and the furthest day ahead the assistant books each visit type (refusal `too_far_ahead` past it), and minutes kept free after each visit, honoured on calls and at the front desk. Booked time now carries its visit type to the slot search (`BusyInterval.visitTypeId`, optional for other schedulers).
- **VIP callers** (Settings): up to 50 numbers that always reach a person. While the front desk takes transfers, the assistant greets them, says it is connecting them, and transfers once it is quiet (`vipRoute` in core, `CallAgent.vip`, a `quiet` transfer in the call runner); otherwise it answers them as usual. The live view says so.
- **Links in your menu** (Settings): up to 8 of the clinic's own links (practice software, booking page, forms), shown to the whole team and opened in a new tab.

### Added (from the product review)

- **Hear a voice before choosing it.** Settings has a Listen button that plays the clinic's saved greeting in the chosen voice (`GET /clinics/:id/voice-sample`, text to speech with `ATTENDRA_TTS_MODEL`, cached, 30 samples per clinic in ten minutes, no audit row since no patient data). A voice the speech model does not have says so and suggests a test call.
- **Emergency hospitals, more than one, with hours.** `moreEmergencyHospitals` (up to 4 more) and optional daily `hours` on each (overnight allowed); the script names the clinic's first choice that is open at the time (`hospitalFor`), and falls back to the nearest 24-hour hospital when none is.
- **Visits left on a day off or a holiday** are listed on Schedule, Veterinarians and Settings (`GET /appointments/conflicts`, counts only); a change to days off or holidays never moves anyone, so the team is told.
- **Clinic address and website** in Settings; the assistant gives them when asked (`get_clinic_info`).
- **More countries.** Emergency numbers for New Zealand, Ireland, Mexico, Japan, Singapore, Hong Kong, South Africa, India and Brazil (2 to 5 digits); the clinic's currency on the visit value; phone numbers staff type are kept as E.164 in the clinic's country so texts reach them (`asE164`); transfer and VIP examples in the clinic's own format.

### Added (texting foundation and platform)

- **Whether a text went, everywhere it may have.** Every text is linked to its call, request, pet or patient and visit, and keeps its language, when it was sent and delivered, the carrier's error code, and why one was not sent (`not_sent`: opted out, too many to that number today, no number, texting off, carrier). The call page, a refill marked ready to pick up, and a pet's or patient's record show them (`GET /clinics/:clinicId/texts`, one filter; a patient's texts are audited as a view). Migration 0029.
- **STOP is kept.** Texts to a clinic's number arrive at the voice service (`POST /webhooks/twilio/sms-inbound`, signed by Twilio): STOP and its usual words (also ALTO, PARAR) mark the number opted out for that clinic, START opts it back in, anything else gets "This number does not read replies" in the clinic's language. A number the carrier refuses as opted out (21610) is marked too. No text is sent to an opted-out number. Only a hash of the number is stored.
- **Delivery reports.** Twilio reports each text's delivery to `POST /webhooks/twilio/sms-status`; the worker records it and never moves a status backwards. Set `ATTENDRA_VOICE_PUBLIC_URL` on the voice service and the worker; the old `ATTENDRA_SMS_STATUS` switch is gone.
- **Limits on texts:** at most 8 a day to one number from one clinic, and `ATTENDRA_SMS_DAILY_CAP` (500) from a clinic, with a warning at 80%. Numbers are sent as E.164 in the clinic's country.
- **Two people saving Settings at once no longer undo each other.** Settings carries a version (`ETag`, migration 0030); a save made from an older copy is refused (409 `settings_changed`, with the newer settings and who saved them, audited). The Settings page then says which sections each of you changed and lets you keep yours where they do not clash, choose where they do, or load theirs. Saves without `If-Match` work as before. `GET /settings/meta`.
- **Who may approve refills.** "Approves refills" on the Team page (migration 0031): only those people can close a refill as sent to the pharmacy, ready to pick up (which texts the caller) or not approved; anyone on the front desk can still call back, leave a message or add a note. A manager can mark anyone but an owner; an owner can mark themselves. Audited, and the log names approvals and refusals of refills. Requests says when nobody can approve yet.

### Added (texting during calls, greetings, how the assistant talks)

- **The assistant texts what the caller just heard, after a yes.** The address with a map link, this week's hours, a doctor's details, the answer it just gave, or one of the clinic's links (Settings → Texting). `send_text` asks the exact question first (`consent_required`) and sends only after a clear yes in the caller's own words after the question, like a booking's read-back; never to a number other than the caller's or the one on file (`number_not_allowed`), never to one that replied STOP (`opted_out`), at most 3 per call (`rate_limited`), only what was given on the call (`nothing_to_send`). In an animal emergency the script ends with an offer to text the hospital's details, the only text allowed then. Templates for every kind in English and Spanish, each ending with the opt-out line; the text and the moment of the yes are on the call page.
- **Moves and cancellations are confirmed by text**, like bookings (`change_confirmed`, `cancel_confirmed`; Settings → Texting, on by default).
- **A greeting of the clinic's own in each other language**, checked for the AI disclosure in that language (`greetings`), and said once when the caller switches.
- **How the assistant talks**: a more natural default (short turns, everyday words, a brief "Sure, one moment" instead of silence), and the clinic's choice of pace, style and acknowledgements (`talk`). These change how it sounds, never what it may do.
- **Hosting:** `PUT /provisioning/clinics/:id/texting` turns texting during calls on or off; the cloud does it when the texting registration is approved or rejected. The Riverbend demo clinic texts (its texts show as not sent, with no Twilio).

### Added (fields and lists)

- **Settings → Fields and lists**, one tab each for pets (or patients), veterinarians (or doctors) and requests. Each has the clinic's own fields: text, number, yes or no, date, a dropdown to pick one or several (with the choices in order), "must be filled in", "show as a column", and up and down to order them. A new field goes to the top; with an empty one there, the button goes to it.
- **Lists the clinic keeps in order**: specialties, what doctors see, kinds of animal. Rename, remove, reorder and add; a rename is carried to every doctor, a removal takes it off them after saying how many use it (`PUT /settings/lists/:list`). Before a clinic keeps a list, it is what the records say.
- **On the records**: a doctor's form picks what they see as chips from the list and has the clinic's fields; a request card has its own details (`PUT /tasks/:id/fields`, encrypted, migration 0032); the Pets list filters by kind of animal or by a dropdown or yes-or-no field, read on the server (`POST /patients/filter`), and shows the fields marked as columns; Requests filter by a request field. "Manage fields" on each list page opens its tab. Kinds of request moved from General to the Requests tab.

### Changed (one way of working everywhere)

- **Drag to order** every list the clinic orders: fields, a dropdown's choices, kinds of animal, specialties and what doctors see, kinds of request, visit types, emergency hospitals, transfers, VIP callers, common questions, offers, menu links and texting links. Drag the handle with a mouse or a finger, or focus it and use the arrow keys. The up and down buttons are gone.
- **A dropdown's choices** are one row each, with + to add a row under it, − to remove it, and Enter for the next one; a choice typed twice is marked on its row.
- **New rows at the top**, under the button that adds them, everywhere: emergency hospitals, days off, list values and choices too; date lists add from the top.
- **Lists you pick from open as real dropdowns**: a vet's specialty and a pet's kind of animal show the clinic's whole list on a click or the down arrow (the browser's own suggestions showed only what matched the text already there), and still take a new value typed in. A vet's "Animals and services they see" offers every value of the list as a button.
- **Schedule → Month**: six weeks at a glance, each day with its first visits and how many more; a day opens its own view, a visit its panel. The schedule API reads up to 42 days at once.
- **Messages you can see**: what did not work opens in a dialog in the middle of the screen (save errors list each thing to fix); what worked is a note at the bottom; questions before removing something used are dialogs too. A Settings save that crossed someone else's opens as a dialog. Nothing is said only at the top of a long page.

### Added (locations)

- **More than one location.** A hosting layer adds a clinic to an organization (`POST /provisioning/organizations/:id/clinics`), copying the first clinic's assistant settings; hours, doctors and transfers are its own. Someone who works at more than one clinic switches between them from the clinic name in the menu, landing on the same page. The Team page says that everyone sees every location.

### Added (scheduling and reminders)

- **Special days** (Settings, "Holidays and special days"): a date closed with a reason, or open shorter hours (up to two windows), with a note the assistant says ("Today the clinic is open 08:00 to 12:00 (Christmas Eve)."). Slots, the hours the assistant reads, the hours text and the Schedule all follow them; a doctor's own hours are kept inside the clinic's for that date. A date cannot be both a holiday and a special day.
- **Away for part of a day** (Doctors, Days off, "Part of the day"): no times are offered between the two times, at the desk or on a call (refusal `away`); visits outside them are unchanged. The Schedule's "visits to move" counts a booking inside one.
- **Squeeze someone in** (Schedule, New booking, "Squeeze in outside the hours"): the front desk books any time, on a closed day or while the vet is away, with a reason. A clash with another visit and the past are still refused. The reason is kept on the visit, shown with an Override badge, and audited as `appointment.booked.staff.override`. The assistant never overrides. Migration 0033.
- **Appointment reminders** (Settings → Texting, Reminders): a text a set number of hours before each visit (24 by default), outside quiet hours (20:00 to 08:00 by default), only to people who said yes. After a booking the assistant asks once, "Would you like a reminder text before the visit?", and keeps a clear yes on the record (`set_reminder_consent`, checked against the caller's own words); staff tick "Texts OK" on the record, and a patient or pet import takes an optional `texts_ok` column. The worker sends them every 10 minutes, each visit claimed once (`appointment-reminders`). A reply of C confirms the visit: the Schedule shows it, the clinic's webhooks get `appointment.confirmed`.

### Fixed

- **Voice previews say which voices have one.** OpenAI's speech model has 10 of the 23 phone voices; those play a preview. The other 13 (Tempo, Willow, Beacon and the rest) exist only in the Live model, which speaks only on a call, so Settings offers only the 10 that can be heard (`PREVIEW_VOICES`); a clinic that already uses one of the other 13 keeps it, marked "no preview", with a Test call button instead of Listen (refusal `calls_only`). A preview that fails says to try again, and the reason is logged. A changed greeting is heard in the preview once saved; the browser no longer replays the earlier one for an hour.
- **The Settings menu follows the page**: the section being read is highlighted as you scroll.
- **One empty row at a time in Settings.** With an empty visit type, question, hospital, transfer number or other row already there, its add button takes you to that row (outlined for a moment) instead of adding another; rows left empty are left out when you save, so they never block it.
- **The ready-to-pick-up text is in the language of the call**, not always the clinic's first language (`calls.language`).
- **CI**: the eval report is run once more when Node crashes on its own (exit by signal), not when a scenario fails.
- **After hours at a clinic that takes requests, the assistant looks up no times** (refusal `after_hours` on `find_slots` too) and the prompts say so, so it never reads out a time it then refuses; cancelling an existing visit is allowed after hours.
- **A calm owner is no longer stuck after an animal emergency.** Once the script has been said, "he's fine now, it's not an emergency" lets the call go on (booking a check-up); the emergency stays on the record, a new emergency holds the call again, and a person in danger never clears it. A question about emergencies ("is this an emergency?") is not one.
- **Transfers:** a clinic with no transfer line hears that, not "nobody is available"; a browser test call says where it would have connected the caller; Settings warns when a transfer number is one the assistant itself answers (a loop).
- **A refill named with its dose** ("Apoquel 16 mg") no longer turns the next ordinary question into a medical one.
- **A rabbit at a new clinic** gets times: with no specialties listed, everyone sees everything, and animals match the groups vets are listed for (rabbit to Exotics, parrot to Birds). The starter "our veterinarian" is a stand-in (`placeholder`) that is never offered once a real vet is listed.
- **The weekly value for clinics that take requests after hours** counts the requests taken while closed (`afterHoursRequests`), and Quality shows them, instead of a permanent zero.

- **The dashboard reads as one product.** Settings has a menu of its own parts, every list item (visit types, transfer numbers, offers, questions, kinds of request, fields, VIP callers, links) is a card with stacked, full-width fields and a remove button in its corner, a new item goes to the top of its list with the cursor in it, placeholders read as examples, empty lists say so, opening hours are a table, and the average visit value shows its dollar sign. Routing is now "Transfers" and takes a plain phone number. Call filters are a grid; the Requests legend and the Quality explanations fold away; Quality shows a dash, not "no calls", for a week with nothing to count, and a hosted clinic no longer sees per-minute cost estimates. A vet clinic's screens say pet, owner and veterinarian everywhere (search, booking, the call page, Knowledge, the audit log) and import pets from a pet spreadsheet (`readPets`, `petTemplate`). Record ids, not "patient ids", in Integrations. The audit log names every action in words.

- **A vet clinic's screens speak of pets.** Adding or editing a pet asks for its name, the kind of animal, its sex (female, male or unknown), its birthday, the owner's full name and the owner's phone, and stores it the way the assistant does (the owner's last name, the owner as the guardian), so the assistant finds it on the owner's next call. The API needs the owner's first and last name for every pet, whatever its age, and keeps the kind of animal (`species` on `PatientInput`) when an edit leaves it out. "Add veterinarian", "Takes new pets", "New pet to check", and the details the assistant gathers for a new pet (Pet, Kind of animal, Sex, Owner, Birthday note) are labelled in words on Requests.

- **Account links in the menu open their page.** Links from `ATTENDRA_ACCOUNT_LINKS` point at another app on the same address, so they now load the page instead of trying to switch inside the dashboard, where the click did nothing.

### API changes for integrators

- Request outcomes `refill_ready` and `refill_declined`, in the API, the `request.done` webhook and the MCP `mark_request_done` tool.
- `GET /clinics/:clinicId/test-calls/allowance`. `QualityWeek` adds `afterHoursBookings`, `emergencies` and `refillRequests`; the overview's periods add `emergencies`; waiting tasks add `byType`; each clinic in `/me` adds `accountLinks`. Settings add `averageVisitValue` (default 150).
- `/me` adds `twoFactorRequired`.
- `GET /clinics/:clinicId/texts?callId=|taskId=|patientId=|appointmentId=`. `GET /settings` returns an `ETag`; `PUT /settings` takes `If-Match` and may answer 409 `settings_changed`. `PATCH /members/:userId` takes `approvesRefills` as well as `role` (either or both); members and each clinic in `/me` carry `approvesRefills`. Closing a refill as `refill_sent`, `refill_ready` or `refill_declined` answers 403 `refill_approval_required` for anyone not marked; MCP `mark_request_done` answers `status: refill_approval_required`.
- `send_text` tool (only offered to a clinic that texts); `get_clinic_info` returns `texting` (kinds and links). Settings add `texting`, `greetings`, `talk`. Text templates `change_confirmed`, `cancel_confirmed`, `directions`, `hours`, `emergency_hospital`, `provider`, `answer`, `link`.
- The `Messenger` port returns a result (`sent`, `already`, or `not_sent` with a reason) and never throws.
- `POST /appointments` and `/appointments/:id/reschedule` take `override` and `overrideReason` (needed with `override`); appointments carry `overrideReason`, `confirmedAt`, `confirmedVia` and `reminderSentAt`; slot refusals add `away`. Patients carry `textsOk` and `textsOkSource`, and take `textsOk`. Settings add `specialDays`, `texting.reminders`; time off takes `start` and `end` for part of one day. New webhook event `appointment.confirmed`; new tool `set_reminder_consent`; text template `reminder`.

## [0.7.0] - 2026-10-16

### Added

- **The veterinary pack.** An account with `industry: vet` answers for a veterinary clinic. The patient is a pet, found by its owner's full name, its own name and the owner's phone, with the same rules as for a person (three tries, the same answer whichever detail was wrong, two pets with the same name on one number go to staff). A new pet is added with its owner as the guardian, its kind of animal and its birthday or age; an age becomes an estimated date of birth, and the front desk is asked to check the new pet. The dashboard says Pets and Veterinarians. The planner's rules and the identity tools follow the pack (`verify_caller` takes `owner_name` and `pet_name`; `register_patient` takes `pet_name`, `owner_name`, `species`, `sex` and `birthday_or_age`).
- **Animal emergencies.** A phrase list in English and Spanish, checked before the engine's: toxins and swallowed objects, breathing, trauma, collapse and seizures, bloat, a cat that cannot urinate, heatstroke and difficult births. The script sends the caller to the clinic's emergency hospital (`emergencyHospital`: name, phone, address) or the nearest 24-hour emergency vet, and tells a person in danger to call the emergency number. No first-aid advice. Staff cannot end the call before the hospital's name has been said. A person in danger is still covered by the engine's list, and self-harm language always comes first. See `docs/safety.md`.
- **After-hours requests.** A new `afterHours` setting for every pack: `book` (as before, the default) or `requests`, where nothing is booked or cancelled while the clinic is closed and the caller's visit becomes a request for the team.
- **A demo veterinary clinic**, Riverbend Animal Hospital, with four pets and its own demo login ("Vet clinic manager"), and 10 call scenarios for it.

### Changed

- **Medical questions.** "Should I give him some of my ibuprofen", "can we give her Benadryl" and "is that serious" are refused like "should I take", for clinics and veterinary clinics alike.
- **Test calls**: a microphone setting the browser does not report is shown as unverified, not taken as on.
- The latest stack: PGlite 0.5.10, pglite-pgvector 0.0.11, Playwright 1.64.1.

### API changes for integrators

- Clinic settings have `emergencyHospital` and `afterHours`, and `industry` may be `vet`.
- `propose_booking` and `propose_cancellation` may refuse with `after_hours`; a veterinary clinic's tools may refuse with `owner_full_name` and `unclear_age`.
- New-pet review requests carry `pet_name`, `species`, `sex`, `owner_name` and, for an estimated date of birth, `date_of_birth_note`.

### Upgrading

Migration 0024 adds the encrypted kind of animal to patients. Nothing else to run.

## [0.6.0] - 2026-10-15

### Added

- **Industry packs.** The engine and the trade are now separate. An account's `industry` setting (default `clinic`) picks a pack that names things (the business, who is booked, who can be booked) and adds the conversation prompt lines that depend on the trade: how to identify who a visit is for, preferences about who they see, and what the assistant must never do. The dashboard menu, page titles and the command palette use the pack's words. Medical clinics are the first pack, and their prompt is unchanged word for word. See `docs/industries.md`.
- **Test calls check the microphone.** After the microphone starts, the Test call page reads what the browser actually applied and warns when echo cancellation or noise suppression is off.
- **Doctors' names in other languages.** The doctor panel has an "In Spanish" field (one per extra language the clinic speaks), so the assistant says a doctor's name the way Spanish-speaking callers say it.

### Changed

- **At most five new patients per phone number in a day.** The assistant already added at most three on one call; registering now also counts patients added on calls from that number in the last 24 hours, and past five it refuses with `daily_registration_limit` and offers a callback. Someone already on file is still found by the identity check.

- **The latest stack.** Next 16.4, the OpenAI SDK 7.33 (with the new GPT-Live voice "Shida" in Settings), radix-ui 1.8, pg-boss 12.38, Twilio 6.2, Playwright 1.64 and the latest patch of everything else. TypeScript stays on 6.0 until typescript-eslint supports 7.

### API changes for integrators

- Clinic settings have an `industry` field (`clinic`). Existing configurations read as `clinic`.
- `register_patient` may refuse with `daily_registration_limit`.

### Upgrading

Nothing to run. No migrations in this release.

## [0.5.2] - 2026-10-04

From a browser test call where a parent booking for a child was asked for the same details over and over, waited half a minute in silence, and was hung up on mid-sentence.

### Fixed

- **A date of birth that cannot exist is named, not just refused.** "29 February 2025" gets "February 29 is not a date in 2025, which is not a leap year", and the caller is asked to check the date only. The assistant keeps the name and phone already given instead of asking for everything again, and a date that cannot exist does not count as a failed identity check.
- **The assistant passes what the caller said to the backend** instead of judging a date itself, so the backend's checks and wording apply every time. Someone who says they are new is still looked up first with the details they gave.
- **The assistant never hangs up on a caller who has not finished.** Ending a call takes two steps: the assistant asks "Is there anything else I can help you with?", and the caller answers no or says goodbye. `end_call` is refused otherwise, even after a goodbye that came before the question, and "I'm done" at the end of a phone number no longer ends the call. A frustrated caller with an unfinished request is offered what the assistant can still do, or a callback.
- **A goodbye is never cut off.** The hang-up waits until the assistant has been quiet for 1.5 seconds, up to 20 seconds.
- **Other languages.** A caller speaking a language the clinic does not offer is told, kindly and in one sentence, that the assistant can only help in English (or the clinic's languages), and is asked to carry on in it or offered a callback.
- **A call that ended unfinished becomes a request.** Once a call is summarised, a flagged call that booked, changed or transferred nothing, and opened no other request, opens a "Follow up" request on the Requests page with the reason and the suggested next step, linked to the call. One per call; emergencies keep their own place on Today. Closing it marks the call reviewed, and Today lists the call once, as the request.
- **No long silences.** When a request runs longer than 7 seconds, the caller hears once that the assistant is still checking.
- **Test calls**: the page asks for headphones in a quiet room, since laptop speakers let the assistant hear itself and background voices are taken for the caller. Automatic gain control is on for the microphone.

### API changes for integrators

- Requests have a fifth type, `follow_up`, in `GET /tasks`, `POST /tasks/search`, the waiting list, the `request.created` webhook and the MCP `list_open_requests` tool.

### Upgrading

Migration 0023 widens the request types on its own. Nothing else to run.

## [0.5.1] - 2026-10-04

### Added

- **Gender for patients and doctors.** Female, male, other, or prefers not to say, required for every patient added or changed, on the form, in the CSV import and when the assistant adds a new patient (it asks, and never guesses). Stored encrypted like the other details about a person. Patients from before keep an empty value until the front desk adds it, and their record says so.
- **A female or a male doctor on request.** Each doctor has a gender; a caller who asks is offered only those doctors (`find_slots` takes `provider_gender`), and told when there is none for that visit.
- **Doctors by specialty.** When a caller has not named a doctor, the assistant asks once whether they want a particular doctor or kind of doctor, matches the answer (pediatrics, a pediatrician, women's health) to the clinic's own specialties and categories, suggests those doctors by name and offers their times (`find_slots` takes `specialty`). When the clinic has no such doctor it says so and lists what it has. It never decides from symptoms what kind of doctor someone needs. `get_clinic_info` returns each specialty with its doctors.
- **Doctors page filters**: by specialty and by what they see people for, sorted by name or specialty. The Schedule's provider list shows each doctor's specialty.

### Fixed

- Doctors page: each day's hours on a line of its own, category badges no longer stretch, and the hour fields in the edit panel show the whole time.
- Turbo no longer writes an `AGENTS.md` into the repository (`agentGuidance: false`).

### API changes for integrators

- `POST /patients` and `PATCH /patients/:id` require `gender`; patient responses carry it (null for a patient from before 0.5.1).
- Doctors added or changed through `/doctors` require `gender`. The patient CSV template gains a required `gender` column, the doctor template an optional one.

### Upgrading

Migration 0022 adds the column on its own. Nothing else to run.

## [0.5.0] - 2026-10-04

Doctors, families and a dashboard that updates as it happens, from what the first browser test calls showed: the assistant could not name the doctors or say who sees children, new patients could not get past the identity check, and staff had to refresh to see new requests.

### Added

- **Doctors.** Each has a specialty, what they see people for, the ages they see, whether they take new patients, weekly hours and days off, on a new Doctors page. Managers add, edit and remove them (a doctor with visits still to come cannot be removed), or import a CSV from a template. The assistant describes them to any caller and answers "who is free Monday" without asking who is calling first.
- **The assistant reads the clinic again before every request**, so a doctor added or a day off set in the dashboard counts on calls already under way.
- **New patients on the call**: after the identity check finds nobody and the caller says they are new, the assistant adds them (`register_patient`) and books a new-patient visit with a doctor who takes new patients. Every patient it adds becomes a request for the front desk, closed with Details checked. It cannot be used to get round the three-try limit, adds at most three people a call, and until the front desk confirms them texts only the number the caller is ringing from.
- **Families**: a parent books for each child on the family phone, switching between them on one call. Patients under 18 have a parent or guardian on file; a patient's page lists everyone on the same number.
- **Doctors by age**: once the patient is known, only doctors who see their age are offered.
- **Patient import** for managers, from a CSV template: every row checked first, the same person skipped, safe to run twice.
- **Live dashboard**: Postgres notices (clinic and kind of change only), one Server-Sent Events stream per clinic, and every screen re-reads what changed. New requests, bookings, patients, calls and doctors appear without a refresh ([decision 10](docs/decisions/0010-live-updates.md)).
- **Search as you type**, from the first character: names, any digits of a phone number, dates of birth. Requests can be searched and narrowed to the days they came in.
- **Cancellations as a history**: the schedule shows booked visits, booked and cancelled, or cancelled only as a list sorted by when the visit was due or when it was cancelled.
- Visit types say who may book them: anyone, new patients only, or patients on file only.
- Four eval scenarios from the test calls: the doctors and their open times, a new patient booking, a parent booking a child, the right name with the wrong phone.

### Changed

- **A patient is identified by name, date of birth and phone together** ([decision 9](docs/decisions/0009-patient-identity.md)). Phones are compared on their last nine digits, so a number written with or without its country code, or with a leading 0, is the same number. Phone is required for every new or changed patient. Two people with the same name and birthday are told apart by phone instead of being sent to staff; the same person cannot be stored twice. `verify_caller` takes the phone on file, or uses the calling number.
- The newest come first: requests, the waiting list on Today, and patients before anything is typed.
- Doctors are edited on the Doctors page; saving Settings keeps the doctors on file.
- The demo clinic has a pediatrician, Dr. Priya Raman, and Maria Delgado's two children on her phone.
- The stack: Node 24 (current LTS), pnpm 12.8, TypeScript 6.0, Next 16.3.8, NestJS 12.1.2, PGlite 0.5.8, Postgres 18 with pgvector 0.8.7 in Compose, and every other dependency at its latest. TypeScript stays on 6.0 until typescript-eslint supports 7.

### API changes for integrators

- `POST /patients` and `PATCH /patients/:id` require `phone`, and `guardianName` for a patient under 18. 409 `patient_exists` now means the same name, date of birth and phone; the response may carry `similar: true`.
- `POST /patients/search` answers from one character, and returns an empty list instead of 422 for text it cannot match.
- New: `GET /patients`, `POST /patients/:id/confirm`, `POST /patients/import`, `/doctors` (list, add, change, remove, import), `POST /appointments/cancelled`, `POST /tasks/search`, `GET /changes` (text/event-stream). Searches that take words are POSTs, so names and phone numbers never sit in a URL.
- `GET /tasks` lists open requests newest first, and takes `from` and `to`. The request outcome `details_confirmed` is new.
- `PUT /settings` no longer changes doctors.

### Upgrading

Postgres moves to 18 on a new Compose volume, migrations 0020 and 0021 run on their own, and `pnpm db:rehash-lookups` runs once. [docs/self-hosting.md](docs/self-hosting.md) has the steps.

## [0.4.1] - 2026-10-01

A correctness release from a full audit of 0.4.0: no new features. Webhook retries, emergency transfers, cancellations on the schedule and call page, tenancy keys, retention, audit rows, time zones and the docs are fixed, and the demo's calls now match their transcripts.

### API changes for integrators

- `invalid_request` is now always **422**. A request that failed its schema used to answer 400 with the same code; a client that checks for 400 should check for 422.
- Create routes now return **201 Created**: adding a patient, booking a visit and adding a team member used to answer 200 (test calls, API keys, documents and webhook endpoints already answered 201).
- Additions only, nothing removed: the request list gains `doneByName`, the waiting-requests route gains `total`, and a call's appointments gain `createdAt`, `updatedAt` and `moved`.

### Fixed

- The webhook delivery queue keeps its own retry policy (12 tries over about a day) when the worker starts with the defaults.
- A caller who says "this is an emergency" and then describes chest pain still gets the on-call transfer, once.
- Turning a webhook endpoint off and on keeps its description and its patient-id choice.
- The documented MCP stdio bridge prints only JSON on stdout (`pnpm --silent`).
- `pnpm demo` passes its switches (simulated calls, local webhooks, ports, log level) through turbo.
- Uploading the same document after the embedding model changes indexes it again, and a document stuck waiting is picked up.
- Blank environment values count as unset, and every port is checked to be a real port.
- A dropped Postgres connection is logged by its code instead of ending the service.
- A tool step that could not be recorded still gives the caller its result.
- Open times are offered earliest first across all providers, not provider by provider.
- Patients whose names use letters such as ø, ł, æ or ß can be verified. Existing installs run `pnpm db:rehash-lookups` once (docs/self-hosting.md).
- A booking moved back to an earlier time sends its own webhook event.
- The planner creates the callback it promises when it runs out of steps, to the number the caller rang from.
- A refreshed transcript or request view is audited once per five minutes, not on every refresh.
- The call page says when a booking was cancelled or moved since the call, and its header says Booking since cancelled.
- A call name search keeps its refusal filter.
- Two cancels of the same visit at once give one cancellation.
- The phone assistant will not book a patient into two overlapping visits.
- Rows can no longer point into another clinic: migration 0017 adds composite foreign keys, and stops with a count if existing rows would break them.
- The application role no longer reads the organization and phone number tables, which it never needed (migration 0018).
- The retention purge also deletes webhook events and their delivery attempts, and audits each batch in its own transaction.
- A call's opening and closing are audited (the close with how many transcript lines and tool steps it wrote), and so are patients created outside the front desk and a patient-busy refusal.
- MCP reads are audited under the key and in the read's own transaction; closing a request no longer claims to be idempotent; a working key is not locked out by another client's failed attempts; today's schedule includes midnight; the server reports its real version.
- A coaching note or take-over that fails can be tried again.
- A team member whose add failed can be added again.
- The day starts at 01:00 where daylight saving time begins at midnight (Havana, Santiago, Asunción).
- A failed migration file is rolled back.
- The week view keeps a visit cancelled from the panel on screen, and says how many cancelled visits are hidden.
- N and New booking work while the Schedule is already open.
- The Settings saved message can be seen.
- Today no longer lists calls still in progress as ended with nothing done, counts every waiting request, and marks each request type with its own icon.
- A live page whose stream has closed for good opens the call record.
- Pages a role cannot use say so on a direct link, and a viewer's browser no longer opens live streams.
- A closed request can be opened from its call, and says when and by whom it was closed.
- A saved time zone shows on every page at once.
- Your take-over number can be changed or cleared.
- The audit log shows every action and actor in words.
- Error messages: a refused booking says why, an empty upload says so, a failed redelivery says so, request errors show once, and the start page says so when the server fails.
- Ages and date-of-birth limits use the clinic's date; the clock and costs follow the clinic's country.
- Documentation: the README screenshots are current, and the guides, CHANGELOG and comments match the code.

### Changed

- A request that fails validation now answers 422 `invalid_request`, like every other refusal, and every create route answers 201.
- The request list returns `doneByName`, and the waiting-requests route returns `total`.
- The Calls tab Needs attention is now Emergencies and requests; Today's labels say the last 7 days; dates are day first everywhere.
- Staff read "request", never "task".
- The unused `booking_cancelled` text and the always-empty `call_actions.idempotency_key` column (migration 0019) are gone.
- The emergency number rules for a country Attendra does not ship for are removed; a clinic there uses 112, like any country not listed.
- Text delivery statuses are marked as not wired yet.
- The root `pnpm dev` is removed; use `pnpm demo`, or a service's own `dev` script.
- Docker Compose restarts every long-running service, and the MCP port is fixed inside its container.
- CI pins every action to a commit.
- The development guide is now docs/development.md.

## [0.4.0] - 2026-09-30

The AI layer: a design system, the clinic's own assistant in English and Spanish, call summaries, live calls with coaching, clinic knowledge, signed webhooks, the Quality page and an MCP server.

### Added

- `apps/mcp`: an MCP server over stdio and Streamable HTTP, so other AI agents can work with the front desk: `find_open_slots`, `list_todays_schedule`, `list_open_requests`, `mark_request_done` and `get_quality_summary`. No tool books or cancels. The stdio server is a thin bridge to the HTTP one, needing only its address and a key. See [docs/mcp.md](docs/mcp.md), with a desktop MCP client's config.
- Settings > API keys: per-clinic keys with scopes (`schedule:read`, `requests:read`, `requests:write`, `quality:read`) and an expiry of 7 days to a year, shown once and stored only as a SHA-256 hash, revocable, and audited at every use as `mcp.<tool>`. A key works only while its maker is an owner or practice manager, is checked again at every tool call, and `/mcp` is rate limited.
- A Quality page for owners and managers: week by week, calls handled without staff, booking success, turns to a booking, why the assistant said no, transfers, calls flagged for review, after-hours calls and cost per call and per booking. Every number opens the calls behind it. See [docs/quality.md](docs/quality.md).
- `pnpm eval --live --judge`: a judge model scores each live transcript on outcome, no medical advice, disclosure, read-back, politeness and brevity, and writes `evals/reports/<date>.md`. The scripted evals are unchanged.
- `pnpm sim --scenarios 20`: a model plays the patient from personas in `evals/sim/personas.yaml`, against the real assistant as text, and the quality numbers are printed. The caller and the assistant are interfaces, ready for a voice simulation.
- A manual `quality` workflow runs both in the `quality` environment and keeps the reports. Only the two steps that call OpenAI get the key, a run is capped at 50 simulated calls, and every action is pinned to a commit SHA.
- Webhooks, under Settings > Integrations, for n8n, Zapier, Make or a clinic's own systems: `call.completed`, `call.summary.ready`, `appointment.booked`, `.rescheduled`, `.cancelled`, `request.created` and `request.done`, signed per the Standard Webhooks specification with a secret per endpoint that is shown once and can be rotated with a day's overlap. Payloads carry ids, times, types, outcomes and counts, never names or what was said, and each endpoint leaves patient ids out unless it is set to send them (a patient id with appointment times is PHI, so receivers need a BAA). See [docs/webhooks.md](docs/webhooks.md), with verification code in TypeScript and Python and an n8n recipe.
- Deliveries are worker jobs, retried 12 times with backoff from a minute to four hours, about a day, and logged with status codes and timings. Each delivery has a 10 second total deadline. The log has Redeliver, and Send test event tries an endpoint at once; both are limited per clinic. An endpoint that fails three events in a row is turned off, and owners and managers are told on Today.
- Only public HTTPS addresses are allowed (no private, 6to4, NAT64 or site-local IPv6 addresses), checked when an endpoint is saved and again after DNS at every delivery, with the connection pinned to the checked address. A new permission, `integrations:manage`, is for owners and managers.
- The clinic's knowledge: a practice manager uploads documents (PDF, text or markdown, up to 5 MB) under Settings > Knowledge, and the assistant answers from them, and only from them. Search is hybrid (pgvector and full text, fused), keeps the best four passages, and says "I don't have that information, I can have someone call you back" when nothing answers. An Ask a question box shows the answer and the passages it came from. See [decision 8](docs/decisions/0008-clinic-knowledge.md).
- A new `search_knowledge` tool, and `get_clinic_info` adds passages from the documents when the FAQ has no answer. A medical question (dosing, side effects, whether to take something) is refused in code before anything is searched, on the model's question and the caller's own words, in English and Spanish. During a call the question's embedding gets 4 seconds before the search falls back to full text.
- Documents are indexed by the worker, once per content: text extraction with unpdf (PDFs in a worker thread with a heap limit and a deadline, at most 200 pages and 2 MB of text), chunks of about 500 tokens by heading and paragraph, and embeddings with `ATTENDRA_EMBEDDING_MODEL` (`text-embedding-3-small` by default), or local ones with no key. Uploads and deletes are audited.
- Five knowledge evals: parking, insurance, fasting before blood work, a question no document answers and a dosing question that must be refused.
- Live calls: Today and Calls show a Live now strip with each call's length, who is calling once verified, and what the assistant is doing. Opening one shows live captions that follow the conversation (and pause while you scroll up), the tool steps as they run, the read-back waiting for a yes, and an emergency banner the moment the guardrail fires. When the call ends the page becomes the call record.
- Staff on a live call can send the assistant a short note, take the call to the front desk line or their own number, or end it. A note never overrides the rules in code, and during an emergency it is followed by the emergency script again; End call waits until the caller has heard the emergency number. Each action is audited before it runs, sent once per click, and a second person is told who already has the call; a transfer or hang-up that fails frees the call and the assistant offers a callback. Take-over numbers must be in the clinic's country and are audited by their last four digits. Every live stream opened is audited, and a stream ends after 60 minutes and re-checks the watcher every 5. A browser test call cannot be transferred. A new permission, `calls:coach`, is for owners, managers and front desk staff.
- An opt-in sound and notification when an emergency starts on any live call, kept per browser.
- Simulated calls in the local demo: a scripted booking call through the real assistant, with no audio and no OpenAI, from Test call. The e2e suite watches, coaches and ends one.
- A summary of every call, written by a new worker service (`apps/worker`, on pg-boss in the same Postgres). It holds two or three sentences for staff, what the caller wanted, how they came across, whether the call needs review and why (fixed rules flag emergencies, unverified callers, records only staff can pick and calls that ended on an error, whatever the model says), and a follow-up suggested by the assistant. It is encrypted, written once per call, and audited. Without an OpenAI key it is written from the call's facts alone.
- The call page shows the summary with intent and sentiment badges and the review flag, and a flagged call can be marked reviewed. The call list has a Needs review filter, Today lists flagged calls, and requests the assistant created show the suggested next step.
- A retention period per clinic (`retentionDays`, 2555 days by default): a nightly job deletes older transcripts, summaries and call actions in batches and audits how many.
- Background jobs retry with exponential backoff and then go to a dead-letter queue. The `worker_jobs` view shows each clinic its own jobs, with a failure code and never an error's message.
- The assistant can have a name ("Maya"), which it introduces itself with. A name never counts as the AI disclosure: the greeting must still say AI assistant, and Settings warns about a greeting that names the software.
- Spanish. Each clinic chooses the languages its assistant speaks and a primary language; calls start in the primary one and follow the caller. Offered times, read-backs, text messages and the emergency script are in the caller's language, and visit types and providers can have a name in each. See [docs/languages.md](docs/languages.md).
- The emergency guardrail works in every language on every call; the clear-yes check hears a yes in the clinic's languages and a hedge in any. The emergency script gives the clinic's emergency number, chosen from its country's list (911, 999, 112, 000), and names 988 only in the United States. Poisoning, stroke and throat-swelling phrases are covered in both languages.
- A second demo clinic, Cedar Park Clinic, in an organization of its own, with its own login (`frontdesk@cedarpark-demo.test`) that sees only that clinic.
- Settings > Assistant and languages: the assistant's name, the languages, the primary language, the emergency number, and a greeting preview in each language.
- Five Spanish evals: a booking, a hedge, chest pain, a refill and three wrong dates of birth. Scenarios can name their clinic and check the call's language, what was said and which FAQ answered.
- Dates of birth can be said with Spanish month names, and a numeric date is read day first outside North America.
- A design system for the dashboard: semantic colour tokens for light and dark, Inter self-hosted, one type scale, three radii, two shadows and one focus ring, and a component kit (buttons, fields, switches, tabs, panels, menus, tooltips, toasts, stat cards with sparklines and more). See [docs/design.md](docs/design.md).
- Dark mode, chosen per person (system, light or dark) and applied before the first paint.
- A command palette (Cmd+K or Ctrl+K) to jump to a page, find a patient, start a booking or a test call, or switch the theme, and keyboard shortcuts (G then T, S, P, R or C; N; ?).
- Request actions update at once and roll back if the server refuses, with a toast, and Undo after a claim. Today opens with four stat cards and seven-day trends; `/overview` returns per-day counts for them.
- The sidebar collapses to icons from 1024 px, and a phone gets a bottom bar. Every main page is checked with axe in light and dark in the e2e suite.
- New tables and columns, in migration order:
  - `0009_call_summaries.sql`: `call_summaries` (encrypted text, with Row Level Security), `audit_logs.counts` for audit rows that record how much was done, and `sms_messages.provider_sid`.
  - `0010_staff_transfer_number.sql`: an optional `transfer_number` on memberships, for taking over a live call on your own phone.
  - `0011_knowledge.sql`: `knowledge_documents` and `knowledge_chunks` (with an HNSW index and a full-text index, and Row Level Security).
  - `0012_webhooks.sql`: `webhook_endpoints` (secrets encrypted), `webhook_events` and `webhook_attempts`, with Row Level Security.
  - `0013_api_keys.sql`: `api_keys`, with Row Level Security.
  - `0014_webhook_patient_ids.sql`: `webhook_endpoints.omit_patient_ids`, on by default.
  - `0015_api_key_update_columns.sql`: the application may change only an API key's `revoked_at` and `last_used_at`.
  - `0016_call_summaries_same_clinic.sql`: each call summary is tied to its call's clinic with a composite key.

### Changed

- Request bodies over 512 KB are refused on every route but the knowledge upload, which takes up to 5 MB.
- The demo schedule gives nobody more than two upcoming visits, with more invented patients to fill it.
- The roadmap: v0.4 is done, and v0.5, the revenue release, is next.
- A call where the assistant answered a question from the FAQ or the clinic's documents now ends with the outcome `info` rather than `abandoned`.
- The call list takes `refusal=<code>`, and the Calls page reads its filters from the address.
- Compose runs `pgvector/pgvector:pg16` instead of `postgres:16`; `docs/self-hosting.md` has the one-step upgrade.
- The e2e suite signs in fewer times: the stored manager session stays signed in, and the sign-out test ends the second demo clinic's session instead.
- `GET /me` says whether simulated calls are available (`simulatedCalls`), and `testCalls` is now true only when the voice service takes real browser calls.
- The planner's model calls now have a 15 second timeout and a cap of 1,000 output tokens per round.
- `ClinicConfig` gains `assistantName`, `languages` (default `["en"]`), `primaryLanguage` (default `"en"`), `emergencyNumber` and, on visit types and providers, `names`. Existing configurations keep working unchanged. The greeting's disclosure check now accepts any of the clinic's languages.
- The demo clinic's assistant is called Maya and speaks English and Spanish.
- The call page shows the summary as soon as it is written, and a call ended from the dashboard says "Ended by staff". Staff notes and actions appear in the live timeline, while the audit log keeps only a note's length.
- Voice and time zone are chosen from lists. Recording and example wording follows the clinic's country. A provider can be a person or a room, and read-backs say it correctly in each language.
- The demo signs in with one click, and its current week reads like a working clinic, from real demo calls through the real agent. A refused medical question is summarised as one and flagged for a callback.

## [0.3.0] - 2026-09-30

The working front desk: test calls from the browser, the schedule, patients, the Today screen, requests and the team.

### Added

- Test calls from the browser: a Test call page in the dashboard talks to the clinic's receptionist through the microphone over WebRTC, with the live settings and the same tools and guardrails as a phone call. Only an OpenAI key is needed; `pnpm demo` turns it on when it finds one. See [docs/test-calls.md](docs/test-calls.md).
- Calls record where they came from (`phone` or `web`). Browser tests are marked in the call list and on the call page, and each one is audited with the person who started it, in the same transaction as the call row.
- Test calls end on their own after `BROWSER_CALL_MAX_SECONDS` (300 by default), a clinic can have two open at once, and they never send texts.
- The Schedule: every booking in a day or week view with a column per provider, opening hours shaded, holidays marked, cancelled visits struck through, and who booked each one (the assistant or a named staff member). The front desk books, moves and cancels from a side panel and a four-step New booking flow that offers only real open times.
- Staff bookings follow the assistant's rules exactly: the same slot search decides what is bookable, the same write stops double booking, and every change is audited and idempotent. Cancellations record a reason from a fixed list.
- The call page shows what the call booked or cancelled ("Booked: Tue 6 Oct 3:00 PM with Dr. Okafor") with a link to it on the schedule.
- Patients: search by name, date of birth or full phone number (as a POST, so what is typed never reaches a URL or a log), a list of the patients you opened recently, and Add patient. A patient's page shows their age, date of birth, phone and usual provider, with tabs for appointments (book, move and cancel from there), the calls they were verified on, their requests, and their details to edit. See [decision 7](docs/decisions/0007-patient-search.md).
- Patients added or edited at the desk get the same lookup and phone hashes the voice path uses, so the assistant can verify them on their next call. Someone with the same name and date of birth as a patient on file is refused, with a link to the existing record.
- Calls are linked to the patient the assistant verified (`calls.patient_id`), never from the calling number alone. The call page shows who was calling with a link to their record, and New booking can find a patient or add one without leaving the flow.
- Today, the new home screen: what needs someone (emergencies from the last day, requests nobody has claimed with how long they have waited, calls that went to a person or ended with nothing done), each with one action; today's appointments for each provider with the next one marked and the open gaps shown; what the assistant did today and over 7 days, down to talk minutes and an estimated cost; and the latest calls. It refreshes every 30 seconds.
- `GET /overview` counts calls, bookings, changes, requests, handovers, after-hours calls and talk time in the database, with no patient data, so a viewer sees it too. `GET /tasks/waiting` lists unclaimed requests by type and age only.
- Requests (what the dashboard called Tasks): each type explained in a line at the top, filters by type, status, assigned to me and unassigned, the patient and the call each one came from, how long it has waited and who has it. Staff add internal notes, which are encrypted and never edited, and close a request with an outcome ("Called back", "No answer, left a message", "Refill sent to the pharmacy", "Not needed"). Owners and managers can assign one to a teammate.
- Calls: filters by date range, outcome, channel and emergency, a search by patient name (a POST, matched through the verified patient), and a Caller column with the verified patient's name, or "Unknown caller".
- Team: owners and managers list the people who can sign in, with their role and whether they have set up their password and two-step sign-in; add someone and see a temporary password once, to pass on in person; reset a password; change a role; and remove someone. A manager cannot touch an owner or make one, nobody changes, resets or removes themselves, and there is always an owner. Each change and its audit rows are one transaction with the team locked, so this holds under races too.
- A temporary password is for one sign-in and 72 hours. The person chooses their own password before anything else, two-step setup included, so whoever read the temporary one out never holds a working password for them; every other session ends when they do. `pnpm add-member` passwords are temporary too. An email that already has an Attendra account with another practice is refused (`account_exists`) rather than added.
- The front desk cannot book a patient into a time that overlaps another of their appointments, with any provider, and a booking key sent again for a different booking is refused (`idempotency_mismatch`).
- The menu is grouped the way a front desk works: Today; Front desk (Schedule, Patients, Requests, Calls); Assistant (Test call, Settings); Admin (Team, Audit log). The audit log has plain words for every action and names people for owners and managers.
- `pnpm demo` fills three weeks of the demo calendar around today: the demo calls' own bookings, linked to their calls, and about 60 percent of the rest booked by staff, with a few cancellations.
- `/api/v1/me` says whether the deployment has test calls (`testCalls`).

### Changed

- Migration `0005_call_patient.sql` adds `calls.patient_id`, set in the same transaction as the tool action that verified the caller.
- The redacting logger also replaces `query` and `search` fields.
- Migration `0004_staff_scheduling.sql`: appointments record the staff member who booked or cancelled them, a cancel reason, an encrypted note and an update time, and a booking must come from a call or a person.
- A screen that refreshes a patient-data view on a timer (the schedule) writes one audit row per person per view every 5 minutes, instead of one every 30 seconds.
- The voice service starts without Twilio or a webhook secret. Without Twilio, texts are recorded as not sent; without the secret, phone calls are refused.
- An empty line in `.env` counts as not set for the voice service's settings and for `VOICE_URL` and `VOICE_INTERNAL_TOKEN`.
- The dashboard allows its own pages to use the microphone (`Permissions-Policy: microphone=(self)`); camera and location stay off.
- Signing in now opens Today instead of the call list.
- "Tasks" are "Requests" everywhere in the dashboard, and `/tasks` pages move to `/requests`. The API keeps the name `tasks`.
- Migration `0006_request_notes.sql` adds `task_notes` (encrypted, insert-only for the application role, with Row Level Security) and a request's outcome and who assigned it.
- The call list names the verified caller for roles that may read calls, and audits that view once per 5 minutes; a viewer's call list still has no patient data.
- `POST /tasks/:id/done` takes an optional `outcome`.
- Migration `0007_password_change.sql` adds `must_change_password` and `temporary_password_expires_at` to `auth_users`. `POST /api/auth/change-password` joins the auth allowlist; the API answers 403 `password_change_required` until it has been used.
- Migration `0008_same_clinic_links.sql`: composite foreign keys keep `calls.patient_id` and `task_notes.task_id` inside one clinic, since Row Level Security does not cover foreign key checks.
- A repeat view is only folded into an earlier audit row when every parameter of the view and every patient it showed are the same. Searches write one `patient.search.result` row per patient shown.
- Removing someone from the team releases the requests they held, and signs them out only when they belong to no other practice. The Team page no longer shows a last sign-in time, which could not be told apart by practice.
- Moving and cancelling at the desk only change a booking that is still booked, so a cancel that landed a moment earlier is reported instead of undone. Dates of birth are checked against the clinic's date.

### Fixed

- The demo moved its own bookings forward in milliseconds, so after a clock change a visit shifted by an hour. It now moves them by whole weeks of local time.
- The week view's provider headers showed initials; they show the short name, with the full name on hover.
- A clear "yeah" to a read-back was refused when the assistant began speaking before the proposal was back and read it out in the same breath. Any assistant speech after the proposal now counts as the read-back.
- A cough or breath the transcriber marks in brackets ("[clear throat]") after the caller's yes made the yes not count. Bracketed sounds are now ignored.
- The assistant could not answer "are you open tomorrow?": clinic info now carries the next seven days of hours.
- The planner did not know today's date, so "next week" became today. Its prompt now states the date, and `find_slots` says how to set `from_date`.

## [0.2.0] - 2026-09-29

The front desk: a staff dashboard, its API, and demo mode.

### Added

- The staff dashboard (`apps/web`) and its API (`apps/api`): the call list with outcomes and flags, each call's transcript and tool steps, the refill and callback queue with claim and done, clinic settings, and the audit log.
- Sign-in with Better Auth: organizations, four roles (owner, admin, staff, viewer), TOTP two-factor required before any clinic data, 12-hour sessions, no public sign-up. People are added with `pnpm add-member`.
- Every transcript and task view is audited in the same transaction as the read. A clinic you do not belong to answers 404.
- The task queue: claim, release (owners and admins can release anyone's), done. The menu badge uses a count that reads no patient data.
- The dashboard signs out after 15 idle minutes and clears its cache on sign-out. API responses are never cached.
- Demo mode: `pnpm demo` starts the API on an in-memory Postgres with a week of calls played through the real agent, plus the dashboard. Docker Compose does the same with `ATTENDRA_DEMO_MODE=true`, with the demo password taken from `ATTENDRA_DEMO_PASSWORD` and transfer numbers locked.
- `pnpm db:add-number` points a phone number at a clinic. [docs/live-call.md](docs/live-call.md) walks a small server to a real test call.
- Call scenarios carry the assistant's spoken reply, checked against `forbid_spoken` like everything else it says.
- End-to-end dashboard tests (Playwright) in CI.

### Fixed

- Read-backs said "a annual physical"; they now use "an" before a vowel.
- `pnpm db:seed` could create a second copy of each demo patient when run twice, and reset the clinic's settings on every start.
- CI's sign-off check read the merge commit GitHub builds for a pull request, which is never signed, so it failed on every pull request.

## [0.1.1] - 2026-09-28

Security and CI fixes after the first release.

### Security

- The OpenAI webhook has a per-address rate limit (600 a minute by default) and answers 429 above it. The health check is not limited.
- drizzle-orm moves to 0.45.3 for CVE-2026-39356 (SQL identifiers were not escaped). Attendra builds identifiers only from its own schema, never from caller input, so it was not exploitable here.

### Changed

- CI runs the gitleaks CLI, pinned and checksum-verified, and the current major versions of the GitHub actions.

## [0.1.0] - 2026-09-28

First public version.

### Added

- Inbound calls over Twilio Elastic SIP Trunking to OpenAI GPT-Live, with webhook signature verification, delivery de-duplication, and SIP 404 for numbers no clinic owns.
- Client delegation: a backend planner (Responses API, `store: false`) that works only through guarded tools.
- Identity check by full name and date of birth, three attempts, identical answers for "not found" and "wrong date".
- Built-in scheduler with provider hours, visit lengths, lead time, holidays, idempotent booking and a database-level guarantee against double booking.
- Two-step writes: propose, read back, commit only on a clear yes in the caller's own words.
- Emergency guardrail on every caller transcript fragment, with 911 and 988 scripts and an optional delayed transfer to the on-call line.
- Refill and callback requests as staff tasks.
- Templated SMS confirmations, sent at most once per booking.
- Postgres schema with Row Level Security on every clinic table, AES-256-GCM encryption for PHI columns, keyed-hash lookups, an append-only audit log.
- A logger that redacts PHI by field name and by pattern.
- 15 call scenarios run by an in-process simulator on every pull request.

### Security and safety hardening before release

- The emergency guardrail keeps listening after its first match, refuses writes for the rest of the call and drops in-flight requests; the bare word "emergency" no longer rings the on-call line.
- A yes counts only if spoken after the read-back began; a pending change with no read-back cannot be committed.
- Outdated requests cannot write. Transfers and hang-ups wait for the spoken result.
- PHI ciphertext is bound to its clinic, table and column; lookup hashes are per clinic.
- Confirmations go to the phone number on the patient's record, retry after a failed send, and are audited.
- Call setup failures reject with SIP 503 or hang up, never leave the caller in silence; one call is accepted once even when it arrives as both webhook types.
