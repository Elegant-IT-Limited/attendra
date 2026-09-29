# HIPAA

**Attendra is HIPAA-ready, not HIPAA-certified.** The code is built so a covered entity can use it compliantly. Compliance itself depends on how you deploy it, who you contract with, and how you operate it. This page is guidance, not legal advice; involve your compliance officer or counsel.

## Before any real patient data

1. **Business Associate Agreements** with every vendor that touches PHI:
   - **OpenAI.** Their BAA covers endpoints eligible for Zero Data Retention. Enable ZDR on the project. `/v1/live/sessions` is listed as ZDR-eligible with limitations, so confirm GPT-Live coverage with OpenAI in writing before going live. The backend planner already calls the Responses API with `store: false`.
   - **Twilio.** Confirm that the products you use (Programmable Voice, Elastic SIP Trunking, Messaging) are covered under your agreement.
   - **Your hosting provider.** Database, backups, logs and object storage.
2. **Encryption key management.** `ATTENDRA_DATA_KEY` encrypts PHI columns. Keep it in a secret manager or KMS, rotate it on a schedule, and never store it next to the database or its backups.
3. **Access.** Restrict database and server access to people who need it, with individual accounts and MFA.

Self-hosters are responsible for their own BAAs and operations.

## What the code already does

- PHI columns (names, dates of birth, phone numbers, transcripts, task details) are encrypted in the application with AES-256-GCM. Lookups use keyed hashes.
- Row Level Security isolates clinics inside Postgres, as a second wall behind the application's own filters.
- Every identification, booking, cancellation, task, transfer and text message is recorded in an append-only audit log.
- The dashboard audits every screen that shows patient data, in the same transaction as the read. The schedule adds these actions:
  - `schedule.viewed`: a range of the schedule, one row per range rather than per appointment. A screen left open refreshes every 30 seconds; a repeat is covered by the earlier row only when it is exactly the same view within 5 minutes. The entity id carries every parameter (range, provider, filters, page) and `p:` with a short hash of the patient ids shown, so a refresh that shows someone new writes a new row. The same rule applies to `calls.listed` and `patient.recent.viewed`.
  - `appointment.viewed`: one appointment with the patient's date of birth, phone and the note.
  - `appointment.booked.staff`, `appointment.rescheduled.staff`, `appointment.cancelled.staff`: changes made at the front desk, under the staff member's own id.
- The Today screen reads no patient data except today's appointments, which are audited as `schedule.viewed`. Its counts and its list of waiting requests carry none, so they write no audit rows.
- Patients add these actions:
  - `patient.searched`: a search, with the number of matches (`matches:3`) and never the query, and `patient.search.result`, one row for each patient the search showed. The call search writes the same result rows. The query is sent in a request body, not a URL, so it does not reach access logs or browser history.
  - `patient.viewed`: a patient's record, with their appointments, verified calls and requests.
  - `patient.recent.viewed`: the list of patients a person opened recently, once per 5 minutes.
  - `patient.created`, `patient.updated`: changes made at the front desk.
- Requests, calls and the team add these actions:
  - `task.note.added`, `task.assigned`: a note on a request, and a request handed to a teammate. `task.done` now records an outcome code with the request.
  - `calls.listed`: the call list with verified callers' names, once per person per 5 minutes. A viewer's list has no names and writes nothing.
  - `calls.searched`: a search of calls by patient name, with the number of matches and never the name typed.
  - `member.added:<role>`, `member.role.changed:<role>`, `member.removed`, `member.password.reset`: team changes, written to every clinic of the organization in the same transaction as the change.
- Every person has their own password. A temporary one, issued when someone is added or reset, must be changed at first sign-in, before two-step setup, and stops working after 72 hours, so the manager who read it out never holds a working password for someone else. It never reaches a log.
- Links between clinic rows (a call's patient, a note's request) are enforced by composite foreign keys as well as by the application.
- Appointment notes and request notes typed by staff are encrypted like the other PHI columns. Cancel reasons are a fixed list, never free text, so they cannot carry PHI.
- The logger redacts PHI by field name and by pattern, and a test proves it.
- SMS messages are fixed templates with the time and the clinic, never the reason for the visit.
- The voice model receives clinic facts and short verified results only, never full records.
- Recording is off by default. Turning it on requires a recording notice, because several US states require all-party consent.
- Every call starts with an AI-assistant disclosure: a clinic greeting that does not say so is rejected when the configuration loads.

## Not yet in v0.1

A retention purge job (transcripts default 90 days), staff access through a dashboard with 2FA, and KMS envelope encryption for the hosted service are on the [roadmap](roadmap.md). Until the retention job ships, purge on a schedule of your own. v0.1 stores no call audio; if you enable recording, the recordings live with your telephony provider under its retention settings.
