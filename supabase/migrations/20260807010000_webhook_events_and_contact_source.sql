-- Phase 3 — webhook idempotency ledger and contact provenance.

-- ---------------------------------------------------------------------------
-- 1. Idempotency ledger
-- ---------------------------------------------------------------------------
-- Webhook providers retry aggressively and deliver at-least-once. Without a record of
-- what has already been processed, a retried "unsubscribed" can land after a newer
-- "subscribed" and silently undo it.
create table if not exists public.webhook_events (
    id uuid primary key default gen_random_uuid(),
    provider text not null,
    event_id text not null,
    event_type text,
    received_at timestamptz not null default timezone('utc'::text, now())
);

-- The uniqueness constraint is the whole mechanism: an insert that conflicts means
-- "already handled".
create unique index if not exists webhook_events_provider_event_idx
    on public.webhook_events (provider, event_id);

alter table public.webhook_events enable row level security;

-- Writes come from the service-role client, which bypasses RLS. Authenticated users
-- get read access so delivery problems are diagnosable from the app.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'webhook_events'
      and policyname = 'Allow read access to authenticated users'
  ) then
    create policy "Allow read access to authenticated users"
      on public.webhook_events for select to authenticated using (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Contact provenance
-- ---------------------------------------------------------------------------
-- Distinguishes a contact captured from the website newsletter form from one imported
-- from a spreadsheet or entered by hand. Needed so the client can tell which records
-- carry a genuine opt-in — see the Spam Act note in PLAN.md.
alter table public.contacts
    add column if not exists source text;

comment on column public.contacts.source is
    'Where the contact came from: newsletter | import | manual. Null for pre-existing rows.';

create index if not exists contacts_source_idx
    on public.contacts (source) where deleted_at is null;
