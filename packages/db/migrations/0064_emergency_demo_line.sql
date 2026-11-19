-- Attendra schema v64: an animal's emergency on a demo clinic, recorded as the demo line it was (2026-11-18, V4).
--
-- calls.emergency_result  'demo_line'  a demo clinic (core demo-clinic.ts): the caller said it was still an emergency
--                                      and heard the demo line only; no hospital was named, nobody was put through,
--                                      nothing was texted. Before v64 these calls were recorded as 'hospital_said', and
--                                      the call page said "Emergency · sent to hospital".
--
-- A demo clinic's calls since the demo line (2026-11-16) already recorded as 'hospital_said' become 'demo_line': since
-- then a demo clinic names no hospital (core demoEmergency), so there 'hospital_said' was always the demo line.
-- Run before the engine that writes 'demo_line' starts (the check would refuse its call records otherwise), and ship it
-- with the API and dashboard that know the value (core EMERGENCY_RESULTS).
alter table calls drop constraint if exists calls_emergency_result_known;
alter table calls add constraint calls_emergency_result_known
  check (emergency_result is null or emergency_result in ('transferred', 'hospital_said', 'hospital_texted', 'urgent_request', 'cleared', 'demo_line'));
update calls set emergency_result = 'demo_line'
  where emergency_result = 'hospital_said' and started_at >= '2026-11-16'
    and clinic_id in (select id from clinics where config->'demoClinic'->>'enabled' = 'true');
