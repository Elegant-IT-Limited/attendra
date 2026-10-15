-- Attendra schema v24: the kind of animal, for a clinic on the veterinary pack.
--
-- A pet is stored like any patient: its own name as the first name, its owner's last
-- name, its owner as the guardian, the owner's phone. What kind of animal it is (dog,
-- cat, rabbit) is encrypted like the other details. Empty for people, and for pets
-- added before v0.7.
alter table patients add column species_enc text;
