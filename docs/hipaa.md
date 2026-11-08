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
  - `schedule.viewed`: a range of the schedule, one row per range rather than per appointment. A screen left open refreshes when something in it changes (and every 2 minutes as a safety net); a repeat is covered by the earlier row only when it is exactly the same view within 5 minutes. The entity id carries every parameter (range, provider, filters, page) and `p:` with a short hash of the patient ids shown, so a refresh that shows someone new writes a new row. The same rule applies to `calls.listed` and `patient.recent.viewed`.
  - `appointment.viewed`: one appointment with the patient's date of birth, phone and the note.
  - `appointment.booked.staff`, `appointment.rescheduled.staff`, `appointment.cancelled.staff`: changes made at the front desk, under the staff member's own id.
  - `appointment.booked.staff.override`, `appointment.rescheduled.staff.override`: the same, outside the hours, with the reason kept on the visit.
  - `appointment.status.arrived`, `.completed`, `.no_show`, `.booked`: the desk marked what happened to a visit (or put it back to booked), under the staff member's own id; the visit keeps when and by whom.
  - `clinic.doctor.handover`: a manager moved a provider's visits still to come to other providers (the same times) before removing them, with counts only (moved, not moved, texts queued, left). Each move is its own `appointment.rescheduled.staff`. Owners are texted (`sms.sent.vet_changed`) only when the manager ticked it, only those who agreed to texts.
  - `appointment.confirmed.text`: a reply of C to a reminder confirmed the visit. `patient.texts_ok.call`: the caller said yes to reminder texts on a call.
- The call record is audited under the actor `system` when the call opens (`call.opened`) and when it closes (`call.closed`, with how many transcript lines and tool steps it wrote, as counts). There is no row per line or step, so the log stays readable for the rows that matter: people reading patient data. A browser test call is opened as `call.test.started` under the staff member instead.
- The Today screen reads no patient data except today's appointments, which are audited as `schedule.viewed`. Its counts and its list of waiting requests carry none, so they write no audit rows.
- Patients add these actions:
  - `patient.searched`: a search, one row per search, with the number of matches (`matches:3`) and never the query, and `patient.search.result`, one row for each patient the search showed. Search runs as the person types, so a patient already shown to the same person in the last 5 minutes is covered by the row written then. The call search writes the same result rows. The query is sent in a request body, not a URL, so it does not reach access logs or browser history. A search finds records by keyed hashes (the first letters and sound of each name, the date of birth, runs of the phone's digits), never by plain text.
  - `patient.viewed`: a patient's record, with their appointments, verified calls and requests.
  - `patient.recent.viewed`: the list of patients a person opened recently, once per 5 minutes.
  - `patient.created`, `patient.updated`: changes made at the front desk. A patient added by the seed or the voice service is audited as `patient.created` too, under that service's name.
  - `patient.busy.shown`: a front-desk booking or move refused because the patient is already booked then, which shows the patient's name.
  - `patient.deleted`, `patient.merged`, `patient.merged_away`, `patient.household.merged`, `patient.household.merged_away`: a record deleted or merged by an owner or practice manager, with counts only ("Deleting and merging patient records", below).
- Requests, calls and the team add these actions:
  - `task.note.added`, `task.assigned`: a note on a request, and a request handed to a teammate. `task.done` now records an outcome code with the request.
  - `calls.listed`: the call list with verified callers' names, once per person per 5 minutes. A viewer's list has no names and writes nothing.
  - `call.transcript.viewed`: a call's transcript opened on the call page, once per person and call per 5 minutes (the page refreshes while a summary is written).
  - `task.viewed`: each request shown on the Requests page, with its details and the patient's name, once per person and request per 5 minutes (the page refreshes when a request changes, and every 2 minutes as a safety net).
  - `calls.searched`: a search of calls by patient name or number, one row per search, with the number of matches and never what was typed.
  - `tasks.searched`: a search of the requests, one row per search, with the number of matches and never what was typed; each request shown is its own `task.viewed`.
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
- Live calls add these actions: `call.live.watched`, for every live stream opened, once per person and call per five minutes (the server decides; a reconnect's Last-Event-ID does not skip it), since the captions are what the caller says; `calls.live.listed`, when the live list shows verified callers' short names ("Maria D."), once per 5 minutes; `call.coached`, with the note's length and never its words; `call.taken_over`, which records whether it went to the front desk or the person's own number and that number's last four digits only, and `call.ended_by_staff`. A person's own number for take-overs must be in the clinic's country, and setting or clearing it is audited (`member.transfer_number.set`, `.cleared`). A viewer's live list has no names and writes nothing. Live events are held in the voice service's memory only, for as long as the call and a minute after.
- The clinic's documents (Settings > Knowledge) are clinic information and must never hold patient data: they are embedded and searched in clear ([decision 8](decisions/0008-clinic-knowledge.md)). Uploads and deletes are audited (`knowledge.document.uploaded`, `knowledge.document.deleted`). A medical question is refused in code before any document is searched.
- Webhook payloads carry ids, times, types, outcomes and counts, never names, numbers, dates of birth or anything said on a call ([docs/webhooks.md](webhooks.md)). That is still PHI when a patient id travels with appointment times, so each endpoint leaves patient ids out unless a manager turns that off for it; either way, the receiver needs a BAA (above). Endpoint secrets are encrypted at rest, and endpoint changes are audited (`webhook.endpoint.created`, `.updated`, `.deleted`, `.secret_rotated`, and `.disabled` when Attendra turns one off).
- API keys for MCP are stored only as SHA-256 hashes, belong to one clinic, expire, and are audited at every use (`mcp.<tool>`, with the key's id), including uses a scope refused; making and revoking one is audited (`api_key.created`, `api_key.revoked`). Patient names reach an agent only with the `schedule:read` or `requests:read` scope, and no tool books or cancels.
- Background jobs carry ids only. A failed job keeps an error code, never text from the call.
- Transcripts, summaries, call actions (each call's tool steps) and webhook events, with their delivery attempts, are deleted after each clinic's retention period (`retentionDays`, 2555 days by default), in batches of 500 calls or events. The purge is audited with counts only (`retention.purged`), one row per batch, written in the same transaction as that batch's deletes.
- The purge keeps, on purpose: the call rows themselves (times, outcome, the emergency flag and the linked patient, for the audit trail and the Quality numbers); requests, with their encrypted details and notes, which are the clinic's own work records and go when the clinic deletes them (deleting a patient's record removes its requests' details and notes: below); and text records, which hold a hash of the number, the template and the delivery status, never the number or the message. Delete them by hand, or ask for them in the purge, if your records policy says otherwise.

## Deleting and merging patient records

Owners and practice managers (permission `patients:merge`) delete and merge records from a patient's page. Each opens a confirm step that says, in counts from the server, what will move or go; nothing changes before the confirm. Everything runs inside the clinic's row-level security, so a record of another clinic is never found. Code: `packages/db/src/repositories/patient-removal.ts`.

- **Delete a pet (or a patient), or everyone on its number.** The record's name, number, date of birth, owner, kind, gender and the clinic's own details are removed (the encrypted columns are replaced by a fixed placeholder, "Deleted record", or emptied), every keyed hash and search key goes, and so does the yes to texts: no search, call or import finds the record again. Visits still to come are cancelled (each `appointment.cancelled.staff`, with an `appointment.cancelled` webhook). Every visit's note is removed. The record's requests keep their number, type and outcome, with their details and notes removed (request notes stay append-only for the app; one owner-run function, scoped to the clinic, removes only those of a deleted record). Calls and text records are unlinked from it.
- **What a delete keeps, and why.** The record's row stays, empty, with `deleted_at` and who deleted it, because its visits stay: the visits that took place, were missed or were cancelled count in Quality (no-shows) and in each vet's history, and an appointment must point at a record. A past visit shows "Deleted record" where the name was. The calls themselves (transcripts, summaries, the number they came from) are the clinic's call records and follow the retention period above, like every call; delete them sooner by hand if your records policy says so.
- **Merge the same pet twice.** Its appointments, calls, requests and texts move to the record kept; the record kept fills its gaps from the other (kind, gender, the clinic's own fields, a yes to texts given on the same number); the other record is deleted outright, with its search keys.
- **Merge one owner on two numbers** (a second number, or a typo). Every pet of the other number moves to the number and owner kept (one number, one owner), with its details re-encrypted and its search keys re-hashed, and takes that number's yes or no to texts; a pet that is on both numbers becomes one record, as above. The other number's requests move to the household kept.
- **Audit.** `patient.deleted` (per record; `{ household: n }` for a household), `patient.merged` and `patient.merged_away`, `patient.household.merged` and `patient.household.merged_away`: who, when, which record ids and counts, never a name or a value. Values are decrypted and encrypted only through the PHI cipher, inside the API, and never logged.

## Every audit action

Each row in the audit log has an action code. The audit page shows it in plain words; this is the full list. Actors are shown the same way: a staff member by name, `voice-agent` as the Assistant, `worker` as Attendra in the background, `system` as Attendra, and `api_key:<id>` as an API key with the start of its id.

| Action | Shown on the audit page as |
|---|---|
| `api_key.created` | Made an API key |
| `api_key.revoked` | Revoked an API key |
| `appointment.booked` | Booked an appointment |
| `appointment.booked.staff` | Booked an appointment at the desk |
| `appointment.booked.staff.override` | Booked an appointment outside the hours, with a reason |
| `appointment.confirmed.text` | A visit was confirmed by a reply to its reminder |
| `patient.texts_ok.call` | Said yes to reminder texts on a call |
| `appointment.cancelled` | Cancelled an appointment |
| `appointment.cancelled.staff` | Cancelled an appointment at the desk |
| `appointment.rescheduled.staff` | Moved an appointment |
| `appointment.status.arrived` | Marked a visit arrived |
| `appointment.status.booked` | Put a marked visit back to booked |
| `appointment.status.completed` | Marked a visit completed |
| `appointment.status.no_show` | Marked a visit a no-show |
| `appointment.viewed` | Opened an appointment |
| `call.closed` | Finished a call |
| `call.coached` | Sent the assistant a note |
| `call.ended_by_staff` | Ended a live call |
| `call.live.watched` | Watched a live call |
| `call.opened` | Answered a call |
| `call.summary.reviewed` | Marked a call summary reviewed |
| `call.summary.written` | Wrote a call summary |
| `call.taken_over` | Took over a live call |
| `call.test.started` | Started a browser test call |
| `call.test.called_as` | Started a browser test call as a number (its last four digits are on the call) |
| `call.transcript.read` | Read a call transcript to summarise it |
| `call.transcript.viewed` | Read a call transcript |
| `call.transferred.<target>` | Transferred the call (<target>) |
| `calls.listed` | Looked at the call list with names |
| `calls.live.listed` | Looked at live calls with names |
| `call.lookups.rehashed` | Updated how calls are found by their number |
| `calls.searched` | Searched calls by patient |
| `clinic.doctor.handover` | Moved a provider's visits to other providers, before removing them |
| `clinic.settings.updated` | Changed clinic settings |
| `knowledge.document.deleted` | Deleted a document |
| `knowledge.document.uploaded` | Uploaded a document for the assistant |
| `mcp.<tool>, .refused, .failed` | An agent used a tool through an API key; refused when the key lacks the scope, or failed |
| `member.added:<role>` | Added a person to the team, as <role> |
| `member.password.reset` | Issued a new temporary password |
| `member.removed` | Removed a person from the team |
| `member.role.changed:<role>` | Changed someone's role to <role> |
| `member.transfer_number.cleared` | Cleared their number for take-overs |
| `member.transfer_number.set` | Set their number for take-overs |
| `patient.busy.shown` | Saw that a patient was already booked then |
| `patient.created` | Added a patient |
| `patient.deleted` | Deleted a patient's record |
| `patient.household.merged` | Merged another number's records into this household |
| `patient.household.merged_away` | A household merged into another number |
| `patient.identified` | Verified a caller |
| `patient.lookups.rehashed` | Updated how patient names are matched |
| `patient.merged` | Merged another record into this one |
| `patient.merged_away` | A record merged into another one |
| `patient.phone.called_as` | Used a patient's number for a browser test call ("Call as") |
| `patient.recent.viewed` | Looked at recent patients |
| `patient.search.result` | Saw a patient in search results |
| `patient.searched` | Searched for a patient |
| `patient.updated` | Changed a patient's details |
| `patient.viewed` | Opened a patient's record |
| `retention.purged` | Deleted old call records |
| `schedule.viewed` | Looked at the schedule |
| `sms.sent.<template>` | Sent a text confirmation |
| `sms.status.<status>` | A text confirmation was delivered, not delivered, failed and so on |
| `task.assigned` | Handed a request to a teammate |
| `task.claimed` | Claimed a request |
| `task.created.callback` | Took a callback request |
| `task.created.refill` | Took a refill request |
| `task.created.voicemail` | Took a voicemail |
| `task.done` | Closed a request |
| `task.note.added` | Added a note to a request |
| `task.released` | Released a request |
| `task.released.override` | Released someone else's request |
| `task.viewed` | Viewed a request |
| `tasks.searched` | Searched the requests |
| `webhook.endpoint.created` | Added a webhook endpoint |
| `webhook.endpoint.deleted` | Removed a webhook endpoint |
| `webhook.endpoint.disabled` | Turned off a webhook endpoint that kept failing |
| `webhook.endpoint.secret_rotated` | Rotated a webhook signing secret |
| `webhook.endpoint.updated` | Changed a webhook endpoint |
| `webhook.test` | Sent a test event to a webhook endpoint |

## Not yet

KMS envelope encryption for the hosted service is on the [roadmap](roadmap.md). Attendra stores no call audio; if you enable recording, the recordings live with your telephony provider under its retention settings, which the retention purge does not reach.
