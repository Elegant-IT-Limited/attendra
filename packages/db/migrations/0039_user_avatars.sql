-- Attendra schema v39: a person's picture, for "Your profile".
--
-- A 256 px WebP the browser makes before it uploads, so about 30 KB, and never more than
-- 200 KB. Kept here, not as a link in auth_users.image, and served by the API only to
-- someone who shares an organization with the person. An auth table like the others: read
-- by the API's owner connection only, with no grant to attendra_app. It goes with the login.
create table if not exists user_avatars (
  user_id      text primary key references auth_users(id) on delete cascade,
  bytes        bytea not null check (octet_length(bytes) between 1 and 200 * 1024),
  content_type text not null check (content_type in ('image/webp', 'image/png', 'image/jpeg')),
  updated_at   timestamptz not null default now()
);
