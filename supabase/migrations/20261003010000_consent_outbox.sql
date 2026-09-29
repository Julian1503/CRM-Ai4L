-- Durable consent synchronisation to the email provider (audit H5).
--
-- A consent change used to reach EmailOctopus only if the browser that made it fired a
-- follow-up request, and the preference centre never pushed at all: a reader who
-- unsubscribed stayed SUBSCRIBED at the provider. Now every relevant change to a
-- contact writes an outbox entry IN THE SAME TRANSACTION, so a change the CRM commits
-- is a change that will be synchronised, whoever made it — preference centre, operator,
-- import, provider webhook.
--
-- Convergence rules:
--   * contacts.consent_version moves on every change to consent or email address.
--   * A worker pushes the contact's CURRENT state, never a stored snapshot, and settles
--     every entry at or below the version it pushed. A delayed or replayed entry
--     therefore cannot re-enable a withdrawn subscription.
--   * One contact is in flight at a time, so two pushes cannot land out of order.
--   * Archived and removed contacts are included: withdrawal must still reach the
--     provider when the contact has left the active views.
--   * A push that changes nothing in the CRM creates no new version, so a provider
--     webhook echoing our own write terminates instead of looping.

alter table public.contacts
    add column if not exists consent_version bigint not null default 0;

create table if not exists public.consent_sync_outbox (
    id               uuid primary key default gen_random_uuid(),
    contact_id       uuid not null references public.contacts (id) on delete cascade,
    consent_version  bigint not null,
    -- Where the change came from (app.consent_source), for diagnostics only.
    source           text,
    status           text not null default 'pending'
                     check (status in ('pending', 'processing', 'done', 'superseded', 'failed')),
    attempts         integer not null default 0,
    next_attempt_at  timestamptz not null default now(),
    claim_token      uuid,
    lease_expires_at timestamptz,
    last_error       text,
    created_at       timestamptz not null default timezone('utc'::text, now()),
    processed_at     timestamptz,
    unique (contact_id, consent_version)
);

comment on table public.consent_sync_outbox is
  'Consent changes waiting to reach the email provider. Written transactionally by a contacts trigger.';

create index if not exists consent_sync_outbox_due_idx
    on public.consent_sync_outbox (next_attempt_at) where status = 'pending';
create index if not exists consent_sync_outbox_contact_idx
    on public.consent_sync_outbox (contact_id, consent_version);

alter table public.consent_sync_outbox enable row level security;
revoke all on public.consent_sync_outbox from anon;
-- Members may see the queue (operations visibility). Only the functions below write it.
drop policy if exists "Allow read access to authenticated users" on public.consent_sync_outbox;
create policy "Allow read access to authenticated users"
  on public.consent_sync_outbox for select to authenticated using (true);
drop policy if exists "Approved CRM members only" on public.consent_sync_outbox;
create policy "Approved CRM members only"
  on public.consent_sync_outbox as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

-- ---------------------------------------------------------------------------
-- Versioning and enqueueing, in the writing transaction
-- ---------------------------------------------------------------------------
create or replace function public.bump_contact_consent_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subscribed_to_newsletter is distinct from old.subscribed_to_newsletter
     or new.subscribed_to_programs is distinct from old.subscribed_to_programs
     or new.email is distinct from old.email then
    new.consent_version := old.consent_version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists contacts_consent_version on public.contacts;
create trigger contacts_consent_version
    before update on public.contacts
    for each row execute function public.bump_contact_consent_version();

create or replace function public.enqueue_consent_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A contact with no consent is not on the provider list; nothing to push yet.
    if not (new.subscribed_to_newsletter or new.subscribed_to_programs) then
      return null;
    end if;
  elsif new.consent_version = old.consent_version then
    return null;
  end if;

  insert into public.consent_sync_outbox (contact_id, consent_version, source)
  values (new.id, new.consent_version, nullif(current_setting('app.consent_source', true), ''))
  on conflict (contact_id, consent_version) do nothing;

  return null;
end;
$$;

drop trigger if exists contacts_enqueue_consent_sync on public.contacts;
create trigger contacts_enqueue_consent_sync
    after insert or update on public.contacts
    for each row execute function public.enqueue_consent_sync();

-- ---------------------------------------------------------------------------
-- Worker functions
-- ---------------------------------------------------------------------------
create or replace function public.claim_consent_sync(
  p_limit         integer,
  p_contact_id    uuid default null,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id     uuid,
  claim_token   uuid,
  contact_id    uuid,
  state_version bigint,
  email         text,
  first_name    text,
  last_name     text,
  newsletter    boolean,
  programs      boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'claim_consent_sync: p_limit must be between 1 and 500';
  end if;

  -- Pushing current state again is idempotent, so an expired lease is simply retried.
  update public.consent_sync_outbox
     set status = 'pending', claim_token = null, lease_expires_at = null
   where status = 'processing' and lease_expires_at < now();

  -- Older pending entries of a contact are covered by its newest one.
  update public.consent_sync_outbox o
     set status = 'superseded', processed_at = now()
   where o.status = 'pending'
     and exists (
       select 1 from public.consent_sync_outbox n
        where n.contact_id = o.contact_id
          and n.status in ('pending', 'processing')
          and n.consent_version > o.consent_version
     );

  return query
  with picked as (
    select o.id
      from public.consent_sync_outbox o
     where o.status = 'pending'
       and o.next_attempt_at <= now()
       and (p_contact_id is null or o.contact_id = p_contact_id)
       -- One contact in flight at a time, so pushes cannot land out of order.
       and not exists (
         select 1 from public.consent_sync_outbox p
          where p.contact_id = o.contact_id and p.status = 'processing'
       )
     order by o.next_attempt_at, o.created_at
     limit p_limit
     for update skip locked
  ), claimed as (
    update public.consent_sync_outbox o
       set status = 'processing',
           claim_token = v_token,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           attempts = o.attempts + 1
      from picked
     where o.id = picked.id
    returning o.id, o.contact_id
  )
  select claimed.id, v_token, c.id, c.consent_version, c.email, c.first_name, c.last_name,
         c.subscribed_to_newsletter, c.subscribed_to_programs
    from claimed
    join public.contacts c on c.id = claimed.contact_id;
end;
$$;

/*
 * Settles a claimed entry. On success every pending entry for the contact at or below
 * the pushed state's version is settled too. On failure the entry is retried with
 * exponential backoff, and marked 'failed' — visible, never silent — after 8 attempts.
 */
create or replace function public.complete_consent_sync(
  p_outbox_id     uuid,
  p_token         uuid,
  p_state_version bigint,
  p_ok            boolean,
  p_error         text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.consent_sync_outbox;
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  select * into v_row from public.consent_sync_outbox
   where id = p_outbox_id and claim_token = p_token and status = 'processing'
   for update;

  if not found then
    return false;
  end if;

  if p_ok then
    update public.consent_sync_outbox
       set status = 'done', processed_at = now(), claim_token = null,
           lease_expires_at = null, last_error = null
     where id = p_outbox_id;

    update public.consent_sync_outbox
       set status = 'superseded', processed_at = now()
     where contact_id = v_row.contact_id
       and status = 'pending'
       and consent_version <= p_state_version;
  else
    update public.consent_sync_outbox
       set status = case when v_row.attempts >= 8 then 'failed' else 'pending' end,
           next_attempt_at = now() + least(interval '6 hours', make_interval(mins => power(2, v_row.attempts)::integer)),
           claim_token = null,
           lease_expires_at = null,
           last_error = left(coalesce(p_error, 'unknown error'), 500)
     where id = p_outbox_id;
  end if;

  return true;
end;
$$;

/* Operator action: put failed entries back in the queue after fixing the cause. */
create or replace function public.retry_failed_consent_sync()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  update public.consent_sync_outbox
     set status = 'pending', attempts = 0, next_attempt_at = now()
   where status = 'failed';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.claim_consent_sync(integer, uuid, integer) from public, anon;
revoke all on function public.complete_consent_sync(uuid, uuid, bigint, boolean, text) from public, anon;
revoke all on function public.retry_failed_consent_sync() from public, anon;
revoke all on function public.enqueue_consent_sync() from public, anon;
revoke all on function public.bump_contact_consent_version() from public, anon;
grant execute on function public.claim_consent_sync(integer, uuid, integer) to authenticated, service_role;
grant execute on function public.complete_consent_sync(uuid, uuid, bigint, boolean, text) to authenticated, service_role;
grant execute on function public.retry_failed_consent_sync() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Contacts who withdrew every consent may still be SUBSCRIBED at the provider: the
-- preference centre never pushed. Queue a reconciliation for each of them, archived
-- and removed included. Contacts still subscribed are left to the next manual sync.
insert into public.consent_sync_outbox (contact_id, consent_version, source)
select id, consent_version, 'reconciliation_20261003'
  from public.contacts
 where not subscribed_to_newsletter
   and not subscribed_to_programs
   and coalesce(btrim(email), '') <> ''
on conflict (contact_id, consent_version) do nothing;

-- consent_version is a new contacts column; active_contacts must carry every column of
-- contacts (see 20261001010000_refresh_active_contacts_view.sql).
create or replace view public.active_contacts
with (security_invoker = on) as
select * from public.contacts where deleted_at is null;

revoke all on public.active_contacts from anon;
