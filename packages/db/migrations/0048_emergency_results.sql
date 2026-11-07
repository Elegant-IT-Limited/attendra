-- Attendra schema v48: how an animal's emergency on a call ended, and where a request came from (batch 1b).
--
-- calls.emergency_result  'transferred'     put through to the team's emergency line
--                         'hospital_said'   sent to the emergency hospital, said on the call
--                         'hospital_texted' and its address texted (once, to a confirmed number)
--                         'urgent_request'  nobody could be put through: an urgent request for the team
--                         'cleared'         the caller said it was not an emergency now (booked with a note)
--                         null              no emergency on the call, or a call closed before this
-- tasks.origin            'emergency' for the urgent request an emergency leaves; null for every other request
-- Additive: older code ignores both columns. Nothing on file is filled in.
alter table calls add column if not exists emergency_result text;
alter table calls add constraint calls_emergency_result_known
  check (emergency_result is null or emergency_result in ('transferred', 'hospital_said', 'hospital_texted', 'urgent_request', 'cleared'));
alter table tasks add column if not exists origin text;
alter table tasks add constraint tasks_origin_known check (origin is null or origin in ('emergency'));
