-- Approved, complete, consent-aware campaign delivery (audit H3, H4, H6, H7).
--
-- 1. Revisions (H6). A campaign's content carries a revision number that moves on
--    every content change. Approval records the revision it approved, and nothing can
--    reach 'sending' unless the approved revision is the current one. Editing a failed
--    campaign returns it to draft and voids the approval; content cannot change at all
--    while it is in review, approved, sending or sent.
--
-- 2. Runs (H7). campaign_runs records, per fan-out, which revision, segment and stream
--    the audience was materialised for, and whether materialisation finished. Dispatch
--    cannot start from a partially prepared run. Preparation is resumable (keyset
--    cursor) and idempotent (the ledger's unique index).
--
-- 3. Claims (H3). Recipients are claimed atomically (FOR UPDATE SKIP LOCKED) under a
--    lease with an ownership token. Only the owner can record an outcome. The provider
--    call is bracketed: `provider_attempted_at` is written BEFORE the call, so a worker
--    that dies afterwards leaves a row that recovery marks 'uncertain' — never pending,
--    never sent. An uncertain row is not retried automatically.
--
-- 4. Eligibility (H4). Consent for the campaign's stream and the contact's lifecycle are
--    checked when claiming and again, atomically, immediately before the provider call.
--    A consent withdrawal or archive also skips that contact's pending rows at once.

-- ---------------------------------------------------------------------------
-- 1. Revisions
-- ---------------------------------------------------------------------------
alter table public.campaigns
    add column if not exists revision integer not null default 1,
    add column if not exists approved_revision integer;

comment on column public.campaigns.revision is
  'Moves on every change to what would be sent: copy, subject, automation, audience, stream, template.';
comment on column public.campaigns.approved_revision is
  'The revision the approval applies to. Sending requires it to equal revision.';

-- Existing approvals are bound to the content they currently have.
update public.campaigns
   set approved_revision = revision
 where status in ('approved', 'sending', 'sent', 'failed')
   and approved_revision is null;

create or replace function public.enforce_campaign_revision()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_content_changed boolean;
  v_audience_changed boolean;
begin
  v_audience_changed :=
       new.segment_id is distinct from old.segment_id
    or new.consent_stream is distinct from old.consent_stream;

  v_content_changed := v_audience_changed
    or new.merge_fields is distinct from old.merge_fields
    or new.subject is distinct from old.subject
    or new.provider_automation_id is distinct from old.provider_automation_id
    or new.template_id is distinct from old.template_id;

  if v_content_changed then
    -- A campaign in review has been read by someone; changing it underneath them would
    -- let an unreviewed version be approved. It must visibly go back to draft first
    -- (the same update may do that).
    if old.status not in ('draft', 'failed') and new.status <> 'draft' then
      raise exception 'Return this campaign to draft before changing its content.'
        using errcode = 'CRM03';
    end if;

    new.revision := old.revision + 1;

    -- A failed campaign that is edited is a new proposal: back to draft, approval void.
    if old.status = 'failed' then
      new.status := 'draft';
      -- A different audience cannot reuse the old run's recipient ledger.
      if v_audience_changed then
        new.send_run := old.send_run + 1;
      end if;
    end if;
  end if;

  if new.status = 'draft' and old.status <> 'draft' then
    new.approved_revision := null;
    new.approved_by := null;
    new.approved_at := null;
  end if;

  -- Approval binds to the revision current at the moment it is recorded.
  if new.status = 'approved' and old.status in ('in_review', 'draft') then
    new.approved_revision := new.revision;
  end if;

  if new.status = 'sending' and new.approved_revision is distinct from new.revision then
    raise exception 'This campaign changed after it was approved. It must be approved again.'
      using errcode = 'CRM04';
  end if;

  -- Dispatch never starts from a partially materialised audience (H7).
  if new.status = 'sending' and old.status <> 'sending' and not exists (
       select 1 from public.campaign_runs r
        where r.campaign_id = new.id and r.run = new.send_run and r.audience_status = 'prepared'
     ) then
    raise exception 'This campaign''s audience has not been fully prepared for sending.'
      using errcode = 'CRM05';
  end if;

  if new.status = 'approved' and old.status = 'failed'
     and new.approved_revision is distinct from new.revision then
    raise exception 'A retry must send the revision that was approved.' using errcode = 'CRM04';
  end if;

  return new;
end;
$$;

-- Named to sort before campaigns_status_transition, so the transition check sees the
-- status this trigger settles on.
drop trigger if exists campaigns_revision on public.campaigns;
create trigger campaigns_revision
    before update on public.campaigns
    for each row execute function public.enforce_campaign_revision();

-- ---------------------------------------------------------------------------
-- 2. Runs
-- ---------------------------------------------------------------------------
create table if not exists public.campaign_runs (
    campaign_id     uuid not null references public.campaigns (id) on delete cascade,
    run             integer not null check (run >= 1),
    revision        integer not null,
    segment_id      uuid not null references public.segments (id),
    consent_stream  public.consent_stream not null,
    audience_status text not null default 'preparing'
                    check (audience_status in ('preparing', 'prepared')),
    -- Keyset cursor: the last contact id materialised. Resuming continues after it.
    audience_cursor uuid,
    -- What the live audience query counted when preparation began. Compared with the
    -- materialised count for visibility; a moving live audience makes them differ.
    expected_count  integer,
    prepared_count  integer not null default 0,
    prepared_at     timestamptz,
    created_at      timestamptz not null default timezone('utc'::text, now()),
    primary key (campaign_id, run)
);

comment on table public.campaign_runs is
  'One row per campaign fan-out: which approved revision and audience it materialised, and whether that finished.';

alter table public.campaign_runs enable row level security;
revoke all on public.campaign_runs from anon;
drop policy if exists "Allow read access to authenticated users" on public.campaign_runs;
drop policy if exists "Allow insert access to authenticated users" on public.campaign_runs;
drop policy if exists "Allow update access to authenticated users" on public.campaign_runs;
drop policy if exists "Approved CRM members only" on public.campaign_runs;
create policy "Allow read access to authenticated users"
  on public.campaign_runs for select to authenticated using (true);
create policy "Allow insert access to authenticated users"
  on public.campaign_runs for insert to authenticated with check (true);
create policy "Allow update access to authenticated users"
  on public.campaign_runs for update to authenticated using (true) with check (true);
create policy "Approved CRM members only"
  on public.campaign_runs as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

-- Runs that already have ledger rows are, by definition, fully prepared: the old send
-- path wrote the whole ledger in one request before claiming the campaign.
insert into public.campaign_runs
       (campaign_id, run, revision, segment_id, consent_stream, audience_status,
        expected_count, prepared_count, prepared_at)
select c.id, cs.run, coalesce(c.approved_revision, c.revision), c.segment_id, c.consent_stream,
       'prepared', count(*), count(*), min(cs.created_at)
  from public.campaign_sends cs
  join public.campaigns c on c.id = cs.campaign_id
 where c.segment_id is not null
 group by c.id, cs.run, c.approved_revision, c.revision, c.segment_id, c.consent_stream
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. Ledger: claims, attempts, outcomes
-- ---------------------------------------------------------------------------
alter table public.campaign_sends
    add column if not exists claim_token           uuid,
    add column if not exists lease_expires_at      timestamptz,
    add column if not exists provider_attempted_at timestamptz,
    add column if not exists attempts              integer not null default 0,
    add column if not exists revision              integer;

comment on column public.campaign_sends.provider_attempted_at is
  'Written immediately BEFORE the provider call. Set on a row that is not sent means the outcome may be unknown.';
comment on column public.campaign_sends.revision is
  'The campaign revision whose content this recipient was sent (or attempted).';

alter table public.campaign_sends drop constraint if exists campaign_sends_status_check;
alter table public.campaign_sends add constraint campaign_sends_status_check
    check (status in ('pending', 'processing', 'sent', 'failed', 'skipped', 'uncertain'));

create index if not exists campaign_sends_processing_idx
    on public.campaign_sends (campaign_id, run) where status = 'processing';

-- Eligibility of one contact for one stream, in one place.
create or replace function public.campaign_ineligibility(
  p_contact public.contacts,
  p_stream public.consent_stream
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_contact.id is null then 'The contact no longer exists.'
    when p_contact.removed_at is not null then 'The contact was removed.'
    when p_contact.deleted_at is not null then 'The contact is archived.'
    when p_stream = 'newsletter' and not p_contact.subscribed_to_newsletter
      then 'The contact withdrew newsletter consent.'
    when p_stream = 'programs' and not p_contact.subscribed_to_programs
      then 'The contact withdrew courses and training consent.'
    when coalesce(btrim(p_contact.email), '') = '' then 'Contact has no email address.'
    else null
  end;
$$;

/*
 * Claims up to p_limit pending recipients of a sending campaign's run.
 *
 * Before claiming it (a) recovers expired leases — a row never sent to the provider
 * goes back to pending, one that may have been sent becomes 'uncertain' — and (b) skips
 * pending rows whose contact is no longer eligible, recording why.
 *
 * SECURITY INVOKER: members act under RLS; the cron worker uses the service role.
 */
create or replace function public.claim_campaign_sends(
  p_campaign_id   uuid,
  p_run           integer,
  p_limit         integer,
  p_lease_seconds integer default 300
)
returns table (
  send_id     uuid,
  contact_id  uuid,
  email       text,
  first_name  text,
  last_name   text,
  claim_token uuid
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_token  uuid := gen_random_uuid();
  v_stream public.consent_stream;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'claim_campaign_sends: p_limit must be between 1 and 1000';
  end if;

  select c.consent_stream into v_stream
    from public.campaigns c
   where c.id = p_campaign_id and c.status = 'sending' and c.send_run = p_run;

  if v_stream is null then
    return;  -- not sending (paused, finished, another run): nothing to claim
  end if;

  update public.campaign_sends cs
     set status = case when cs.provider_attempted_at is null then 'pending' else 'uncertain' end,
         error = case when cs.provider_attempted_at is null then cs.error
                      else 'The worker stopped after contacting the provider; whether the email was queued is unknown.' end,
         lease_expires_at = null,
         -- Kept on an uncertain row so the original worker can still prove ownership
         -- and settle it if its provider call did succeed.
         claim_token = case when cs.provider_attempted_at is null then null else cs.claim_token end
   where cs.campaign_id = p_campaign_id
     and cs.run = p_run
     and cs.status = 'processing'
     and cs.lease_expires_at < now();

  update public.campaign_sends cs
     set status = 'skipped',
         error = public.campaign_ineligibility(ct, v_stream),
         attempted_at = now()
    from public.contacts ct
   where cs.campaign_id = p_campaign_id
     and cs.run = p_run
     and cs.status = 'pending'
     and ct.id = cs.contact_id
     and public.campaign_ineligibility(ct, v_stream) is not null;

  return query
  with picked as (
    select cs.id
      from public.campaign_sends cs
     where cs.campaign_id = p_campaign_id
       and cs.run = p_run
       and cs.status = 'pending'
     order by cs.created_at, cs.id
     limit p_limit
     for update skip locked
  ), claimed as (
    update public.campaign_sends cs
       set status = 'processing',
           claim_token = v_token,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           attempts = cs.attempts + 1
      from picked
     where cs.id = picked.id
    returning cs.id, cs.contact_id, cs.claim_token
  )
  select claimed.id, claimed.contact_id, ct.email, ct.first_name, ct.last_name, claimed.claim_token
    from claimed
    join public.contacts ct on ct.id = claimed.contact_id;
end;
$$;

/*
 * The last step before the provider call, atomically:
 *   * the caller still owns the claim and the lease is live
 *   * the campaign is still sending the approved revision
 *   * the contact is still eligible — checked here, not only at claim time
 * and, when all hold, records that the provider is about to be contacted.
 *
 * Returns 'go', 'lost' (another worker or recovery owns the row now), or 'skipped'
 * (ineligible; the row is settled as skipped with the reason).
 */
create or replace function public.begin_campaign_dispatch(p_send_id uuid, p_token uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row      public.campaign_sends;
  v_campaign public.campaigns;
  v_contact  public.contacts;
  v_reason   text;
begin
  select * into v_row from public.campaign_sends
   where id = p_send_id
   for update;

  if not found or v_row.status <> 'processing' or v_row.claim_token is distinct from p_token
     or v_row.lease_expires_at < now() then
    return 'lost';
  end if;

  select * into v_campaign from public.campaigns where id = v_row.campaign_id;

  if v_campaign.status <> 'sending' or v_campaign.send_run <> v_row.run
     or v_campaign.approved_revision is distinct from v_campaign.revision then
    -- Paused or superseded: give the row back untouched.
    update public.campaign_sends
       set status = 'pending', claim_token = null, lease_expires_at = null
     where id = p_send_id;
    return 'lost';
  end if;

  select * into v_contact from public.contacts where id = v_row.contact_id;
  v_reason := public.campaign_ineligibility(v_contact, v_campaign.consent_stream);

  if v_reason is not null then
    update public.campaign_sends
       set status = 'skipped', error = v_reason, claim_token = null,
           lease_expires_at = null, attempted_at = now()
     where id = p_send_id;
    return 'skipped';
  end if;

  update public.campaign_sends
     set provider_attempted_at = now(), revision = v_campaign.revision
   where id = p_send_id;

  return 'go';
end;
$$;

/*
 * Records a claimed recipient's outcome. Only the claim's owner can.
 *
 *   sent       the provider accepted it
 *   failed     the provider refused it; retrying the same request will not help
 *   pending    known NOT to have been accepted (e.g. rate limited): back in the queue
 *   uncertain  the provider may or may not have accepted it (timeout, 5xx, lost reply)
 *
 * A worker whose lease expired mid-call can still settle an 'uncertain' row it owned
 * as 'sent' — that is the one case where late knowledge is strictly better.
 *
 * Returns false when the caller no longer owns the row. The caller must treat that as
 * a stale worker, never as success.
 */
create or replace function public.complete_campaign_send(
  p_send_id   uuid,
  p_token     uuid,
  p_status    text,
  p_reference text default null,
  p_error     text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_status not in ('sent', 'failed', 'pending', 'uncertain') then
    raise exception 'complete_campaign_send: invalid status %', p_status;
  end if;

  update public.campaign_sends
     set status = p_status,
         provider_reference = case when p_status = 'sent' then p_reference else provider_reference end,
         error = case when p_status = 'sent' then null else p_error end,
         attempted_at = now(),
         -- Pending means the provider definitely did not take it, so the next attempt
         -- starts clean.
         provider_attempted_at = case when p_status = 'pending' then null else provider_attempted_at end,
         claim_token = null,
         lease_expires_at = null
   where id = p_send_id
     and claim_token = p_token
     and (status = 'processing' or (status = 'uncertain' and p_status = 'sent'));

  return found;
end;
$$;

/*
 * Operator reconciliation of uncertain recipients, after checking the provider:
 * 'sent' records that the email did go; 'retry' puts them back in the queue.
 */
create or replace function public.resolve_uncertain_campaign_sends(
  p_campaign_id uuid,
  p_run         integer,
  p_resolution  text
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_resolution not in ('sent', 'retry') then
    raise exception 'resolve_uncertain_campaign_sends: resolution must be sent or retry';
  end if;

  update public.campaign_sends
     set status = case when p_resolution = 'sent' then 'sent' else 'pending' end,
         error = case when p_resolution = 'sent' then null
                      else 'Re-queued by an operator after checking the provider.' end,
         provider_attempted_at = case when p_resolution = 'sent' then provider_attempted_at else null end,
         claim_token = null,
         lease_expires_at = null
   where campaign_id = p_campaign_id
     and run = p_run
     and status = 'uncertain';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.claim_campaign_sends(uuid, integer, integer, integer) from public, anon;
revoke all on function public.begin_campaign_dispatch(uuid, uuid) from public, anon;
revoke all on function public.complete_campaign_send(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.resolve_uncertain_campaign_sends(uuid, integer, text) from public, anon;
revoke all on function public.campaign_ineligibility(public.contacts, public.consent_stream) from public, anon;
grant execute on function public.claim_campaign_sends(uuid, integer, integer, integer) to authenticated, service_role;
grant execute on function public.begin_campaign_dispatch(uuid, uuid) to authenticated, service_role;
grant execute on function public.complete_campaign_send(uuid, uuid, text, text, text) to authenticated, service_role;
grant execute on function public.resolve_uncertain_campaign_sends(uuid, integer, text) to authenticated, service_role;
grant execute on function public.campaign_ineligibility(public.contacts, public.consent_stream) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Eligibility changes reach queued work immediately (H4)
-- ---------------------------------------------------------------------------
-- The dispatch-time check above is the guarantee; this makes a withdrawal visible in
-- the ledger straight away instead of when the row is next claimed. Only 'pending' rows
-- are touched — history (sent, failed, uncertain) is never rewritten, and restoring a
-- contact later does not revive a skipped row.
create or replace function public.skip_queued_sends_for_ineligible_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.campaign_sends cs
     set status = 'skipped',
         error = public.campaign_ineligibility(new, c.consent_stream),
         attempted_at = now()
    from public.campaigns c
   where cs.contact_id = new.id
     and cs.status = 'pending'
     and c.id = cs.campaign_id
     and public.campaign_ineligibility(new, c.consent_stream) is not null;

  return null;
end;
$$;

drop trigger if exists contacts_skip_queued_sends on public.contacts;
create trigger contacts_skip_queued_sends
    after update of subscribed_to_newsletter, subscribed_to_programs, deleted_at, removed_at, email
    on public.contacts
    for each row execute function public.skip_queued_sends_for_ineligible_contact();

-- ---------------------------------------------------------------------------
-- 5. Booking links can be minted for a claimed recipient
-- ---------------------------------------------------------------------------
create or replace function public.create_campaign_booking(
  p_token_hash text,
  p_contact_id uuid,
  p_campaign_id uuid,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking_id uuid;
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid booking token hash.' using errcode = '22023';
  end if;

  if p_expires_at <= now() or p_expires_at > now() + interval '31 days' then
    raise exception 'Invalid booking expiry.' using errcode = '22023';
  end if;

  -- Only for a recipient the send pipeline currently holds.
  if not exists (
    select 1
      from public.campaigns c
      join public.campaign_sends cs
        on cs.campaign_id = c.id
       and cs.contact_id = p_contact_id
       and cs.run = c.send_run
     where c.id = p_campaign_id
       and c.status = 'sending'
       and cs.status in ('pending', 'processing')
  ) then
    raise exception 'No pending campaign send can mint this booking.' using errcode = '42501';
  end if;

  insert into public.bookings (token_hash, contact_id, campaign_id, status, expires_at)
  values (p_token_hash, p_contact_id, p_campaign_id, 'pending', p_expires_at)
  returning id into booking_id;

  return booking_id;
end;
$$;

revoke all on function public.create_campaign_booking(text, uuid, uuid, timestamptz) from public, anon;
grant execute on function public.create_campaign_booking(text, uuid, uuid, timestamptz)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Ledger summaries, many campaigns per call (also audit A2)
-- ---------------------------------------------------------------------------
-- Every status is counted, so skipped and uncertain recipients are never folded into
-- "sent" or dropped from the total. One call serves a whole page of campaigns.
create or replace function public.campaign_send_summaries(p_campaign_ids uuid[])
returns table (
  campaign_id    uuid,
  run            integer,
  pending        integer,
  processing     integer,
  sent           integer,
  failed         integer,
  skipped        integer,
  uncertain      integer,
  failure_reason text,
  stall_reason   text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    c.id,
    c.send_run,
    count(cs.id) filter (where cs.status = 'pending')::integer,
    count(cs.id) filter (where cs.status = 'processing')::integer,
    count(cs.id) filter (where cs.status = 'sent')::integer,
    count(cs.id) filter (where cs.status = 'failed')::integer,
    count(cs.id) filter (where cs.status = 'skipped')::integer,
    count(cs.id) filter (where cs.status = 'uncertain')::integer,
    (select x.error from public.campaign_sends x
      where x.campaign_id = c.id and x.run = c.send_run and x.status = 'failed'
        and nullif(btrim(x.error), '') is not null
      order by x.attempted_at desc nulls last limit 1),
    (select x.error from public.campaign_sends x
      where x.campaign_id = c.id and x.run = c.send_run and x.status in ('pending', 'uncertain')
        and nullif(btrim(x.error), '') is not null
      order by x.attempted_at desc nulls last limit 1)
  from public.campaigns c
  left join public.campaign_sends cs on cs.campaign_id = c.id and cs.run = c.send_run
  where c.id = any (p_campaign_ids)
    and cardinality(p_campaign_ids) <= 200
  group by c.id, c.send_run;
$$;

revoke all on function public.campaign_send_summaries(uuid[]) from public, anon;
grant execute on function public.campaign_send_summaries(uuid[]) to authenticated, service_role;
