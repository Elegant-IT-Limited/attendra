-- call_actions.idempotency_key was never written: each tool keeps its own key on the
-- row it creates (an appointment, a request, a text), which is where a retry is
-- caught. The column was always empty, so it goes.
alter table call_actions drop column idempotency_key;
