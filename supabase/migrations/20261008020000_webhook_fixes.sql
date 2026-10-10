-- Webhook and booking fixes found while verifying 20261005000000 (audit M4, H11).
--
-- 1. An unrelated Calendly appointment could take over a booking that was already
--    scheduled. A create that is not a reschedule fell back to "the contact's most recent
--    paid OR booked booking", so a person who booked a second, unrelated Calendly slot
--    re-pointed their existing booking at it and retired the real appointment's invitee
--    (whose later cancellation was then ignored). Now only an explicit reschedule (the
--    old invitee) can move a booked booking; the tracking id and the email fallback match
--    only a booking still waiting to be scheduled ('paid'). A create for an invitee a
--    booking already holds is recognised as a duplicate up front.
--
-- 2. A parked reschedule cancellation lost its meaning. booking_reconciliation did not
--    keep the `rescheduled` flag, and the scheduled retry replays parked events as plain
--    cancellations, so a reschedule whose events all arrived before the payment was
--    recorded could end with the booking cancelled. The flag is now stored with the
--    parked event (the retry must pass it back: src/lib/jobs/runJobs.ts).
--
-- 3. A parked event that a later retry finds superseded or duplicated was never marked
--    resolved, so it was retried for a week and then shown to a person for nothing. Any
--    settled outcome now resolves the parked row.

alter table public.booking_reconciliation
    add column if not exists rescheduled boolean not null default false;

comment on column public.booking_reconciliation.rescheduled is
  'Calendly said this cancellation is the old slot of a reschedule. Replayed as such.';

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

  elsif exists (select 1 from public.bookings where calendly_invitee_uri = p_invitee_uri) then
    -- A create for an invitee a booking already holds: a duplicate delivery.
    v_outcome := 'ignored';

  else  -- invitee.created
    -- 1. The replacement of a reschedule: the booking that holds (or held) the old
    --    invitee. The only way an already scheduled booking can move.
    if p_old_invitee_uri is not null then
      select * into v_booking from public.bookings
       where calendly_invitee_uri = p_old_invitee_uri
          or p_old_invitee_uri = any (calendly_superseded_invitees)
       for update;
    end if;

    -- 2. The tracking id Calendly echoed back, trusted only when the invitee's email is
    --    the booking contact's (it travels through a URL anyone can edit), and only for a
    --    booking still waiting to be scheduled.
    if v_booking.id is null and p_tracking_booking is not null then
      select b.* into v_booking
        from public.bookings b
        join public.contacts c on c.id = b.contact_id
       where b.id = p_tracking_booking
         and b.status = 'paid'
         and lower(btrim(c.email)) = v_email
       for update of b;
    end if;

    -- 3. The contact's most recent booking waiting to be scheduled, by email. A booked
    --    booking is never taken over by an appointment that does not name it.
    if v_booking.id is null and v_email <> '' then
      select b.* into v_booking
        from public.bookings b
        join public.contacts c on c.id = b.contact_id
       where lower(btrim(c.email)) = v_email
         and c.deleted_at is null
         and b.status = 'paid'
       order by b.created_at desc
       limit 1
       for update of b;
    end if;

    if v_booking.id is null then
      v_outcome := 'unmatched';
      v_reason := 'no paid booking for this invitee';
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
      (event_type, invitee_uri, event_uri, email, scheduled_at, tracking_booking_id, old_invitee_uri, rescheduled, reason)
    values
      (p_event, p_invitee_uri, p_event_uri, nullif(v_email, ''), p_scheduled_at, p_tracking_booking, p_old_invitee_uri,
       coalesce(p_rescheduled, false), v_reason)
    on conflict (provider, event_type, invitee_uri)
    do update set attempts = public.booking_reconciliation.attempts + 1,
                  reason = excluded.reason,
                  rescheduled = public.booking_reconciliation.rescheduled or excluded.rescheduled;
  else
    -- Applied, or settled as nothing to do: a parked copy of this event is finished.
    update public.booking_reconciliation
       set resolved_at = now(), resolution = v_outcome
     where invitee_uri = p_invitee_uri and event_type = p_event and resolved_at is null;
  end if;

  if p_event_id is not null then
    perform public.complete_webhook_event(p_provider, p_event_id, p_event_token, 'completed', null);
  end if;

  return v_outcome;
end;
$$;

revoke all on function public.apply_calendly_event(text, text, text, timestamptz, text, uuid, boolean, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.apply_calendly_event(text, text, text, timestamptz, text, uuid, boolean, text, text, text, uuid)
  to service_role;
