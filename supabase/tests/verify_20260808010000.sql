-- Verification for migration 20260808010000_bookings.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end, so it is safe against any environment that already has the migration
-- applied. Every fixture carries the suffix `__p5verify`.
--
-- Run with:
--   npm run db:verify:bookings
--   npx supabase db query --linked --file supabase/tests/verify_20260808010000.sql
-- Or paste into the Supabase SQL editor.
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- A booking row is created by the send pipeline and then advanced by two independent
-- webhooks (Stripe, Calendly). Both can arrive out of order and more than once, so the
-- partial unique indexes below are not tidiness -- they are what stops a replayed
-- checkout.session.completed from attaching to a second booking and handing out a
-- second free consultation.

begin;

do $$
declare
  v_failed      boolean;
  v_count       int;
  v_contact_id  uuid;
  v_campaign_id uuid;
  v_booking_id  uuid;
begin
  ----------------------------------------------------------------------------
  raise notice '1. schema objects exist';
  ----------------------------------------------------------------------------
  assert (select count(*) from pg_class where relname='bookings' and relkind='r') = 1,
         'bookings table missing';

  assert (select count(*) from pg_type where typname='booking_status') = 1,
         'enum booking_status missing';

  assert (select count(*) from pg_enum e join pg_type t on t.oid=e.enumtypid
          where t.typname='booking_status') = 6,
         'booking_status should have exactly six labels';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='bookings_token_hash_idx') = 1,
         'bookings_token_hash_idx missing';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='bookings_stripe_session_idx') = 1,
         'bookings_stripe_session_idx missing - a replayed Stripe event can attach twice';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='bookings_calendly_invitee_idx') = 1,
         'bookings_calendly_invitee_idx missing';

  ----------------------------------------------------------------------------
  raise notice '2. expires_at is mandatory';
  ----------------------------------------------------------------------------
  -- A booking link with no expiry is a permanent free consultation.
  assert (select is_nullable = 'NO' from information_schema.columns
          where table_schema='public' and table_name='bookings' and column_name='expires_at'),
         'bookings.expires_at should be NOT NULL';

  ----------------------------------------------------------------------------
  raise notice '3. a minted link gets the documented defaults';
  ----------------------------------------------------------------------------
  insert into public.contacts (first_name, last_name, email)
  values ('Booking', 'Target', 'booking__p5verify@example.com')
  returning id into v_contact_id;

  insert into public.campaigns (name) values ('Booking campaign __p5verify')
  returning id into v_campaign_id;

  insert into public.bookings (token_hash, contact_id, campaign_id, expires_at)
  values ('hash-a__p5verify', v_contact_id, v_campaign_id, now() + interval '30 days')
  returning id into v_booking_id;

  assert (select status = 'pending' from public.bookings where id = v_booking_id),
         'a new booking should start as pending';

  -- The "$500 value, $0 charged" position is evidenced per booking rather than
  -- inferred from whatever Stripe happens to be configured with later.
  assert (select list_amount_cents = 50000 and currency = 'AUD'
          from public.bookings where id = v_booking_id),
         'list_amount_cents / currency defaults do not match the documented offer';

  assert (select consumed_at is null from public.bookings where id = v_booking_id),
         'a freshly minted booking must not be marked consumed';

  ----------------------------------------------------------------------------
  raise notice '4. one token maps to one booking';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    insert into public.bookings (token_hash, contact_id, expires_at)
    values ('hash-a__p5verify', v_contact_id, now() + interval '30 days');
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed, 'two bookings shared a token hash';

  ----------------------------------------------------------------------------
  raise notice '5. many bookings may sit with no Stripe session yet';
  ----------------------------------------------------------------------------
  -- The index is partial. If it were not, a campaign could mint exactly one booking
  -- and every later recipient would collide on null.
  insert into public.bookings (token_hash, contact_id, expires_at)
  values ('hash-b__p5verify', v_contact_id, now() + interval '30 days');

  select count(*) into v_count from public.bookings
  where contact_id = v_contact_id and stripe_session_id is null;
  assert v_count = 2,
    format('expected two bookings with no Stripe session, found %s - the index is not partial', v_count);

  ----------------------------------------------------------------------------
  raise notice '6. a replayed Stripe session cannot attach to a second booking';
  ----------------------------------------------------------------------------
  update public.bookings
     set stripe_session_id = 'cs_test__p5verify', status = 'paid', charged_amount_cents = 0
   where token_hash = 'hash-a__p5verify';

  v_failed := false;
  begin
    update public.bookings
       set stripe_session_id = 'cs_test__p5verify'
     where token_hash = 'hash-b__p5verify';
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed,
    'one Stripe session was attached to two bookings - a replayed webhook grants a second consultation';

  ----------------------------------------------------------------------------
  raise notice '7. a replayed Calendly invitee cannot attach to a second booking';
  ----------------------------------------------------------------------------
  update public.bookings
     set calendly_invitee_uri = 'https://api.calendly.com/invitees/p5verify',
         status = 'booked', scheduled_at = now()
   where token_hash = 'hash-a__p5verify';

  v_failed := false;
  begin
    update public.bookings
       set calendly_invitee_uri = 'https://api.calendly.com/invitees/p5verify'
     where token_hash = 'hash-b__p5verify';
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed, 'one Calendly invitee was attached to two bookings';

  ----------------------------------------------------------------------------
  raise notice '8. every documented status is reachable';
  ----------------------------------------------------------------------------
  -- The follow-up 20260825010000 migration adds a transition trigger. Exercise each
  -- terminal state through a path the production handlers are allowed to take.
  update public.bookings set status = 'checkout_started' where token_hash = 'hash-b__p5verify';
  update public.bookings set status = 'cancelled', cancelled_at = now() where token_hash = 'hash-b__p5verify';

  insert into public.bookings (token_hash, contact_id, expires_at)
  values ('hash-expired__p5verify', v_contact_id, now() + interval '30 days');
  update public.bookings set status = 'expired' where token_hash = 'hash-expired__p5verify';

  assert (select status = 'cancelled' from public.bookings where token_hash = 'hash-b__p5verify'),
         'checkout_started should be able to reach cancelled';
  assert (select status = 'expired' from public.bookings where token_hash = 'hash-expired__p5verify'),
         'booking_status does not carry the documented values';

  v_failed := false;
  begin
    update public.bookings set status = 'expired' where token_hash = 'hash-b__p5verify';
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'cancelled -> expired should be rejected by the status transition trigger';

  ----------------------------------------------------------------------------
  raise notice '9. a cancelled campaign does not delete its bookings';
  ----------------------------------------------------------------------------
  -- on delete set null. The consultation still happened; only its attribution is lost.
  delete from public.campaigns where id = v_campaign_id;
  assert (select count(*) from public.bookings where token_hash = 'hash-a__p5verify') = 1,
         'deleting a campaign destroyed a booking that had already been paid for';
  assert (select campaign_id is null from public.bookings where token_hash = 'hash-a__p5verify'),
         'campaign_id should be set null, not left dangling';

  ----------------------------------------------------------------------------
  raise notice '10. deleting a contact removes their bookings';
  ----------------------------------------------------------------------------
  -- on delete cascade. A booking with no contact cannot be honoured or contacted.
  delete from public.contacts where id = v_contact_id;
  assert (select count(*) from public.bookings where contact_id = v_contact_id) = 0,
         'bookings survived the deletion of their contact';

  ----------------------------------------------------------------------------
  raise notice '11. RLS is enabled; bookings are readable and updatable, never inserted by hand';
  ----------------------------------------------------------------------------
  assert (select relrowsecurity from pg_class where relname='bookings'),
         'RLS is not enabled on bookings';

  assert (select count(*) from pg_policies
          where schemaname='public' and tablename='bookings' and cmd='SELECT') = 1,
         'bookings should be readable by authenticated users';

  assert (select count(*) from pg_policies
          where schemaname='public' and tablename='bookings' and cmd='UPDATE') = 1,
         'bookings should be updatable by authenticated users';

  -- Bookings are minted by the send pipeline through the service-role client. An
  -- insert policy would let a signed-in user mint a free consultation for anyone.
  select count(*) into v_count from pg_policies
  where schemaname='public' and tablename='bookings' and cmd in ('INSERT','DELETE');
  assert v_count = 0,
    format('bookings must not be insertable or deletable by authenticated users, found %s policies', v_count);

  raise notice '';
  raise notice 'ALL PHASE 5 (bookings) CHECKS PASSED';
end $$;

rollback;
