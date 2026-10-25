-- Attendra schema v37: calls taken while the assistant was paused.
--
-- The hosting layer can pause a clinic's assistant (its plan's free minutes used up, a
-- payment missing). Such a call hears a short line and goes to the front desk, or ends;
-- the voice service records it as an 'answering_paused' action, and the minutes billed
-- leave it out. This index keeps that check cheap.
create index if not exists call_actions_answering_paused on call_actions (call_id) where tool = 'answering_paused';
