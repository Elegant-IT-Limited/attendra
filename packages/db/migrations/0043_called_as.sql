-- Attendra schema v43: "Call as" on a browser test call.
--
-- Staff can start a browser test call as one of the clinic's numbers (picked from the
-- records, or typed): the voice service then treats it as that call's caller ID. The call
-- keeps only the number's last four digits, for "Browser test, called as ...ending 0123".
-- from_hash and from_enc stay empty on a test call, so a client's "calls from this number"
-- never fills with tests. Only a browser test call can have it: never a phone call.
alter table calls add column if not exists called_as_last4 text;
alter table calls add constraint calls_called_as_last4_digits check (called_as_last4 ~ '^[0-9]{4}$');
alter table calls add constraint calls_called_as_web_only check (called_as_last4 is null or channel = 'web');
