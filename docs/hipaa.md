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
- The logger redacts PHI by field name and by pattern, and a test proves it.
- SMS messages are fixed templates with the time and the clinic, never the reason for the visit.
- The voice model receives clinic facts and short verified results only, never full records.
- Recording is off by default. Turning it on requires a recording notice, because several US states require all-party consent.
- Every call starts with an AI-assistant disclosure: a clinic greeting that does not say so is rejected when the configuration loads.

## Not yet in v0.1

A retention purge job (transcripts default 90 days), staff access through a dashboard with 2FA, and KMS envelope encryption for the hosted service are on the [roadmap](roadmap.md). Until the retention job ships, purge on a schedule of your own. v0.1 stores no call audio; if you enable recording, the recordings live with your telephony provider under its retention settings.
