# Provisioning

A hosting layer (sign-up, billing, phone numbers) opens and runs accounts through `/api/v1/provisioning`, with a bearer token both services share. Self-hosters do not need it: `pnpm add-member`, `pnpm db:add-number` and `pnpm db:test-call-limit` do the same by hand.

```bash
# the API's .env
ATTENDRA_PROVISIONING_TOKEN=...   # 32 characters or more: openssl rand -base64 32
```

Without the token the routes answer 404. With it, every request needs `Authorization: Bearer <token>`. Call them from the server only, never from a browser. None of them reads patient data.

| Route | What it does |
|---|---|
| `POST /provisioning/accounts` | A new organization, its clinic and its owner. Body: `organization.name`; `clinic.name`, `clinic.timezone` (IANA), `clinic.industry` (`vet` or `clinic`), `clinic.phone` (the clinic's own main number, E.164, which sets the country; it is not pointed at Attendra); `owner.name`, `owner.email`, `owner.password` (12 characters or more); optional `testCallMinutes` and `plan`. Answers `201 { organizationId, clinicId, userId }`, or `409 email_taken`. The clinic starts from its pack's first settings: weekday hours, the pack's visit types, one provider to book with, no FAQ. |
| `POST /provisioning/email-confirmations` | `{ email }`. An account opened here cannot sign in until its address is confirmed; the hosting layer sends the link and calls this when it is opened. |
| `PUT /provisioning/clinics/:clinicId/test-call-limit` | `{ seconds }`, or `null` for no limit. |
| `PUT /provisioning/clinics/:clinicId/numbers/:number` | Points a number (E.164, URL-encoded) at the clinic: calls to it reach the assistant and texts are sent from it. |
| `DELETE /provisioning/numbers/:number` | Stops a number reaching any clinic. |
| `GET /provisioning/clinics/:clinicId/usage?from=&to=` | Phone calls in the period (ISO times): `{ calls, seconds }`, each call start to end, rounded up to the second. Browser test calls are not counted. |
| `GET /provisioning/clinics/:clinicId/report?weeks=1` | The weekly report: the clinic's name, time zone, industry and average visit value, its owners with a confirmed address, and the Quality page's numbers for the last whole weeks, newest first. |

## Two-step sign-in

The dashboard requires two-step sign-in by default. A hosted service whose accounts hold no patient health information, such as veterinary clinics, can make it optional:

```bash
ATTENDRA_TWO_FACTOR=optional
```

People can still turn it on for themselves. Keep it required wherever the dashboard holds patient records.
