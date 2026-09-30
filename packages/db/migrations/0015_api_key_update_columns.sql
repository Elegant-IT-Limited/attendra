-- The application may change only when a key was revoked and when it was last used.
-- Its hash, scopes, expiry, clinic and maker are fixed once it is made: a bug or an
-- injected query cannot widen a key's scopes or move it to another clinic.
revoke update on api_keys from attendra_app;
grant update (revoked_at, last_used_at) on api_keys to attendra_app;
