-- Idempotency keys for every POST to the API (apps/api/src/http/idempotency.ts): a client that
-- sends `Idempotency-Key` and has to send the same request again (a timeout, a retry, a double
-- click) gets the first answer back instead of a second request taken, booked or texted.
--
-- A key belongs to whoever sent it (a person, or the hosting layer) and to one route, so two
-- people never share one. The answer is kept encrypted (it can name a patient), with a hash of
-- the request it answered: the same key with another body is refused, never answered with the
-- first one. Kept 24 hours. A row with no status is a request still being answered.
create table if not exists idempotency_keys (
  scope        text not null,
  key          text not null,
  request_hash text not null,
  status       integer,
  response     text,
  created_at   timestamptz not null default now(),
  primary key (scope, key)
);
create index if not exists idempotency_keys_created on idempotency_keys (created_at);

-- Rollback: drop table idempotency_keys;
