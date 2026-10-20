-- Attendra schema v35: a clinic its organization closed (a location removed).
--
-- A closed clinic leaves every member's dashboard, its numbers stop reaching the assistant
-- and its API keys are revoked. It can be opened again for 30 days; after that the hosting
-- layer deletes it with everything recorded for it.
alter table clinics add column if not exists closed_at timestamptz;
