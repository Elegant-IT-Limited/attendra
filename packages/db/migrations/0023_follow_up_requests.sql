-- Attendra schema v23: follow-up requests.
--
-- A call that ended with the caller's request unfinished (nothing booked, an error, an
-- upset caller) becomes a request of its own once the call is summarised, so a person
-- gets back to them instead of the call waiting on the Calls page to be noticed.
alter table tasks drop constraint tasks_type_check;
alter table tasks add constraint tasks_type_check check (type in ('callback', 'refill', 'voicemail', 'review', 'follow_up'));
