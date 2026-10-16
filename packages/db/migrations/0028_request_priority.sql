-- Attendra schema v28: urgent requests and a day each one is due.
--
-- Staff set both on an open request. Urgent ones come first in the open queue; the
-- day is the clinic's own date, with no time. Every existing request is not urgent
-- and has no due day.
alter table tasks add column if not exists urgent boolean not null default false;
alter table tasks add column if not exists due_on date;
