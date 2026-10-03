# 9. A patient is a name, a date of birth and a phone number together

**Status:** accepted, 2026-10-03

Until v0.5 the assistant matched a caller on full name and date of birth, and two records with the same name and birthday went to staff. The first browser test calls showed the gaps: a new patient could not get past the check at all, a parent calling for a child had nowhere to go, and two different people who share a name and a birthday (it happens in any practice of a few thousand) could not be told apart without a person.

We now treat the three together as one person: **first and last name, date of birth, and the phone number on file.**

- **Phone is required** for every patient, on every path that writes one: the front desk, the import and the assistant. `patients_phone_required` enforces it for every row written from now on; rows from before are listed by `pnpm db:rehash-lookups` so the front desk can add theirs.
- **`identity_hash`** is a keyed HMAC of normalized first name, last name, date of birth and the phone's last nine digits. Nine is the national number almost everywhere, however it is written: +34 912 345 678 and 912 345 678, +44 7911 123456 and 07911 123456, +1 (303) 555-0100 and 303-555-0100 all agree on their last nine. It is unique per clinic, so the same person cannot be stored twice, whoever adds them. Twins share a surname, a birthday and the family phone, and differ by first name.
- **A family shares a phone.** Each child is a patient of their own, on a parent's number, with a parent or guardian named for anyone under 18. The patient page lists everyone on the same number.
- **The assistant verifies on all three.** The phone is the one the caller says, or else the number they are calling from. A wrong phone gets the same "I could not find a match" as a wrong date of birth, so the check never confirms that a record exists. On one call a parent can switch from one child to the next, each verified the same way.
- **New patients are added on the call** (`register_patient`), only after the check found nobody and the caller says they are new. They book new-patient visit types with doctors who take new patients, and every one becomes a request for the front desk to check the details. Registering is refused once the call's three identity tries are used up, and an attempt to register someone already on file counts as a try, so it is no way round the limit. Until the front desk confirms a new patient, booking texts go only to the number the caller is ringing from, so nobody can have texts sent to someone else's phone by making a patient up. Someone with the same name and birthday on another phone is a different person and is added; the request says so, the caller never hears about the other record. At most three are added per call.
- **Doctors are offered by age.** Once the patient is known, only providers whose age range includes them are offered.

What we gave up: a caller who no longer has the phone on file has to give the old number or be helped by a person. That is the same trade every practice makes when it asks "can I confirm the number we have for you?".
