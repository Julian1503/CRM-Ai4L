-- Refresh active_contacts so it carries every column of contacts again.
--
-- The view was created with `select *` in 20260807000000, and Postgres expands `*` once,
-- when a view is created. Every column added to contacts since -- source,
-- subscribed_to_programs, archive_reason, removed_at, removed_by -- was missing from it,
-- so the default contact list (which reads the view) could neither show nor filter
-- programme consent. `create or replace` may append columns, and re-expanding `*` puts
-- the new ones after the existing ones, so this is a compatible change.
--
-- Rerun this whenever a column is added to contacts.
create or replace view public.active_contacts
with (security_invoker = on) as
select * from public.contacts where deleted_at is null;
