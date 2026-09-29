# 7. Patient search decrypts in the API, capped, with a blind index as the way up

**Status:** accepted, 2026-09-29

The front desk finds patients by typing part of a name, a date of birth, or a phone number. Names and dates of birth are encrypted in the application ([decision 3](0003-tenancy-and-phi.md)), so Postgres cannot match "del" against them.

We search in the API. `POST /patients/search` reads one clinic's patients inside `withClinic`, decrypts first name, last name and date of birth, and matches in memory:

- **A date of birth** ("3/4/1985", "March 4 1985", "1985-03-04"), parsed with the same `parseDob` the voice agent uses, matches the date exactly.
- **A full phone number** (10 digits, any punctuation) is looked up by its keyed hash, the one the voice path already stores, without decrypting anyone.
- **Anything else** is a name: every word typed must start a word of the patient's first or last name, ignoring case and accents. "del mar" finds Maria Delgado.

Results are capped at 25, sorted by last name. The query travels in a POST body, never a URL, so it stays out of access logs and browser history, and the audit row records how many patients matched, not what was typed.

A clinic's whole list is read at most once per search, and the scan stops at 20,000 patients. Decrypting a patient's three fields takes a few microseconds, so a practice with a few thousand patients answers in well under 100 ms, and the dashboard waits 300 ms after the last key before it asks. That covers the practices Attendra is built for.

When a deployment outgrows it, the upgrade is a **keyed blind index**: store HMACs of each name's normalized prefixes (two to six characters) in a side table, look candidates up by the typed prefix's HMAC, and decrypt only those. It keeps names out of the database in clear, as decision 3 requires, and it needs no change to the API.

What we gave up: fuzzy matching ("Delgato" does not find Delgado) and searching inside phone numbers by a few digits. Both need either plaintext or an index that leaks more than we want; the front desk can still find the person by name or date of birth.
