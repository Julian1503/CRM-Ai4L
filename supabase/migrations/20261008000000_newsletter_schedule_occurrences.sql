-- Durable newsletter occurrences (audit H12).
--
-- Before: the runner advanced newsletter_schedules.next_run_at and only then loaded the
-- template, drafted the campaign and called the model. A failure after the advance lost
-- that occurrence for good; only campaigns_schedule_occurrence_idx stopped duplicates.
--
-- Now an occurrence is a row. record_newsletter_occurrences writes the due occurrence(s)
-- and advances next_run_at in ONE transaction, so an advance can never happen without the
-- work it stands for. Drafting is leased work on that row:
--
--   pending -> drafting (leased) -> drafted
--                  |  failure: back to pending with backoff, or failed after max_attempts
--                  `  lease expired: retryable (counts as an attempt)
--   skipped: an older occurrence missed while the scheduler was not running
--   failed / skipped -> pending only by retry_newsletter_occurrence (a person)
--
-- Catch-up (plan decision 14.4, conservative default): when several occurrences were
-- missed, only the most recent is drafted; the older ones are recorded as `skipped`
-- with a reason, visible in the schedule list, and a person may retry any of them.
--
-- Nothing here is ever physically deleted.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public.newsletter_schedule_occurrences (
    id                uuid primary key default gen_random_uuid(),
    schedule_id       uuid not null references public.newsletter_schedules (id) on delete restrict,
    -- The local calendar date of the occurrence: the campaign's `scheduled_for`.
    scheduled_for     date not null,
    -- The instant the occurrence was due.
    due_at            timestamptz not null,
    status            text not null default 'pending'
                      check (status in ('pending', 'drafting', 'drafted', 'failed', 'skipped')),
    attempts          integer not null default 0 check (attempts >= 0),
    max_attempts      integer not null default 3 check (max_attempts between 1 and 10),
    next_attempt_at   timestamptz not null default timezone('utc'::text, now()),
    claim_token       uuid,
    lease_expires_at  timestamptz,
    last_error        text,
    skip_reason       text,
    campaign_id       uuid references public.campaigns (id) on delete restrict,
    retried_by        uuid references auth.users (id) on delete set null,
    retried_at        timestamptz,
    created_at        timestamptz not null default timezone('utc'::text, now()),
    updated_at        timestamptz not null default timezone('utc'::text, now()),
    finished_at       timestamptz,
    unique (schedule_id, scheduled_for),
    constraint newsletter_occurrences_lease_when_drafting check (
      (status = 'drafting') = (claim_token is not null and lease_expires_at is not null)
    ),
    constraint newsletter_occurrences_drafted_has_campaign check (status <> 'drafted' or campaign_id is not null),
    constraint newsletter_occurrences_skipped_has_reason check (status <> 'skipped' or skip_reason is not null)
);

create index if not exists newsletter_occurrences_work_idx
    on public.newsletter_schedule_occurrences (next_attempt_at)
    where status in ('pending', 'drafting');

create index if not exists newsletter_occurrences_attention_idx
    on public.newsletter_schedule_occurrences (schedule_id, scheduled_for desc)
    where status in ('failed', 'skipped');

comment on table public.newsletter_schedule_occurrences is
  'One row per newsletter schedule occurrence (audit H12). Written together with the '
  'schedule advance; drafting is leased, retried with backoff, and visible when it fails.';

-- ---------------------------------------------------------------------------
-- 2. Access: members read; every write goes through the functions below
-- ---------------------------------------------------------------------------
alter table public.newsletter_schedule_occurrences enable row level security;
revoke all on public.newsletter_schedule_occurrences from anon, authenticated;
grant all on public.newsletter_schedule_occurrences to service_role;
grant select on public.newsletter_schedule_occurrences to authenticated;

drop policy if exists "Approved CRM members only" on public.newsletter_schedule_occurrences;
create policy "Approved CRM members only" on public.newsletter_schedule_occurrences
  as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

drop policy if exists "Allow read access to authenticated users" on public.newsletter_schedule_occurrences;
create policy "Allow read access to authenticated users" on public.newsletter_schedule_occurrences
  for select to authenticated using (true);

create or replace function public.newsletter_occurrence_require_caller()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member or the scheduler is required.' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Record due occurrences + advance, atomically
-- ---------------------------------------------------------------------------
/*
 * p_occurrences: every occurrence due since p_expected_next_run_at, oldest first, as
 *   [{ "scheduledFor": "YYYY-MM-DD", "dueAt": "<timestamptz>" }, ...]  (1..200)
 * The schedule must still hold p_expected_next_run_at; otherwise another run recorded
 * these occurrences already and nothing changes ('claimed_elsewhere').
 *
 * Catch-up: the last (most recent) occurrence is recorded `pending`; older ones
 * `skipped` with a reason. Re-recording an existing occurrence is a no-op.
 */
create or replace function public.record_newsletter_occurrences(
  p_schedule_id           uuid,
  p_expected_next_run_at  timestamptz,
  p_next_run_at           timestamptz,
  p_occurrences           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.newsletter_schedules;
  v_count    integer;
  v_elem     jsonb;
  v_index    integer := 0;
  v_previous timestamptz := null;
  v_due      timestamptz;
  v_pending  uuid;
  v_skipped  integer := 0;
begin
  perform public.newsletter_occurrence_require_caller();

  if p_occurrences is null or jsonb_typeof(p_occurrences) <> 'array' then
    raise exception 'p_occurrences must be an array' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_occurrences);
  if v_count < 1 or v_count > 200 then
    raise exception 'between 1 and 200 occurrences may be recorded at once' using errcode = '22023';
  end if;

  select * into v_schedule
    from public.newsletter_schedules
   where id = p_schedule_id
   for update;
  if not found then
    raise exception 'Schedule not found.' using errcode = 'P0002';
  end if;
  if v_schedule.next_run_at is distinct from p_expected_next_run_at then
    return jsonb_build_object('outcome', 'claimed_elsewhere');
  end if;
  if not v_schedule.is_active or v_schedule.archived_at is not null or v_schedule.removed_at is not null then
    return jsonb_build_object('outcome', 'inactive');
  end if;

  for v_elem in select value from jsonb_array_elements(p_occurrences) loop
    v_index := v_index + 1;
    v_due := (v_elem ->> 'dueAt')::timestamptz;
    if v_due is null or (v_elem ->> 'scheduledFor') is null then
      raise exception 'each occurrence needs scheduledFor and dueAt' using errcode = '22023';
    end if;
    if v_due > now() then
      raise exception 'an occurrence in the future cannot be recorded' using errcode = '22023';
    end if;
    if v_previous is not null and v_due <= v_previous then
      raise exception 'occurrences must be in ascending order' using errcode = '22023';
    end if;
    if v_index = 1 and v_due <> p_expected_next_run_at then
      raise exception 'the first occurrence must be the one the schedule was waiting for' using errcode = '22023';
    end if;
    v_previous := v_due;

    if v_index = v_count then
      insert into public.newsletter_schedule_occurrences (schedule_id, scheduled_for, due_at, status)
      values (p_schedule_id, (v_elem ->> 'scheduledFor')::date, v_due, 'pending')
      on conflict (schedule_id, scheduled_for) do nothing
      returning id into v_pending;
    else
      insert into public.newsletter_schedule_occurrences
        (schedule_id, scheduled_for, due_at, status, skip_reason, finished_at)
      values (p_schedule_id, (v_elem ->> 'scheduledFor')::date, v_due, 'skipped',
              'Missed while the scheduler was not running. Only the most recent missed issue is drafted '
              || '(catch-up policy); retry this one to draft it as well.', now())
      on conflict (schedule_id, scheduled_for) do nothing;
      if found then
        v_skipped := v_skipped + 1;
      end if;
    end if;
  end loop;

  if p_next_run_at is null or p_next_run_at <= v_previous or p_next_run_at <= now() then
    raise exception 'the next run must be after the last recorded occurrence and in the future'
      using errcode = '22023';
  end if;

  update public.newsletter_schedules
     set next_run_at = p_next_run_at,
         updated_at = timezone('utc'::text, now())
   where id = p_schedule_id;

  return jsonb_build_object('outcome', 'recorded', 'pendingId', v_pending, 'skipped', v_skipped);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Leased drafting work
-- ---------------------------------------------------------------------------
/*
 * Claims up to p_limit occurrences ready to draft — pending and due for an attempt, or
 * drafting with an expired lease — for active, unarchived schedules. With
 * p_occurrence_id, claims only that one (used by an operator's retry). An expired lease
 * that has used up its attempts becomes `failed` instead.
 */
create or replace function public.claim_newsletter_occurrences(
  p_limit          integer default 3,
  p_lease_seconds  integer default 300,
  p_occurrence_id  uuid default null
)
returns setof public.newsletter_schedule_occurrences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  perform public.newsletter_occurrence_require_caller();
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'p_limit must be between 1 and 20' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'p_lease_seconds must be between 30 and 900' using errcode = '22023';
  end if;

  update public.newsletter_schedule_occurrences
     set status = 'failed',
         claim_token = null,
         lease_expires_at = null,
         last_error = coalesce(last_error || ' ', '')
                      || format('The draft did not finish within its lease (attempt %s of %s).', attempts, max_attempts),
         finished_at = now(),
         updated_at = now()
   where status = 'drafting'
     and lease_expires_at < now()
     and attempts >= max_attempts;

  return query
  with picked as (
    select o.id
      from public.newsletter_schedule_occurrences o
      join public.newsletter_schedules s on s.id = o.schedule_id
     where (p_occurrence_id is null or o.id = p_occurrence_id)
       and s.is_active and s.archived_at is null and s.removed_at is null
       and (
         (o.status = 'pending' and o.next_attempt_at <= now())
         or (o.status = 'drafting' and o.lease_expires_at < now())
       )
     order by o.due_at
     limit p_limit
     for update of o skip locked
  )
  update public.newsletter_schedule_occurrences o
     set status = 'drafting',
         claim_token = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1,
         updated_at = now()
    from picked
   where o.id = picked.id
  returning o.*;
end;
$$;

/* Records the drafted campaign. False when the caller no longer holds the lease. */
create or replace function public.complete_newsletter_occurrence(
  p_occurrence_id uuid,
  p_claim_token   uuid,
  p_campaign_id   uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.newsletter_occurrence_require_caller();
  if not exists (
    select 1 from public.campaigns c
      join public.newsletter_schedule_occurrences o on o.id = p_occurrence_id
     where c.id = p_campaign_id and c.schedule_id = o.schedule_id and c.scheduled_for = o.scheduled_for
  ) then
    raise exception 'The campaign does not belong to this occurrence.' using errcode = '22023';
  end if;

  update public.newsletter_schedule_occurrences
     set status = 'drafted', campaign_id = p_campaign_id, claim_token = null, lease_expires_at = null,
         last_error = null, finished_at = now(), updated_at = now()
   where id = p_occurrence_id and claim_token = p_claim_token and status = 'drafting'
  returning id into v_id;
  return v_id is not null;
end;
$$;

/*
 * Records a failed attempt. Retryable failures go back to `pending` with exponential
 * backoff until max_attempts, then `failed`; a non-retryable failure (template unusable,
 * segment archived) is `failed` at once. False when the caller no longer holds the lease.
 */
create or replace function public.fail_newsletter_occurrence(
  p_occurrence_id uuid,
  p_claim_token   uuid,
  p_error         text,
  p_retryable     boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    public.newsletter_schedule_occurrences;
  v_status text;
begin
  perform public.newsletter_occurrence_require_caller();
  select * into v_row from public.newsletter_schedule_occurrences
   where id = p_occurrence_id and claim_token = p_claim_token and status = 'drafting'
   for update;
  if not found then
    return 'lost';
  end if;

  v_status := case when p_retryable and v_row.attempts < v_row.max_attempts then 'pending' else 'failed' end;
  update public.newsletter_schedule_occurrences
     set status = v_status,
         claim_token = null,
         lease_expires_at = null,
         last_error = left(coalesce(nullif(btrim(p_error), ''), 'unknown error'), 1000),
         next_attempt_at = case when v_status = 'pending'
                                then now() + make_interval(secs => least(3600, 60 * power(2, v_row.attempts)::integer))
                                else next_attempt_at end,
         finished_at = case when v_status = 'failed' then now() else null end,
         updated_at = now()
   where id = p_occurrence_id;
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Operator retry
-- ---------------------------------------------------------------------------
/* A person puts a failed or skipped occurrence back in the queue with fresh attempts. */
create or replace function public.retry_newsletter_occurrence(p_occurrence_id uuid)
returns public.newsletter_schedule_occurrences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.newsletter_schedule_occurrences;
begin
  if not public.is_crm_member() then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  update public.newsletter_schedule_occurrences
     set status = 'pending', attempts = 0, next_attempt_at = now(), skip_reason = null,
         retried_by = auth.uid(), retried_at = now(), finished_at = null, updated_at = now()
   where id = p_occurrence_id and status in ('failed', 'skipped')
  returning * into v_row;

  if not found then
    if exists (select 1 from public.newsletter_schedule_occurrences where id = p_occurrence_id) then
      raise exception 'Only a failed or skipped occurrence can be retried.' using errcode = 'CRM06';
    end if;
    raise exception 'Occurrence not found.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Function privileges
-- ---------------------------------------------------------------------------
revoke all on function public.newsletter_occurrence_require_caller() from public, anon;
grant execute on function public.newsletter_occurrence_require_caller() to authenticated, service_role;

-- The scheduler (service role) and approved members ("retry now" runs the occurrence
-- with the member's own session). Each function checks the caller itself.
revoke all on function public.record_newsletter_occurrences(uuid, timestamptz, timestamptz, jsonb) from public, anon;
revoke all on function public.claim_newsletter_occurrences(integer, integer, uuid) from public, anon;
revoke all on function public.complete_newsletter_occurrence(uuid, uuid, uuid) from public, anon;
revoke all on function public.fail_newsletter_occurrence(uuid, uuid, text, boolean) from public, anon;
revoke all on function public.retry_newsletter_occurrence(uuid) from public, anon;
grant execute on function public.record_newsletter_occurrences(uuid, timestamptz, timestamptz, jsonb) to authenticated, service_role;
grant execute on function public.claim_newsletter_occurrences(integer, integer, uuid) to authenticated, service_role;
grant execute on function public.complete_newsletter_occurrence(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.fail_newsletter_occurrence(uuid, uuid, text, boolean) to authenticated, service_role;
grant execute on function public.retry_newsletter_occurrence(uuid) to authenticated;

comment on column public.newsletter_schedules.next_run_at is
  'When the next occurrence is due. Advanced only by record_newsletter_occurrences, in the '
  'same transaction that records the due occurrence (audit H12).';
