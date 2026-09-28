# 3. Two walls for tenancy, and PHI encrypted in the application

**Status:** accepted, 2026-09-28

Every query filters on `clinic_id`. Underneath, every clinic table has a Row Level Security policy, and requests run as `attendra_app`, a role that cannot bypass it, inside a transaction that sets `app.clinic_id` locally. A query that forgets its filter returns nothing rather than another clinic's patients. The one table read before the tenant is known, `phone_numbers`, holds only the clinics' public numbers.

PHI columns are encrypted before they reach Postgres (AES-256-GCM, keys derived with HKDF from one master key), rather than relying on disk or database encryption alone. A leaked backup, a stray `select *` in a support session, or a log of query parameters then shows ciphertext. Equality lookups (last name and date of birth, phone) use keyed HMACs from a separate derived key.

The trade-off is that we cannot search PHI with SQL, sort by name, or index it for fuzzy matching. For a receptionist that looks up one caller at a time, that is acceptable.
