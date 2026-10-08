-- Campaign test sends (UX plan P0.2, P1.3): the campaign's current content, through its
-- automation, to one allowlisted test recipient — and the record of it.
--
-- A test send is NOT a delivery: it never touches campaign_runs, campaign_sends or
-- bookings, never changes a campaign's status or approval, and is not counted in any
-- send report. This table is its only trace.
--
-- 1. Evidence stamped by the database. revision, snapshot, content hash, CTA mode and
--    automation are copied from the campaign at insert, so the record cannot disagree
--    with what the campaign was. The caller names the revision it rendered; a campaign
--    that moved on in between is refused (CRM06 stale_revision) rather than recorded
--    against content that was not sent.
-- 2. Rate limited: at most 5 test sends per campaign per rolling hour (CRM09
--    test_send_rate_limited), serialised per campaign so concurrent clicks cannot pass.
-- 3. Bracketed like a real send: the row is written 'pending' BEFORE the provider call
--    and settled once (pending -> sent | failed | uncertain). Nothing else ever changes;
--    there are no deletes. A pending row whose worker died stays pending: "unknown".
-- 4. The allowlist (CAMPAIGN_TEST_RECIPIENTS) lives in the server environment; the API
--    checks it. The database only requires a plausible, lowercased address.

create table if not exists public.campaign_test_sends (
    id                     uuid primary key default gen_random_uuid(),
    campaign_id            uuid not null references public.campaigns (id) on delete restrict,
    revision               integer not null,
    content_snapshot_id    uuid references public.campaign_content_snapshots (id) on delete restrict,
    content_hash           text,
    cta_mode               text not null default 'booking' check (cta_mode in ('booking', 'external_url', 'none')),
    provider_automation_id text,
    recipient              text not null
                           check (recipient = lower(btrim(recipient)) and recipient ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
                                  and char_length(recipient) <= 254),
    outcome                text not null default 'pending' check (outcome in ('pending', 'sent', 'failed', 'uncertain')),
    provider_reference     text,
    error                  text check (error is null or char_length(error) <= 1000),
    actor_id               uuid references auth.users (id) on delete set null default auth.uid(),
    created_at             timestamptz not null default timezone('utc'::text, now()),
    completed_at           timestamptz
);

comment on table public.campaign_test_sends is
  'Test sends of a campaign''s current content to an allowlisted recipient. Never a delivery; immutable once settled.';

create index if not exists campaign_test_sends_campaign_idx
    on public.campaign_test_sends (campaign_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Insert: stamp the evidence, refuse a stale revision, enforce the rate limit
-- ---------------------------------------------------------------------------
create or replace function public.stamp_campaign_test_send()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_campaign public.campaigns;
  v_recent   integer;
begin
  -- Serialise per campaign so two concurrent clicks cannot both pass the limit.
  perform pg_advisory_xact_lock(hashtextextended('campaign_test_send:' || new.campaign_id::text, 0));

  select * into v_campaign from public.campaigns where id = new.campaign_id;
  if not found or v_campaign.removed_at is not null then
    raise exception 'Campaign not found.' using errcode = 'P0002';
  end if;
  if v_campaign.revision <> new.revision then
    raise exception 'This campaign changed since it was loaded. Reload it and test the current version.'
      using errcode = 'CRM06', hint = 'stale_revision';
  end if;

  select count(*) into v_recent
    from public.campaign_test_sends
   where campaign_id = new.campaign_id
     and created_at > timezone('utc'::text, now()) - interval '1 hour';
  if v_recent >= 5 then
    raise exception 'At most 5 test sends per campaign per hour. Try again later.'
      using errcode = 'CRM09', hint = 'test_send_rate_limited';
  end if;

  new.content_snapshot_id := v_campaign.content_snapshot_id;
  new.content_hash := (select content_hash from public.campaign_content_snapshots where id = v_campaign.content_snapshot_id);
  new.cta_mode := coalesce(
    (select cta_mode from public.campaign_content_snapshots where id = v_campaign.content_snapshot_id), 'booking');
  new.provider_automation_id := v_campaign.provider_automation_id;
  new.outcome := 'pending';
  new.provider_reference := null;
  new.error := null;
  new.completed_at := null;
  new.created_at := timezone('utc'::text, now());
  if auth.uid() is not null then
    new.actor_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists campaign_test_sends_stamp on public.campaign_test_sends;
create trigger campaign_test_sends_stamp
    before insert on public.campaign_test_sends
    for each row execute function public.stamp_campaign_test_send();

-- ---------------------------------------------------------------------------
-- Update: settle once; nothing else changes. Delete: never.
-- ---------------------------------------------------------------------------
create or replace function public.guard_campaign_test_send()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Test sends are a record and cannot be deleted.' using errcode = 'CRM06';
  end if;

  -- Deleting an auth user nulls actor_id (on delete set null): the one other change allowed.
  if (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') and new.actor_id is null then
    return new;
  end if;

  if old.outcome <> 'pending' then
    raise exception 'A settled test send cannot change.' using errcode = 'CRM06';
  end if;
  if new.outcome not in ('sent', 'failed', 'uncertain')
     or (to_jsonb(new) - 'outcome' - 'provider_reference' - 'error' - 'completed_at')
        is distinct from (to_jsonb(old) - 'outcome' - 'provider_reference' - 'error' - 'completed_at') then
    raise exception 'Only the outcome of a pending test send can be recorded.' using errcode = 'CRM06';
  end if;

  new.completed_at := timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists campaign_test_sends_guard on public.campaign_test_sends;
create trigger campaign_test_sends_guard
    before update or delete on public.campaign_test_sends
    for each row execute function public.guard_campaign_test_send();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table public.campaign_test_sends enable row level security;
revoke all on public.campaign_test_sends from anon, authenticated;
grant select, insert on public.campaign_test_sends to authenticated;
grant update (outcome, provider_reference, error) on public.campaign_test_sends to authenticated;
grant select, insert, update on public.campaign_test_sends to service_role;
revoke delete, truncate on public.campaign_test_sends from service_role;

drop policy if exists "Members read test sends" on public.campaign_test_sends;
create policy "Members read test sends"
  on public.campaign_test_sends for select to authenticated using (true);
drop policy if exists "Members record their own test sends" on public.campaign_test_sends;
create policy "Members record their own test sends"
  on public.campaign_test_sends for insert to authenticated with check (actor_id = auth.uid());
drop policy if exists "Members settle their own test sends" on public.campaign_test_sends;
create policy "Members settle their own test sends"
  on public.campaign_test_sends for update to authenticated
  using (actor_id = auth.uid()) with check (actor_id = auth.uid());
drop policy if exists "Approved CRM members only" on public.campaign_test_sends;
create policy "Approved CRM members only"
  on public.campaign_test_sends as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

revoke all on function public.stamp_campaign_test_send() from public, anon;
revoke all on function public.guard_campaign_test_send() from public, anon;
