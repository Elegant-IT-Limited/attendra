# Customising a clinic

Everything here is in the dashboard, for owners and practice managers, and in the clinic's settings for the API (`PUT /api/v1/clinics/:clinicId/settings`). The assistant uses a change from the next thing a caller asks.

| What | Where | What the assistant does with it |
|---|---|---|
| Visit types: name, length, who can book, a description, "Team books it" | Settings, Visit types | Offers the visit; gives the description when asked. A visit the team books itself is never offered as a time: the assistant takes a request instead. |
| Visit types: notice (hours), up to how many days ahead, minutes free after | Settings, Visit types | Offers no time sooner than the notice (never under 2 hours) or past the last day; a caller asking for a later day hears the last day and is offered a request (`too_far_ahead`). The minutes free after each visit are kept on calls and at the front desk alike, and the time grid steps by visit plus buffer. The front desk is not held to the notice or the days ahead. |
| Doctors or veterinarians: specialty, what they see, ages, hours, days off, qualifications and certifications | Doctors (Veterinarians) | Offers the right person; mentions qualifications when asked. |
| Offers and announcements, with optional dates | Settings | Answers callers who ask, only while each one runs. |
| Kinds of request, with what to ask for each | Settings | Asks for what you listed and labels the callback request with the kind, shown on Requests. |
| Answers to common questions, and documents | Settings, Knowledge | Answers from your words, and never invents the rest. |
| Hours, holidays, what happens while you are closed, the emergency hospital | Settings | Books inside your hours; takes requests or books after hours, as you chose. |
| Fields on each patient or pet: a label and a kind (text, yes or no, date), up to 20 | Settings; filled in under Details on each record (`PUT /api/v1/clinics/:clinicId/patients/:patientId/fields`) | Not used on calls. Encrypted like the rest of the record; saving is in the audit log, without the values. Removing a field hides what was filled in. |
| Urgent and a due day on each open request | Requests (`POST /api/v1/clinics/:clinicId/tasks/:taskId/plan`) | Not used on calls. Urgent requests lead the open queue; a due day shows as Due or Overdue. Audited. |
| VIP callers: a name and a phone number, up to 50 | Settings | While a front desk route applies (Routing), the assistant greets a VIP caller, says it is connecting them, and transfers the call once it has finished speaking. Outside those hours, or with no front desk route, it answers them like anyone else. A failed transfer is handled as any failed transfer: the assistant offers a callback. |
| Voice, with a Listen button | Settings, Greeting and voice | Speaks in that voice. Listen plays the saved greeting in it (needs an OpenAI key on the API; a voice the speech model lacks says so). |
| Emergency hospitals: up to 5, in order of preference, each open 24 hours or between set times | Settings | Sends an animal in danger to the first choice open at that moment; with none open, to the nearest 24-hour emergency vet. |
| Clinic address and website | Settings | Gives them to a caller who asks. |
| Links in your menu | Settings | Not used on calls. Your own tools in everyone's menu, opened in a new tab. |
| Team members and their roles | Team | Not used on calls. No limit on members. |
| Texting during calls: on or off, which kinds (address and map, hours, emergency hospital, a doctor's details, answers, your links), your map link and links | Settings, Texting | Offers to text something the caller just heard; asks the exact question the backend gives it and sends only after a clear yes in the caller's own words, to the number they are calling from or the one on file. In an animal emergency, only the hospital's details. At most 3 per call. |
| Appointment changes by text | Settings, Texting | A moved or cancelled visit is confirmed by text, like a booking. |
| Greetings in your other languages | Settings, Assistant and languages | Said once when the caller switches to that language. Must say it is an AI assistant, in that language. |
| How the assistant talks: pace, style, small acknowledgements | Settings, Greeting and voice | Changes how it sounds (relaxed or brisk, warm or professional, "Got it" or not), never what it may do. |

The safety rules are not settings: the emergency guardrail, the medical-advice refusal, the identity check and the read-back before any change run for every clinic.
