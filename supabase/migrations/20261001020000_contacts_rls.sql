-- Re-enable row level security on contacts.
--
-- 20260603000000 enabled it, but the live database was found with it disabled -- turned
-- off by hand at some point. With RLS off, the policies are ignored and the anon role's
-- table grants apply as written: anyone holding the public anon key could read, change
-- and delete every contact through the REST API.
--
-- The application reads contacts as `authenticated` (policies below cover it) or with
-- the service role (webhooks, preferences, booking, cron), which bypasses RLS. There is
-- no anon read or write path.
alter table public.contacts enable row level security;

-- Belt and braces: the anon role has no business with contacts at all.
revoke all on public.contacts from anon;
revoke all on public.active_contacts from anon;
