-- Attendra schema v40: who wrote a request down by hand, for "Added by {name} ({role})".
--
-- Set when someone at the clinic adds a request (POST /clinics/:id/tasks); null for the
-- assistant's and the worker's own. Requests already in the queue get it from their
-- task.created audit row, written under the person who added them. tasks forces its row
-- policy on every role, so the copy runs clinic by clinic, as the API does.
alter table tasks add column if not exists created_by_user_id text;

do $$
declare c text;
begin
  for c in select id from clinics loop
    perform set_config('app.clinic_id', c, true);
    update tasks t set created_by_user_id = substr(a.actor, 6)
      from audit_logs a
      where t.clinic_id = c and a.clinic_id = c and t.call_id is null and t.created_by_user_id is null
        and a.entity = 'task' and a.entity_id = t.id::text and a.action like 'task.created.%' and a.actor like 'user:%';
  end loop;
  perform set_config('app.clinic_id', '', true);
end $$;
