-- Archive and remove, for segments and campaigns.
--
-- Two ways to take something out of the way, neither of which destroys a row:
--
--   archived_at  Hidden from lists and pickers, shown in the Archive view, restorable.
--   removed_at   Hidden everywhere in the application. Kept in the database so the
--                history that references it (send ledger, bookings, drafted topics)
--                stays explicable. Only an administrator, in SQL, can bring it back.
--
-- Removed implies archived, and a CHECK holds that. Every existing "not archived"
-- filter therefore excludes removed rows without being touched; only the Archive view
-- needs to add `removed_at is null`.
--
-- Every refusal below raises SQLSTATE CRM01, which the API answers as 409
-- (src/lib/lifecycle/lifecycle.ts).
--
-- Nothing in the application deletes a business record. The RLS delete policies that
-- still existed are dropped below, so a physical delete is refused by the database too.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.segments
  add column if not exists archived_at timestamptz,
  add column if not exists removed_at  timestamptz,
  add column if not exists removed_by  uuid;

alter table public.campaigns
  add column if not exists archived_at timestamptz,
  add column if not exists removed_at  timestamptz,
  add column if not exists removed_by  uuid;

do $$
begin
  alter table public.segments
    add constraint segments_removed_is_archived
    check (removed_at is null or archived_at is not null);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.campaigns
    add constraint campaigns_removed_is_archived
    check (removed_at is null or archived_at is not null);
exception
  when duplicate_object then null;
end $$;

comment on column public.segments.archived_at is
  'Set when the segment is archived: hidden from pickers, restorable. See 20260930000000.';
comment on column public.segments.removed_at is
  'Set when the segment is removed: hidden everywhere, never physically deleted. Implies archived_at.';
comment on column public.campaigns.archived_at is
  'Set when the campaign is archived: hidden from lists, restorable, frozen in its status.';
comment on column public.campaigns.removed_at is
  'Set when the campaign is removed: hidden everywhere, never physically deleted. Implies archived_at.';

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
-- A segment's name is unique only among live segments, so an archived one never
-- blocks reusing its name -- the same rule contacts follow for email. Restoring into
-- a taken name is refused by this index and answered as a conflict.
drop index if exists public.segments_name_ci_idx;
create unique index segments_name_ci_idx
    on public.segments (lower(btrim(name))) where archived_at is null;

create index if not exists segments_live_idx  on public.segments  (created_at) where archived_at is null;
create index if not exists campaigns_live_idx on public.campaigns (created_at) where archived_at is null;

-- ---------------------------------------------------------------------------
-- 3. No physical deletes
-- ---------------------------------------------------------------------------
drop policy if exists "Allow delete access to authenticated users" on public.contacts;
drop policy if exists "Allow delete access to authenticated users" on public.segments;
drop policy if exists "Allow delete access to authenticated users" on public.organisations;
drop policy if exists "Allow delete access to authenticated users" on public.services;

-- ---------------------------------------------------------------------------
-- 4. A removal is final for the application
-- ---------------------------------------------------------------------------
-- The API role cannot clear removed_at. An administrator connecting as postgres or
-- service_role can, which is the "only in SQL" escape hatch.
create or replace function public.enforce_removal_is_final()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.removed_at is not null
     and new.removed_at is distinct from old.removed_at
     and current_user in ('authenticated', 'anon') then
    raise exception 'This record was removed and cannot be restored from the application.'
      using errcode = 'CRM01';
  end if;

  return new;
end;
$$;

drop trigger if exists segments_removal_final on public.segments;
create trigger segments_removal_final
    before update of removed_at, archived_at on public.segments
    for each row execute function public.enforce_removal_is_final();

drop trigger if exists campaigns_removal_final on public.campaigns;
create trigger campaigns_removal_final
    before update of removed_at, archived_at on public.campaigns
    for each row execute function public.enforce_removal_is_final();

-- ---------------------------------------------------------------------------
-- 5. A segment in use cannot be archived
-- ---------------------------------------------------------------------------
-- "In use" is anything that would resolve it again: a campaign that is not archived
-- and has not finished (a sent campaign can be re-opened, and then the check in
-- section 6 applies), or a schedule that is not archived, paused or not.
create or replace function public.enforce_segment_archivable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user text;
begin
  if new.archived_at is null or old.archived_at is not null then
    return new;
  end if;

  select format('campaign "%s"', name) into v_user
  from public.campaigns
  where segment_id = new.id
    and archived_at is null
    and status <> 'sent'
  limit 1;

  if not found then
    select format('newsletter schedule "%s"', name) into v_user
    from public.newsletter_schedules
    where segment_id = new.id
      and archived_at is null
    limit 1;
  end if;

  if v_user is not null then
    raise exception 'Segment is in use by %. Archive that first.', v_user
      using errcode = 'CRM01';
  end if;

  return new;
end;
$$;

drop trigger if exists segments_archivable on public.segments;
create trigger segments_archivable
    before update of archived_at on public.segments
    for each row execute function public.enforce_segment_archivable();

-- ---------------------------------------------------------------------------
-- 6. Campaigns: what archiving means for the status machine
-- ---------------------------------------------------------------------------
--   * An approved or sending campaign cannot be archived: mail may be leaving.
--   * An archived campaign is frozen: its status cannot move until it is restored.
--   * A campaign that can still go out (draft, in_review, approved) cannot point at an
--     archived segment, whether by being created, re-pointed, re-opened or restored.
create or replace function public.enforce_campaign_archive_rules()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.archived_at is not null and old.archived_at is null
       and old.status in ('approved', 'sending') then
      raise exception 'Campaign is %. It cannot be archived until it is back in draft or has finished.',
        old.status
      using errcode = 'CRM01';
    end if;

    if new.archived_at is not null and new.status is distinct from old.status then
      raise exception 'Campaign is archived. Restore it before changing its status.'
      using errcode = 'CRM01';
    end if;
  end if;

  if new.archived_at is null
     and new.status in ('draft', 'in_review', 'approved')
     and new.segment_id is not null
     and exists (
       select 1 from public.segments s
       where s.id = new.segment_id and s.archived_at is not null
     ) then
    raise exception 'Segment is archived. Choose another segment or restore it first.'
      using errcode = 'CRM01';
  end if;

  return new;
end;
$$;

drop trigger if exists campaigns_archive_rules on public.campaigns;
create trigger campaigns_archive_rules
    before insert or update of status, segment_id, archived_at on public.campaigns
    for each row execute function public.enforce_campaign_archive_rules();
