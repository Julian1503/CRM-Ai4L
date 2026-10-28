-- Verification for 20261029000000_campaign_booking_funnel.sql (campaign results).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__funnel`.
--
-- Run with:  npm run db:verify -- funnel
--
-- What this guards: a pending booking (minted at send time) is not a started booking; a
-- contact with several bookings is counted once; each contact counts at the furthest
-- stage reached; a cancel followed by a rebook is
-- booked, not cancelled; paying then cancelling still counts as paid; a campaign
-- with no bookings still answers with zeros; a non-member sees nothing.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000f0a01', 'member__funnel@example.invalid'),
  ('00000000-0000-4000-8000-0000000f0a02', 'outsider__funnel@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000f0a01', 'operator', true);

insert into public.campaigns (id, name, provider_automation_id, consent_stream, merge_fields) values
  ('00000000-0000-4000-8000-0000000f0c01', 'Funnel __funnel', 'auto-funnel', 'newsletter', '{"Headline":"Hi"}'),
  ('00000000-0000-4000-8000-0000000f0c02', 'Quiet __funnel', 'auto-funnel', 'newsletter', '{"Headline":"Hi"}');

insert into public.contacts (id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-0000000f0d01', 'Clicker', 'Funnel', 'clicker__funnel@example.invalid'),
  ('00000000-0000-4000-8000-0000000f0d02', 'Payer', 'Funnel', 'payer__funnel@example.invalid'),
  ('00000000-0000-4000-8000-0000000f0d03', 'Booker', 'Funnel', 'booker__funnel@example.invalid'),
  ('00000000-0000-4000-8000-0000000f0d04', 'Canceller', 'Funnel', 'canceller__funnel@example.invalid'),
  ('00000000-0000-4000-8000-0000000f0d05', 'Rebooker', 'Funnel', 'rebooker__funnel@example.invalid'),
  ('00000000-0000-4000-8000-0000000f0d06', 'Silent', 'Funnel', 'silent__funnel@example.invalid');

-- Statuses are fixtures of journeys that already happened, so the booking state machine
-- is bypassed while they are written.
set local session_replication_role = replica;
insert into public.bookings (token_hash, contact_id, campaign_id, status, expires_at, list_amount_cents, charged_amount_cents, consumed_at) values
  -- The silent contact was emailed (twice) and never opened the link.
  ('s1__funnel', '00000000-0000-4000-8000-0000000f0d06', '00000000-0000-4000-8000-0000000f0c01', 'pending', now() + interval '30 days', 50000, null, null),
  ('s2__funnel', '00000000-0000-4000-8000-0000000f0d06', '00000000-0000-4000-8000-0000000f0c01', 'expired', now() + interval '30 days', 50000, null, null),
  -- The clicker started checkout, abandoned it, and has an unopened link from a re-send.
  ('c1__funnel', '00000000-0000-4000-8000-0000000f0d01', '00000000-0000-4000-8000-0000000f0c01', 'checkout_started', now() + interval '30 days', 50000, null, now()),
  ('c2__funnel', '00000000-0000-4000-8000-0000000f0d01', '00000000-0000-4000-8000-0000000f0c01', 'pending', now() + interval '30 days', 50000, null, null),
  ('p1__funnel', '00000000-0000-4000-8000-0000000f0d02', '00000000-0000-4000-8000-0000000f0c01', 'paid', now() + interval '30 days', 50000, 2500, now()),
  ('b1__funnel', '00000000-0000-4000-8000-0000000f0d03', '00000000-0000-4000-8000-0000000f0c01', 'booked', now() + interval '30 days', 50000, 0, now()),
  ('b2__funnel', '00000000-0000-4000-8000-0000000f0d03', '00000000-0000-4000-8000-0000000f0c01', 'pending', now() + interval '30 days', 50000, null, null),
  ('x1__funnel', '00000000-0000-4000-8000-0000000f0d04', '00000000-0000-4000-8000-0000000f0c01', 'cancelled', now() + interval '30 days', 50000, 0, now()),
  ('r1__funnel', '00000000-0000-4000-8000-0000000f0d05', '00000000-0000-4000-8000-0000000f0c01', 'cancelled', now() + interval '30 days', 50000, 0, now()),
  ('r2__funnel', '00000000-0000-4000-8000-0000000f0d05', '00000000-0000-4000-8000-0000000f0c01', 'booked', now() + interval '30 days', 50000, 1000, now());
set local session_replication_role = origin;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f0a01","role":"authenticated"}', true);

do $$
declare
  v_row record;
  v_count integer;
begin
  raise notice '1. one row per campaign asked for, contacts counted once at their furthest stage';
  select * into v_row from public.campaign_booking_funnel(
    array['00000000-0000-4000-8000-0000000f0c01', '00000000-0000-4000-8000-0000000f0c02']::uuid[])
  where campaign_id = '00000000-0000-4000-8000-0000000f0c01';
  assert v_row.started = 5, format('expected 5 who started booking (not the silent one), got %s', v_row.started);
  assert v_row.paid = 4, format('expected 4 paid (payer, booker, canceller, rebooker), got %s', v_row.paid);
  assert v_row.booked = 2, format('expected 2 booked (booker, rebooker), got %s', v_row.booked);
  assert v_row.cancelled = 1, format('a cancel followed by a rebook is not a cancellation; got %s', v_row.cancelled);
  assert v_row.charged_cents = 3500, format('expected what checkout took, 3500; got %s', v_row.charged_cents);
  assert v_row.last_booking_at is not null, 'the latest booking activity is missing';

  raise notice '2. a campaign with no bookings answers with zeros, not with no row';
  select * into v_row from public.campaign_booking_funnel(array['00000000-0000-4000-8000-0000000f0c02']::uuid[]);
  assert v_row.campaign_id = '00000000-0000-4000-8000-0000000f0c02', 'the quiet campaign has no row';
  assert v_row.started = 0 and v_row.paid = 0 and v_row.booked = 0 and v_row.charged_cents = 0,
    format('expected zeros, got %s', row_to_json(v_row));
end $$;

-- 3. a signed-in non-member sees nothing
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f0a02","role":"authenticated"}', true);

do $$
begin
  assert (select count(*) from public.campaign_booking_funnel(
           array['00000000-0000-4000-8000-0000000f0c01']::uuid[])) = 0,
    'a non-member can read campaign results';
end $$;

rollback;
