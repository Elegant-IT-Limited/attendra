# Customising a clinic

Everything here is in the dashboard, for owners and practice managers, and in the clinic's settings for the API (`PUT /api/v1/clinics/:clinicId/settings`). The assistant uses a change from the next thing a caller asks.

| What | Where | What the assistant does with it |
|---|---|---|
| Visit types: name, length, who can book, a description, "Team books it" | Settings, Visit types | Offers the visit; gives the description when asked. A visit the team books itself is never offered as a time: the assistant takes a request instead. |
| Doctors or veterinarians: specialty, what they see, ages, hours, days off, qualifications and certifications | Doctors (Veterinarians) | Offers the right person; mentions qualifications when asked. |
| Offers and announcements, with optional dates | Settings | Answers callers who ask, only while each one runs. |
| Kinds of request, with what to ask for each | Settings | Asks for what you listed and labels the callback request with the kind, shown on Requests. |
| Answers to common questions, and documents | Settings, Knowledge | Answers from your words, and never invents the rest. |
| Hours, holidays, what happens while you are closed, the emergency hospital | Settings | Books inside your hours; takes requests or books after hours, as you chose. |
| Fields on each patient or pet: a label and a kind (text, yes or no, date), up to 20 | Settings; filled in under Details on each record (`PUT /api/v1/clinics/:clinicId/patients/:patientId/fields`) | Not used on calls. Encrypted like the rest of the record; saving is in the audit log, without the values. Removing a field hides what was filled in. |
| Links in your menu | Settings | Not used on calls. Your own tools in everyone's menu, opened in a new tab. |
| Team members and their roles | Team | Not used on calls. No limit on members. |

The safety rules are not settings: the emergency guardrail, the medical-advice refusal, the identity check and the read-back before any change run for every clinic.
