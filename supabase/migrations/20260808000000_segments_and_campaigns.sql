-- Phase 4 — segments, campaigns, and the per-recipient send ledger.
--
-- Shaped by a hard constraint of the EmailOctopus API: campaigns are READ-ONLY. There
-- is no way to create or send a campaign programmatically. The only send trigger is
-- POST /automations/{id}/queue, which starts an automation for ONE contact.
--
-- Three consequences visible in this schema:
--   1. A "campaign" here is a local record of intent, not a provider-side object. It
--      points at a provider automation authored in the provider's UI.
--   2. Sending is a fan-out of one call per recipient, so campaign_sends is a ledger
--      rather than a summary — it has to survive partial failure and resumption.
--   3. The provider can be told to allow repeat triggers, which makes deduplication
--      entirely our responsibility. The unique (campaign_id, contact_id) index below
--      is that mechanism.

-- ---------------------------------------------------------------------------
-- 1. Segments
-- ---------------------------------------------------------------------------
-- Stores the filter *definition*, not a frozen member list, so a segment stays current
-- as contacts change. The definition uses the same vocabulary as the contact list
-- filters (src/lib/contacts/query.ts).
create table if not exists public.segments (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text,
    definition jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc'::text, now()),
    updated_at timestamptz not null default timezone('utc'::text, now())
);

create unique index if not exists segments_name_ci_idx
    on public.segments (lower(btrim(name)));

alter table public.segments enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Campaigns
-- ---------------------------------------------------------------------------
do $$
begin
  create type public.campaign_status as enum (
    'draft', 'in_review', 'approved', 'sending', 'sent', 'failed'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.campaigns (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    segment_id uuid references public.segments(id) on delete restrict,
    status public.campaign_status not null default 'draft',

    -- Which provider will actually deliver this, so a future swap (Mailchimp, Brevo,
    -- Resend) is data rather than a migration.
    provider text not null default 'emailoctopus',

    -- EmailOctopus: the automation to queue contacts into. It must be configured with
    -- the "Started via API" trigger type, and its template is authored in their UI --
    -- we cannot supply an HTML body through the API.
    provider_automation_id text,

    -- Personalisation tokens written to contact custom fields before queueing. This is
    -- the ONLY route content can take into the email body.
    merge_fields jsonb not null default '{}'::jsonb,

    -- Informational only for EmailOctopus (the template owns the real subject); kept so
    -- a provider that does accept a subject does not need a schema change.
    subject text,
    notes text,

    approved_at timestamptz,
    approved_by uuid,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default timezone('utc'::text, now()),
    updated_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists campaigns_status_idx on public.campaigns (status);
create index if not exists campaigns_segment_idx on public.campaigns (segment_id);

alter table public.campaigns enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Per-recipient send ledger
-- ---------------------------------------------------------------------------
create table if not exists public.campaign_sends (
    id uuid primary key default gen_random_uuid(),
    campaign_id uuid not null references public.campaigns(id) on delete cascade,
    contact_id uuid not null references public.contacts(id) on delete cascade,
    status text not null default 'pending',
    provider_reference text,
    error text,
    attempted_at timestamptz,
    created_at timestamptz not null default timezone('utc'::text, now()),
    constraint campaign_sends_status_check
        check (status in ('pending', 'sent', 'failed', 'skipped'))
);

-- The deduplication guarantee. EmailOctopus refuses a repeat trigger by default, but
-- with "Allow contacts to repeat" enabled it will happily send twice -- at which point
-- this index is the only thing preventing a double send on a retry.
create unique index if not exists campaign_sends_unique_recipient_idx
    on public.campaign_sends (campaign_id, contact_id);

create index if not exists campaign_sends_pending_idx
    on public.campaign_sends (campaign_id) where status = 'pending';

alter table public.campaign_sends enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Status machine, enforced in the database
-- ---------------------------------------------------------------------------
-- A CHECK constraint cannot see the previous value, so this is a trigger. Enforced here
-- rather than only in the UI because "send" is irreversible: once mail is queued at the
-- provider there is no recall, so an unapproved campaign must not be able to reach
-- 'sending' through any code path, including a direct SQL edit.
create or replace function public.enforce_campaign_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_allowed text[];
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A campaign must be created as draft, got %', new.status;
    end if;
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'draft'     then array['in_review']
    when 'in_review' then array['draft', 'approved']
    when 'approved'  then array['draft', 'sending']
    when 'sending'   then array['sent', 'failed']
    when 'failed'    then array['draft', 'approved']
    when 'sent'      then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status::text = any (v_allowed)) then
    raise exception 'Invalid campaign status transition: % -> %', old.status, new.status;
  end if;

  -- Approval must be deliberate and attributable.
  if new.status = 'approved' and new.approved_by is null then
    raise exception 'A campaign cannot be approved without approved_by';
  end if;

  -- Without an automation id there is nothing to queue contacts into, so approving
  -- would produce a campaign that can never send.
  if new.status = 'approved' and coalesce(btrim(new.provider_automation_id), '') = '' then
    raise exception 'A campaign cannot be approved without provider_automation_id';
  end if;

  return new;
end;
$$;

drop trigger if exists campaigns_status_transition on public.campaigns;
create trigger campaigns_status_transition
    before insert or update on public.campaigns
    for each row execute function public.enforce_campaign_status_transition();

-- ---------------------------------------------------------------------------
-- 5. Policies
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['segments', 'campaigns', 'campaign_sends'] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = 'Allow read access to authenticated users'
    ) then
      execute format(
        'create policy "Allow read access to authenticated users" on public.%I for select to authenticated using (true)', t);
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = 'Allow insert access to authenticated users'
    ) then
      execute format(
        'create policy "Allow insert access to authenticated users" on public.%I for insert to authenticated with check (true)', t);
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = 'Allow update access to authenticated users'
    ) then
      execute format(
        'create policy "Allow update access to authenticated users" on public.%I for update to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- Segments are referenced by campaigns; deleting one out from under a sent campaign
-- would orphan its history, so deletion is deliberately not granted.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'segments'
      and policyname = 'Allow delete access to authenticated users'
  ) then
    create policy "Allow delete access to authenticated users"
      on public.segments for delete to authenticated using (true);
  end if;
end $$;
