-- Campaign results: how far each campaign's recipients got after the email.
--
-- The send ledger (campaign_send_summaries) says who was emailed. This says what they
-- did with it, from the booking each recipient's link carries: who started booking
-- (opened checkout from the link), who paid (or claimed the consultation at $0), who has
-- a time in the calendar and who cancelled. One aggregate for a page of campaigns, like
-- the send summaries, so the results list costs one call rather than one per row — and
-- never a raw read of the bookings table, which PostgREST would silently cap at 1000 rows.
--
-- A booking row is minted for every recipient at send time, as 'pending' — so a pending
-- row means "emailed", not "clicked". Starting checkout consumes the link
-- (consumed_at) and moves it on; only that counts as starting a booking. An expired
-- row says nothing either way: the link may never have been opened.
--
-- Counted per contact, not per booking: a campaign sent again mints a second row for
-- the same person. A contact is counted once, at the furthest stage any of their
-- bookings for the campaign reached — across every send of it, which the screen says.
--
-- Read-only and security invoker: the caller's RLS on bookings and campaigns applies,
-- including the restrictive "approved CRM members only" policy.

create or replace function public.campaign_booking_funnel(p_campaign_ids uuid[])
returns table (
  campaign_id     uuid,
  started         integer,
  paid            integer,
  booked          integer,
  cancelled       integer,
  charged_cents   bigint,
  last_booking_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with per_contact as (
    select
      b.campaign_id,
      b.contact_id,
      bool_or(b.consumed_at is not null or b.status in ('checkout_started', 'paid', 'booked', 'cancelled')) as has_started,
      -- Paying is a fact a later cancellation does not undo: a cancelled booking that
      -- went through checkout (charged_amount_cents is set on payment) still paid.
      bool_or(b.status in ('paid', 'booked') or (b.status = 'cancelled' and b.charged_amount_cents is not null)) as has_paid,
      bool_or(b.status = 'booked') as has_booked,
      -- Cancelled only if nothing they hold is still live: a contact who cancelled
      -- and rebooked is booked, not cancelled.
      bool_or(b.status = 'cancelled') and not bool_or(b.status in ('paid', 'booked')) as only_cancelled,
      -- What was taken at checkout. Refunds happen in Stripe and are not recorded here.
      coalesce(sum(b.charged_amount_cents) filter (where b.status in ('paid', 'booked', 'cancelled')), 0) as charged,
      max(b.updated_at) as last_at
    from public.bookings b
    where b.campaign_id = any (p_campaign_ids)
      and b.contact_id is not null
    group by b.campaign_id, b.contact_id
  )
  select
    c.id,
    count(pc.contact_id) filter (where pc.has_started)::integer,
    count(pc.contact_id) filter (where pc.has_paid)::integer,
    count(pc.contact_id) filter (where pc.has_booked)::integer,
    count(pc.contact_id) filter (where pc.only_cancelled)::integer,
    coalesce(sum(pc.charged), 0)::bigint,
    max(pc.last_at)
  from public.campaigns c
  left join per_contact pc on pc.campaign_id = c.id
  where c.id = any (p_campaign_ids)
    and cardinality(p_campaign_ids) <= 200
  group by c.id;
$$;

revoke all on function public.campaign_booking_funnel(uuid[]) from public, anon;
grant execute on function public.campaign_booking_funnel(uuid[]) to authenticated, service_role;
