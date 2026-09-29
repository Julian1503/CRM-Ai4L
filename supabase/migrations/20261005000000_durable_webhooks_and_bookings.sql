-- Recoverable webhooks, payments and bookings (audit H10, H11, M4).
--
-- H11. webhook_events recorded only that an event had been *seen*. A process that died
-- between the claim and the release left the event "handled" forever, and every
-- redelivery was dismissed as a duplicate. Events now have an outcome and a lease:
--   processing (leased) -> completed | failed_retryable | failed_terminal
-- A redelivery of an incomplete event takes it over once the lease has expired.
-- Business changes and the completion are committed in ONE transaction by the
-- apply_* functions below, so there is no window in which one exists without the other.
--
-- H10. The payment return page and the Stripe webhook both marked a booking paid, with
-- separate code and separate checks, and the confirmation email was sent inline (lost
-- on failure). apply_checkout_payment() is now the single path: it verifies the checkout
-- belongs to the booking, never moves a booking backwards, accepts a repeat of the same
-- checkout as success, refuses a different one, and queues exactly one confirmation
-- email in notification_outbox.
--
-- M4. Calendly delivers rescheduling as a cancel of the old invitee plus a create of the
-- new one, in either order, possibly twice. apply_calendly_event() distinguishes a
-- reschedule from a real cancellation, never lets an old invitee's cancel or late create
-- touch its replacement, only trusts the tracking booking id when the invitee's email
-- matches the booking's contact, and parks anything it cannot place in
-- booking_reconciliation instead of dropping it.

-- ---------------------------------------------------------------------------
-- 1. Webhook ledger with outcomes (H11)
-- ---------------------------------------------------------------------------
alter table public.webhook_events
    add column if not exists status text not null default 'completed',
    add column if not exists claim_token uuid,
    add column if not exists lease_expires_at timestamptz,
    add column if not exists attempts integer not null default 1,
    add column if not exists last_error text,
    add column if not exists completed_at timestamptz,
    -- Rows from before this migration: they prove an event was claimed, not that it
    -- was processed. See docs/WEBHOOKS.md for reconciling them.
    add column if not exists legacy boolean not null default false;

update public.webhook_events set legacy = true, completed_at = received_at where completed_at is null;

alter table public.webhook_events alter column status set default 'processing';
alter table public.webhook_events drop constraint if exists webhook_events_status_check;
alter table public.webhook_events add constraint webhook_events_status_check
    check (status in ('processing', 'completed', 'failed_retryable', 'failed_terminal'));

/*
 * Claims one event for processing.
 *   'claimed'      process it; complete with the returned token
 *   'completed'    already done (or terminally refused): acknowledge
 *   'in_progress'  another delivery holds a live lease: answer retryable
 */
create or replace function public.claim_webhook_event(
  p_provider      text,
  p_event_id      text,
  p_event_type    text,
  p_lease_seconds integer default 120
)
returns table (outcome text, claim_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
  v_row   public.webhook_events;
begin
  insert into public.webhook_events (provider, event_id, event_type, status, claim_token, lease_expires_at)
  values (p_provider, p_event_id, p_event_type, 'processing', v_token, now() + make_interval(secs => p_lease_seconds))
  on conflict (provider, event_id) do nothing;

  if found then
    return query select 'claimed'::text, v_token;
    return;
  end if;

  select * into v_row from public.webhook_events
   where provider = p_provider and event_id = p_event_id
   for update;

  if v_row.status in ('completed', 'failed_terminal') then
    return query select 'completed'::text, null::uuid;
    return;
  end if;

  if v_row.status = 'processing' and v_row.lease_expires_at > now() then
    return query select 'in_progress'::text, null::uuid;
    return;
  end if;

  -- Failed retryably, or its worker died: this delivery takes it over.
  update public.webhook_events
     set status = 'processing', claim_token = v_token, attempts = attempts + 1,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = v_row.id;

  return query select 'claimed'::text, v_token;
end;
$$;

create or replace function public.complete_webhook_event(
  p_provider text,
  p_event_id text,
  p_token    uuid,
  p_status   text,
  p_error    text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('completed', 'failed_retryable', 'failed_terminal') then
    raise exception 'complete_webhook_event: invalid status %', p_status;
  end if;

  update public.webhook_events
     set status = p_status,
         completed_at = case when p_status = 'completed' then now() else completed_at end,
         last_error = left(p_error, 500),
         claim_token = null,
         lease_expires_at = null
   where provider = p_provider and event_id = p_event_id
     and claim_token = p_token and status = 'processing';

  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Notification outbox (H10)
-- ---------------------------------------------------------------------------
create table if not exists public.notification_outbox (
    id               uuid primary key default gen_random_uuid(),
    kind             text not null check (kind in ('booking_paid_confirmation')),
    -- One logical message per business fact: a replay cannot queue a second email.
    dedupe_key       text not null unique,
    booking_id       uuid references public.bookings (id) on delete cascade,
    -- The Stripe checkout, re-read at send time for the scheduling link. The raw
    -- booking token is never stored.
    stripe_session_id text,
    status           text not null default 'pending'
                     check (status in ('pending', 'processing', 'sent', 'skipped', 'failed')),
    attempts         integer not null default 0,
    next_attempt_at  timestamptz not null default now(),
    claim_token      uuid,
    lease_expires_at timestamptz,
    last_error       text,
    created_at       timestamptz not null default timezone('utc'::text, now()),
    sent_at          timestamptz
);

alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from anon;
drop policy if exists "Allow read access to authenticated users" on public.notification_outbox;
create policy "Allow read access to authenticated users"
  on public.notification_outbox for select to authenticated using (true);
drop policy if exists "Approved CRM members only" on public.notification_outbox;
create policy "Approved CRM members only"
  on public.notification_outbox as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

create or replace function public.claim_notifications(p_limit integer, p_lease_seconds integer default 120)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  update public.notification_outbox
     set status = 'pending', claim_token = null, lease_expires_at = null
   where status = 'processing' and lease_expires_at < now();

  return query
  with picked as (
    select id from public.notification_outbox
     where status = 'pending' and next_attempt_at <= now()
     order by next_attempt_at
     limit greatest(1, least(p_limit, 100))
     for update skip locked
  )
  update public.notification_outbox n
     set status = 'processing', claim_token = v_token, attempts = n.attempts + 1,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    from picked
   where n.id = picked.id
  returning n.*;
end;
$$;

create or replace function public.complete_notification(
  p_id     uuid,
  p_token  uuid,
  p_status text,
  p_error  text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  if p_status not in ('sent', 'skipped', 'retry') then
    raise exception 'complete_notification: invalid status %', p_status;
  end if;

  select attempts into v_attempts from public.notification_outbox
   where id = p_id and claim_token = p_token and status = 'processing'
   for update;
  if not found then return false; end if;

  update public.notification_outbox
     set status = case
                    when p_status = 'retry' and v_attempts >= 8 then 'failed'
                    when p_status = 'retry' then 'pending'
                    else p_status end,
         sent_at = case when p_status = 'sent' then now() else sent_at end,
         next_attempt_at = now() + least(interval '6 hours', make_interval(mins => power(2, v_attempts)::integer)),
         last_error = left(p_error, 500),
         claim_token = null,
         lease_expires_at = null
   where id = p_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. One payment operation (H10)
-- ---------------------------------------------------------------------------
/*
 * Applies a completed Stripe checkout to its booking. Shared by the return page and the
 * webhook; safe to call any number of times, in any order.
 *
 * Returns 'applied' (moved to paid now), 'already_applied' (this checkout was applied
 * before; nothing moves backwards), 'not_ready' (the booking has not recorded its
 * checkout yet: retry), 'not_found', or 'mismatch' (the checkout does not belong to this
 * booking, or the amount/currency is not the expected $0 AUD).
 * With webhook arguments, the event is completed in the same transaction.
 */
create or replace function public.apply_checkout_payment(
  p_booking_id  uuid,
  p_session_id  text,
  p_amount      integer,
  p_currency    text,
  p_provider    text default null,
  p_event_id    text default null,
  p_event_token uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_outcome text;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;

  if not found then
    v_outcome := 'not_found';
  elsif v_booking.stripe_session_id is null then
    -- The webhook beat the checkout's own write of its session id: retry, do not refuse.
    v_outcome := 'not_ready';
  elsif v_booking.stripe_session_id is distinct from p_session_id
     or p_amount is distinct from 0
     or lower(coalesce(p_currency, 'aud')) <> 'aud' then
    -- A different checkout — or one charging money for the free consultation — can
    -- never mark this booking paid.
    v_outcome := 'mismatch';
  elsif v_booking.status in ('pending', 'checkout_started') then
    update public.bookings
       set status = 'paid', charged_amount_cents = p_amount, updated_at = now()
     where id = p_booking_id;

    insert into public.notification_outbox (kind, dedupe_key, booking_id, stripe_session_id)
    values ('booking_paid_confirmation', 'booking-paid:' || p_booking_id, p_booking_id, p_session_id)
    on conflict (dedupe_key) do nothing;

    v_outcome := 'applied';
  else
    -- paid, booked, cancelled, expired: already past payment for this same checkout.
    v_outcome := 'already_applied';
  end if;

  if p_event_id is not null then
    perform public.complete_webhook_event(
      p_provider, p_event_id, p_event_token,
      case when v_outcome in ('applied', 'already_applied') then 'completed'
           when v_outcome = 'not_ready' then 'failed_retryable'
           else 'failed_terminal' end,
      case when v_outcome in ('applied', 'already_applied') then null else 'checkout ' || v_outcome end
    );
  end if;

  return v_outcome;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Calendly, order-tolerant (M4)
-- ---------------------------------------------------------------------------
alter table public.bookings
    add column if not exists calendly_superseded_invitees text[] not null default '{}';

comment on column public.bookings.calendly_superseded_invitees is
  'Invitees this booking was rescheduled away from. Their late creates and cancels are ignored.';

create table if not exists public.booking_reconciliation (
    id           uuid primary key default gen_random_uuid(),
    provider     text not null default 'calendly',
    event_type   text not null,
    invitee_uri  text not null,
    event_uri    text,
    email        text,
    scheduled_at timestamptz,
    tracking_booking_id uuid,
    old_invitee_uri text,
    reason       text not null,
    attempts     integer not null default 1,
    created_at   timestamptz not null default timezone('utc'::text, now()),
    resolved_at  timestamptz,
    resolution   text,
    unique (provider, event_type, invitee_uri)
);

comment on table public.booking_reconciliation is
  'Calendly events that matched no booking (yet). Retried by the scheduled worker for a week, then left for a person.';

alter table public.booking_reconciliation enable row level security;
revoke all on public.booking_reconciliation from anon;
drop policy if exists "Allow read access to authenticated users" on public.booking_reconciliation;
create policy "Allow read access to authenticated users"
  on public.booking_reconciliation for select to authenticated using (true);
drop policy if exists "Approved CRM members only" on public.booking_reconciliation;
create policy "Approved CRM members only"
  on public.booking_reconciliation as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

/*
 * Applies one Calendly invitee event. Returns 'applied', 'ignored' (a superseded or
 * duplicate invitee), or 'unmatched' (parked in booking_reconciliation).
 */
create or replace function public.apply_calendly_event(
  p_event            text,
  p_invitee_uri      text,
  p_event_uri        text,
  p_scheduled_at     timestamptz,
  p_email            text,
  p_tracking_booking uuid,
  p_rescheduled      boolean,
  p_old_invitee_uri  text,
  p_provider         text default null,
  p_event_id         text default null,
  p_event_token      uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_outcome text;
  v_reason  text;
  v_email   text := lower(btrim(coalesce(p_email, '')));
begin
  if p_event not in ('invitee.created', 'invitee.canceled') then
    raise exception 'apply_calendly_event: unsupported event %', p_event;
  end if;

  -- Already superseded by a reschedule: nothing this invitee says can apply.
  if exists (select 1 from public.bookings where p_invitee_uri = any (calendly_superseded_invitees)) then
    v_outcome := 'ignored';

  elsif p_event = 'invitee.canceled' then
    select * into v_booking from public.bookings
     where calendly_invitee_uri = p_invitee_uri
     for update;

    if not found then
      v_outcome := 'unmatched';
      v_reason := 'cancellation for an invitee no booking holds';
    elsif coalesce(p_rescheduled, false) then
      -- The old slot of a reschedule: the booking stays booked, and the old invitee
      -- is retired so its late events cannot touch the replacement.
      update public.bookings
         set calendly_superseded_invitees = array_append(calendly_superseded_invitees, p_invitee_uri),
             updated_at = now()
       where id = v_booking.id;
      v_outcome := 'applied';
    elsif v_booking.status = 'booked' then
      update public.bookings
         set status = 'cancelled', cancelled_at = now(), updated_at = now()
       where id = v_booking.id;
      v_outcome := 'applied';
    else
      v_outcome := 'ignored';
    end if;

  else  -- invitee.created
    -- 1. The replacement of a reschedule: the booking that holds (or held) the old invitee.
    if p_old_invitee_uri is not null then
      select * into v_booking from public.bookings
       where calendly_invitee_uri = p_old_invitee_uri
          or p_old_invitee_uri = any (calendly_superseded_invitees)
       for update;
    end if;

    -- 2. The tracking id Calendly echoed back, trusted only when the invitee's email
    --    is the booking contact's: the id arrives through a URL anyone can edit.
    if v_booking.id is null and p_tracking_booking is not null then
      select b.* into v_booking
        from public.bookings b
        join public.contacts c on c.id = b.contact_id
       where b.id = p_tracking_booking
         and lower(btrim(c.email)) = v_email
       for update of b;
    end if;

    -- 3. The contact's most recent paid booking, by email.
    if v_booking.id is null and v_email <> '' then
      select b.* into v_booking
        from public.bookings b
        join public.contacts c on c.id = b.contact_id
       where lower(btrim(c.email)) = v_email
         and c.deleted_at is null
         and b.status in ('paid', 'booked')
       order by b.created_at desc
       limit 1
       for update of b;
    end if;

    if v_booking.id is null then
      v_outcome := 'unmatched';
      v_reason := 'no paid booking for this invitee';
    elsif v_booking.calendly_invitee_uri = p_invitee_uri then
      v_outcome := 'ignored';  -- a duplicate create
    elsif v_booking.status not in ('paid', 'booked') then
      v_outcome := 'unmatched';
      v_reason := format('booking %s is %s', v_booking.id, v_booking.status);
    else
      update public.bookings
         set status = 'booked',
             calendly_invitee_uri = p_invitee_uri,
             calendly_event_uri = p_event_uri,
             scheduled_at = coalesce(p_scheduled_at, scheduled_at),
             -- Retire whichever invitee this replaces: the old one named by Calendly,
             -- and the one the booking held, if that differs.
             calendly_superseded_invitees = (
               select coalesce(array_agg(distinct u), '{}') from unnest(
                 calendly_superseded_invitees
                 || case when p_old_invitee_uri is not null then array[p_old_invitee_uri] else '{}'::text[] end
                 || case when calendly_invitee_uri is not null then array[calendly_invitee_uri] else '{}'::text[] end
               ) u where u is not null and u <> p_invitee_uri
             ),
             updated_at = now()
       where id = v_booking.id;
      v_outcome := 'applied';
    end if;
  end if;

  if v_outcome = 'unmatched' then
    insert into public.booking_reconciliation
      (event_type, invitee_uri, event_uri, email, scheduled_at, tracking_booking_id, old_invitee_uri, reason)
    values
      (p_event, p_invitee_uri, p_event_uri, nullif(v_email, ''), p_scheduled_at, p_tracking_booking, p_old_invitee_uri, v_reason)
    on conflict (provider, event_type, invitee_uri)
    do update set attempts = public.booking_reconciliation.attempts + 1, reason = excluded.reason;
  elsif v_outcome = 'applied' then
    update public.booking_reconciliation
       set resolved_at = now(), resolution = 'applied'
     where invitee_uri = p_invitee_uri and event_type = p_event and resolved_at is null;
  end if;

  if p_event_id is not null then
    perform public.complete_webhook_event(p_provider, p_event_id, p_event_token, 'completed', null);
  end if;

  return v_outcome;
end;
$$;

revoke all on function public.claim_webhook_event(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.complete_webhook_event(text, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.claim_notifications(integer, integer) from public, anon, authenticated;
revoke all on function public.complete_notification(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.apply_checkout_payment(uuid, text, integer, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.apply_calendly_event(text, text, text, timestamptz, text, uuid, boolean, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_webhook_event(text, text, text, integer) to service_role;
grant execute on function public.complete_webhook_event(text, text, uuid, text, text) to service_role;
grant execute on function public.claim_notifications(integer, integer) to service_role;
grant execute on function public.complete_notification(uuid, uuid, text, text) to service_role;
grant execute on function public.apply_checkout_payment(uuid, text, integer, text, text, text, uuid) to service_role;
grant execute on function public.apply_calendly_event(text, text, text, timestamptz, text, uuid, boolean, text, text, text, uuid) to service_role;
