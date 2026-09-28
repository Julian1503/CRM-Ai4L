-- Hardening for 20260930000000_archive_and_remove.sql.
--
-- 1. The race. The segment trigger reads campaigns and schedules; the campaign trigger
--    reads segments. Under READ COMMITTED, archiving a segment while another request
--    creates a draft for it lets each see the other's table before the other commits,
--    and both succeed -- a live draft on an archived segment. Every check now starts by
--    taking a transaction-scoped advisory lock on the segment, so the two serialise and
--    the second one's query (a fresh snapshot, plpgsql being volatile) sees the first.
--
-- 2. The gap. A live schedule cannot point at an archived segment only as long as
--    nothing makes a schedule live again. Restoring an archived schedule whose segment
--    was archived in the meantime did exactly that, and the runner then failed on every
--    cycle. Schedules now get the same rule as campaigns.
--
-- Refusals keep SQLSTATE CRM01, answered as 409 by the API.

create or replace function public.lock_segment_for_archive_rules(p_segment_id uuid)
returns void
language sql
volatile
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended('segment-archive:' || p_segment_id::text, 0));
$$;

comment on function public.lock_segment_for_archive_rules(uuid) is
  'Serialises the archive-rule triggers for one segment. See 20260930010000.';

-- ---------------------------------------------------------------------------
-- Segments: same rule as before, now under the lock.
-- ---------------------------------------------------------------------------
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

  perform public.lock_segment_for_archive_rules(new.id);

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

-- ---------------------------------------------------------------------------
-- Campaigns: same rules as before; the segment check now runs under the lock.
-- ---------------------------------------------------------------------------
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
     and new.segment_id is not null then
    perform public.lock_segment_for_archive_rules(new.segment_id);

    if exists (
      select 1 from public.segments s
      where s.id = new.segment_id and s.archived_at is not null
    ) then
      raise exception 'Segment is archived. Choose another segment or restore it first.'
        using errcode = 'CRM01';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Schedules: a live schedule cannot point at an archived segment.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_schedule_segment_live()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.archived_at is not null then
    return new;
  end if;

  perform public.lock_segment_for_archive_rules(new.segment_id);

  if exists (
    select 1 from public.segments s
    where s.id = new.segment_id and s.archived_at is not null
  ) then
    raise exception 'Segment is archived. Choose another segment or restore it first.'
      using errcode = 'CRM01';
  end if;

  return new;
end;
$$;

drop trigger if exists newsletter_schedules_segment_live on public.newsletter_schedules;
create trigger newsletter_schedules_segment_live
    before insert or update of segment_id, archived_at on public.newsletter_schedules
    for each row execute function public.enforce_schedule_segment_live();
