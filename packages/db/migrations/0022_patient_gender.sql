-- Attendra schema v22: a patient's gender, as the clinic records it at intake.
--
-- Female, male, other, or undisclosed when they prefer not to say. Encrypted like the
-- other details about a person; the application checks the value before it writes it.
-- Required for every patient added or changed from v0.5.1 on, in the application:
-- patients from before keep an empty value until the front desk adds it, so nothing
-- that only updates their row (a rehash, a confirmation) is refused.
alter table patients add column gender_enc text;
