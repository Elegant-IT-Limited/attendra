# HIPAA

**Attendra is HIPAA-ready, not HIPAA-certified.** The code is built so a covered entity can use it compliantly. Compliance itself depends on how you deploy it, who you contract with, and how you operate it. This page is guidance, not legal advice; involve your compliance officer or counsel.

## Before any real patient data

1. **Business Associate Agreements** with every vendor that touches PHI:
   - **OpenAI.** Their BAA covers endpoints eligible for Zero Data Retention. Enable ZDR on the project. `/v1/live/sessions` is listed as ZDR-eligible with limitations, so confirm GPT-Live coverage with OpenAI in writing before going live. The backend planner already calls the Responses API with `store: false`.
   - **Twilio.** Confirm that the products you use (Programmable Voice, Elastic SIP Trunking, Messaging) are covered under your agreement.
   - **Your hosting provider.** Database, backups, logs and object storage.
   - **Every webhook receiver and every MCP client.** A webhook's ids and times are PHI once they can be tied to a patient: a patient id with an appointment's times says who is seen when. Endpoints leave patient ids out by default, and even then a receiver learns that the clinic booked someone at a given time. An MCP client (and the model behind it) reads the schedule and the request queue, with patient names. Whoever runs the receiver, the automation service (n8n cloud, Zapier, Make) or the AI agent needs a BAA before the endpoint or the key is used with real patients.
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
- Every call starts with an AI-assistant disclosure: a clinic greeting that does not say so is rejected when the configuration loads. A name for the assistant never counts as the disclosure.
- Call summaries are encrypted like transcripts. The summary model is called with `store: false`, a timeout and a cap on input and output, and is told to summarise only what was said, never to add advice or a diagnosis. The worker's read of a transcript and its write of a summary are both audited (`call.transcript.read`, `call.summary.written`), and so is a staff member marking a flagged call reviewed (`call.summary.reviewed`).
- Live calls add these actions: `call.live.watched`, for every live stream opened, once per person and call per five minutes (the server decides; a reconnect's Last-Event-ID does not skip it), since the captions are what the caller says; `calls.live.listed`, when the live list shows verified callers' short names ("Maria D."), once per 5 minutes; `call.coached`, with the note's length and never its words; `call.taken_over` and `call.ended_by_staff`. A viewer's live list has no names and writes nothing. Live events are held in the voice service's memory only, for as long as the call and a minute after.
- The clinic's documents (Settings > Knowledge) are clinic information and must never hold patient data: they are embedded and searched in clear ([decision 8](decisions/0008-clinic-knowledge.md)). Uploads and deletes are audited (`knowledge.document.uploaded`, `knowledge.document.deleted`). A medical question is refused in code before any document is searched.
- Webhook payloads carry ids, times, types, outcomes and counts, never names, numbers, dates of birth or anything said on a call ([docs/webhooks.md](webhooks.md)). That is still PHI when a patient id travels with appointment times, so each endpoint leaves patient ids out unless a manager turns that off for it; either way, the receiver needs a BAA (above). Endpoint secrets are encrypted at rest, and endpoint changes are audited (`webhook.endpoint.created`, `.updated`, `.deleted`, `.secret_rotated`, and `.disabled` when Attendra turns one off).
- API keys for MCP are stored only as SHA-256 hashes, belong to one clinic, expire, and are audited at every use (`mcp.<tool>`, with the key's id), including uses a scope refused; making and revoking one is audited (`api_key.created`, `api_key.revoked`). Patient names reach an agent only with the `schedule:read` or `requests:read` scope, and no tool books or cancels.
- Background jobs carry ids only. A failed job keeps an error code, never text from the call.
- Transcripts and summaries are deleted after each clinic's retention period (`retentionDays`, 2555 days by default). The purge is audited with counts only (`retention.purged`).

## Not yet

KMS envelope encryption for the hosted service is on the [roadmap](roadmap.md). Attendra stores no call audio; if you enable recording, the recordings live with your telephony provider under its retention settings, which the retention purge does not reach.
