-- Verification for 20261005000000_durable_webhooks_and_bookings.sql and
-- 20261008020000_webhook_fixes.sql (audit H10, H11, M4).
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end. Every fixture carries the suffix `__webhookverify`.
--
-- Run with:
--   npm run db:verify -- webhooks
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- now() is fixed for the whole transaction, so an "expired lease" is written explicitly
-- as a lease in the past. Separate-connection cases (a process killed after its claim,
-- two deliveries at once) live in src/lib/webhooks/webhooks.integration.test.ts.

begin;

-- ---------------------------------------------------------------------------
-- 1. Privileges: the worker functions are the service role's alone
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig text;
begin
  raise notice '1. privileges';
  foreach v_sig in array array[
    'public.claim_webhook_event(text, text, text, integer)',
    'public.complete_webhook_event(text, text, uuid, text, text)',
    'public.claim_notifications(integer, integer)',
    'public.complete_notification(uuid, uuid, text, text)',
    'public.apply_checkout_payment(uuid, text, integer, text, text, text, uuid)',
    'public.apply_calendly_event(text, text, text, timestamptz, text, uuid, boolean, text, text, text, uuid)'
  ] loop
    assert not has_function_privilege('anon', v_sig, 'execute'), format('anon can execute %s', v_sig);
    assert not has_function_privilege('authenticated', v_sig, 'execute'), format('authenticated can execute %s', v_sig);
    assert has_function_privilege('service_role', v_sig, 'execute'), format('service_role cannot execute %s', v_sig);
  end loop;

  assert not has_table_privilege('anon', 'public.webhook_events', 'select'), 'anon can read webhook_events';
  assert not has_table_privilege('anon', 'public.notification_outbox', 'select'), 'anon can read notification_outbox';
  assert not has_table_privilege('anon', 'public.booking_reconciliation', 'select'), 'anon can read booking_reconciliation';

  assert exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'notification_outbox'
       and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'
  ), 'notification_outbox lacks the membership policy';
  assert exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'booking_reconciliation'
       and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'
  ), 'booking_reconciliation lacks the membership policy';
  -- Members may read (diagnosis) but no policy lets them write.
  assert not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('webhook_events', 'notification_outbox', 'booking_reconciliation')
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and permissive = 'PERMISSIVE'
  ), 'a browser role has a write policy on a webhook table';
end $$;

-- A member reads the ledger but cannot claim, complete or write it.
insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000ee01', 'member__webhookverify@example.invalid');
insert into public.crm_members (user_id, role, active) values ('00000000-0000-4000-8000-00000000ee01', 'operator', true);
insert into public.webhook_events (provider, event_id, event_type, status, completed_at)
  values ('stripe', 'evt_member__webhookverify', 'x', 'completed', now());

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000ee01","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_failed boolean := false;
begin
  assert exists (select 1 from public.webhook_events where event_id = 'evt_member__webhookverify'),
         'a member cannot read the ledger';

  begin
    perform public.claim_webhook_event('stripe', 'evt_forged__webhookverify', 'x', 120);
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'a member claimed a webhook event';

  v_failed := false;
  begin
    insert into public.webhook_events (provider, event_id) values ('stripe', 'evt_insert__webhookverify');
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'a member wrote the ledger';

  update public.webhook_events set status = 'processing' where event_id = 'evt_member__webhookverify';
  assert not found, 'a member changed a ledger row';

  v_failed := false;
  begin
    perform public.apply_checkout_payment(gen_random_uuid(), 'cs', 0, 'aud', null, null, null);
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'a member applied a payment';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 2. Ledger outcomes and leases (H11)
-- ---------------------------------------------------------------------------
do $$
declare
  v_claim  record;
  v_token  uuid;
  v_row    public.webhook_events;
  v_failed boolean := false;
begin
  raise notice '2. claim / complete / lease';

  select * into v_claim from public.claim_webhook_event('stripe', 'evt_a__webhookverify', 'checkout.session.completed', 120);
  assert v_claim.outcome = 'claimed' and v_claim.claim_token is not null, 'a new event was not claimed';
  v_token := v_claim.claim_token;
  select * into v_row from public.webhook_events where provider = 'stripe' and event_id = 'evt_a__webhookverify';
  assert v_row.status = 'processing' and v_row.attempts = 1 and not v_row.legacy, 'claim did not record processing';

  -- A second delivery while the first holds a live lease: retryable, not a duplicate.
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_a__webhookverify', 'checkout.session.completed', 120);
  assert v_claim.outcome = 'in_progress' and v_claim.claim_token is null, 'a live lease was not respected';

  -- A stale or forged token cannot settle it.
  assert not public.complete_webhook_event('stripe', 'evt_a__webhookverify', gen_random_uuid(), 'completed', null),
         'a foreign token completed the event';

  -- A retryable failure is taken over by the next delivery.
  assert public.complete_webhook_event('stripe', 'evt_a__webhookverify', v_token, 'failed_retryable', repeat('x', 900)),
         'the owner could not record a retryable failure';
  select * into v_row from public.webhook_events where event_id = 'evt_a__webhookverify';
  assert v_row.status = 'failed_retryable' and char_length(v_row.last_error) = 500 and v_row.claim_token is null,
         'retryable failure not recorded (or error not truncated)';
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_a__webhookverify', 'checkout.session.completed', 120);
  assert v_claim.outcome = 'claimed', 'a retryable failure was not taken over';
  assert (select attempts from public.webhook_events where event_id = 'evt_a__webhookverify') = 2, 'attempts not counted';

  -- The worker died: its lease expires and the redelivery takes over; the dead worker's
  -- token is then worthless.
  v_token := v_claim.claim_token;
  update public.webhook_events set lease_expires_at = now() - interval '1 second' where event_id = 'evt_a__webhookverify';
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_a__webhookverify', 'checkout.session.completed', 120);
  assert v_claim.outcome = 'claimed' and v_claim.claim_token <> v_token, 'an expired lease was not reclaimed';
  assert not public.complete_webhook_event('stripe', 'evt_a__webhookverify', v_token, 'completed', null),
         'the dead worker completed the event after losing its lease';
  assert public.complete_webhook_event('stripe', 'evt_a__webhookverify', v_claim.claim_token, 'completed', null),
         'the new owner could not complete the event';
  select * into v_row from public.webhook_events where event_id = 'evt_a__webhookverify';
  assert v_row.status = 'completed' and v_row.completed_at is not null and v_row.attempts = 3, 'completion not recorded';

  -- Completed (and terminally refused) events are acknowledged as duplicates.
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_a__webhookverify', 'checkout.session.completed', 120);
  assert v_claim.outcome = 'completed', 'a completed event was not acknowledged';
  select * into v_claim from public.claim_webhook_event('calendly', 'evt_t__webhookverify', 'invitee.created', 120);
  perform public.complete_webhook_event('calendly', 'evt_t__webhookverify', v_claim.claim_token, 'failed_terminal', 'bad');
  select * into v_claim from public.claim_webhook_event('calendly', 'evt_t__webhookverify', 'invitee.created', 120);
  assert v_claim.outcome = 'completed', 'a terminal failure was retried';

  -- The same event id from another provider is a different event.
  select * into v_claim from public.claim_webhook_event('calendly', 'evt_a__webhookverify', 'invitee.created', 120);
  assert v_claim.outcome = 'claimed', 'event ids are not scoped by provider';

  begin
    perform public.complete_webhook_event('calendly', 'evt_a__webhookverify', v_claim.claim_token, 'done', null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'an unknown outcome was accepted';

  -- Legacy rows (claimed before outcomes existed) are acknowledged, never reprocessed;
  -- docs/WEBHOOKS.md explains how to reconcile them by hand.
  insert into public.webhook_events (provider, event_id, event_type, status, legacy, completed_at)
    values ('stripe', 'evt_legacy__webhookverify', 'checkout.session.completed', 'completed', true, now());
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_legacy__webhookverify', 'checkout.session.completed', 120);
  assert v_claim.outcome = 'completed', 'a legacy row was reprocessed';
  assert not exists (select 1 from public.webhook_events where legacy and completed_at is null),
         'a legacy row has no completion time';
end $$;

-- ---------------------------------------------------------------------------
-- 3. Payment applied once, whatever the order (H10)
-- ---------------------------------------------------------------------------
do $$
declare
  v_contact uuid;
  v_b1 uuid; v_b2 uuid; v_b3 uuid; v_b4 uuid;
  v_claim record;
  v_outcome text;
begin
  raise notice '3. payment';
  insert into public.contacts (first_name, last_name, email) values ('Pay', 'Verify', 'pay__webhookverify@example.invalid') returning id into v_contact;
  insert into public.bookings (token_hash, contact_id, status, expires_at, stripe_session_id)
    values (repeat('a', 64), v_contact, 'checkout_started', now() + interval '1 day', 'cs_1__webhookverify') returning id into v_b1;
  insert into public.bookings (token_hash, contact_id, status, expires_at, stripe_session_id)
    values (repeat('b', 64), v_contact, 'checkout_started', now() + interval '1 day', 'cs_2__webhookverify') returning id into v_b2;
  insert into public.bookings (token_hash, contact_id, status, expires_at)
    values (repeat('c', 64), v_contact, 'pending', now() + interval '1 day') returning id into v_b3;
  insert into public.bookings (token_hash, contact_id, status, expires_at, stripe_session_id)
    values (repeat('d', 64), v_contact, 'checkout_started', now() + interval '1 day', 'cs_4__webhookverify') returning id into v_b4;

  -- Browser first, then the webhook, then the webhook again.
  assert public.apply_checkout_payment(v_b1, 'cs_1__webhookverify', 0, 'aud') = 'applied', 'browser-first not applied';
  assert (select status from public.bookings where id = v_b1) = 'paid', 'booking not paid';
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_p1__webhookverify', 'checkout.session.completed', 120);
  v_outcome := public.apply_checkout_payment(v_b1, 'cs_1__webhookverify', 0, 'AUD', 'stripe', 'evt_p1__webhookverify', v_claim.claim_token);
  assert v_outcome = 'already_applied', 'the webhook after the browser was not idempotent';
  assert (select status from public.webhook_events where event_id = 'evt_p1__webhookverify') = 'completed',
         'the event was not completed with the payment';
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_p1__webhookverify', 'checkout.session.completed', 120);
  assert v_claim.outcome = 'completed', 'a duplicate webhook was reprocessed';
  assert (select count(*) from public.notification_outbox where booking_id = v_b1) = 1, 'browser-first queued the email twice';

  -- Webhook first, then the browser.
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_p2__webhookverify', 'checkout.session.completed', 120);
  assert public.apply_checkout_payment(v_b2, 'cs_2__webhookverify', 0, 'aud', 'stripe', 'evt_p2__webhookverify', v_claim.claim_token) = 'applied',
         'webhook-first not applied';
  assert public.apply_checkout_payment(v_b2, 'cs_2__webhookverify', 0, 'aud') = 'already_applied', 'the browser after the webhook was not idempotent';
  assert (select count(*) from public.notification_outbox where booking_id = v_b2) = 1, 'webhook-first queued the email twice';
  assert (select dedupe_key from public.notification_outbox where booking_id = v_b2) = 'booking-paid:' || v_b2, 'unexpected email identity';

  -- A different checkout, a charge, or another currency can never mark it paid.
  assert public.apply_checkout_payment(v_b4, 'cs_other__webhookverify', 0, 'aud') = 'mismatch', 'a different checkout was accepted';
  assert public.apply_checkout_payment(v_b4, 'cs_4__webhookverify', 50000, 'aud') = 'mismatch', 'a charged checkout was accepted';
  assert public.apply_checkout_payment(v_b4, 'cs_4__webhookverify', 0, 'usd') = 'mismatch', 'another currency was accepted';
  assert public.apply_checkout_payment(v_b4, 'cs_4__webhookverify', null, 'aud') = 'mismatch', 'a missing amount was accepted';
  assert (select status from public.bookings where id = v_b4) = 'checkout_started', 'a refused checkout moved the booking';
  assert not exists (select 1 from public.notification_outbox where booking_id = v_b4), 'a refused checkout queued an email';
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_p4__webhookverify', 'checkout.session.completed', 120);
  perform public.apply_checkout_payment(v_b4, 'cs_other__webhookverify', 0, 'aud', 'stripe', 'evt_p4__webhookverify', v_claim.claim_token);
  assert (select status from public.webhook_events where event_id = 'evt_p4__webhookverify') = 'failed_terminal',
         'a mismatched checkout was left retryable';

  -- The webhook beat the booking's own record of its checkout: retry, never refuse.
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_p3__webhookverify', 'checkout.session.completed', 120);
  assert public.apply_checkout_payment(v_b3, 'cs_3__webhookverify', 0, 'aud', 'stripe', 'evt_p3__webhookverify', v_claim.claim_token) = 'not_ready',
         'a booking without its checkout was not reported not_ready';
  assert (select status from public.webhook_events where event_id = 'evt_p3__webhookverify') = 'failed_retryable',
         'not_ready did not leave the event retryable';
  update public.bookings set status = 'checkout_started', stripe_session_id = 'cs_3__webhookverify' where id = v_b3;
  select * into v_claim from public.claim_webhook_event('stripe', 'evt_p3__webhookverify', 'checkout.session.completed', 120);
  assert v_claim.outcome = 'claimed', 'the retry was not taken over';
  assert public.apply_checkout_payment(v_b3, 'cs_3__webhookverify', 0, 'aud', 'stripe', 'evt_p3__webhookverify', v_claim.claim_token) = 'applied',
         'the delayed delivery did not converge';

  -- Never backwards: a booked booking stays booked when the checkout is reported again.
  update public.bookings set status = 'booked' where id = v_b1;
  assert public.apply_checkout_payment(v_b1, 'cs_1__webhookverify', 0, 'aud') = 'already_applied', 'a booked booking was re-applied';
  assert (select status from public.bookings where id = v_b1) = 'booked', 'a booked booking moved backwards';

  assert public.apply_checkout_payment(gen_random_uuid(), 'cs_x', 0, 'aud') = 'not_found', 'an unknown booking was not reported';
end $$;

-- ---------------------------------------------------------------------------
-- 4. Notification outbox: claim, settle, back off (H10)
-- ---------------------------------------------------------------------------
do $$
declare
  v_contact uuid;
  v_booking uuid;
  v_id      uuid;
  v_note    public.notification_outbox;
  v_failed  boolean := false;
begin
  raise notice '4. notification outbox';
  insert into public.contacts (first_name, last_name, email) values ('Note', 'Verify', 'note__webhookverify@example.invalid') returning id into v_contact;
  insert into public.bookings (token_hash, contact_id, status, expires_at, stripe_session_id)
    values (repeat('e', 64), v_contact, 'paid', now() + interval '1 day', 'cs_n__webhookverify') returning id into v_booking;
  insert into public.notification_outbox (kind, dedupe_key, booking_id, stripe_session_id, next_attempt_at)
    values ('booking_paid_confirmation', 'booking-paid:' || v_booking, v_booking, 'cs_n__webhookverify', now() - interval '1 hour')
    returning id into v_id;

  select * into v_note from public.claim_notifications(100) where id = v_id;
  assert v_note.status = 'processing' and v_note.claim_token is not null and v_note.attempts = 1, 'the notification was not claimed';
  assert not exists (select 1 from public.claim_notifications(100) where id = v_id), 'a leased notification was claimed twice';

  assert not public.complete_notification(v_id, gen_random_uuid(), 'sent'), 'a foreign token settled a notification';
  begin
    perform public.complete_notification(v_id, v_note.claim_token, 'delivered');
  exception when others then v_failed := true;
  end;
  assert v_failed, 'an unknown notification outcome was accepted';

  -- A failed send is retried later, independently of the payment.
  assert public.complete_notification(v_id, v_note.claim_token, 'retry', 'Resend 500'), 'the owner could not ask for a retry';
  select * into v_note from public.notification_outbox where id = v_id;
  assert v_note.status = 'pending' and v_note.next_attempt_at > now() and v_note.last_error = 'Resend 500', 'retry not scheduled with backoff';
  assert not exists (select 1 from public.claim_notifications(100) where id = v_id), 'a backed-off notification was claimed early';

  -- An expired lease returns to the queue.
  update public.notification_outbox set next_attempt_at = now() - interval '1 second' where id = v_id;
  select * into v_note from public.claim_notifications(100) where id = v_id;
  update public.notification_outbox set lease_expires_at = now() - interval '1 second' where id = v_id;
  select * into v_note from public.claim_notifications(100) where id = v_id;
  assert v_note.attempts = 3, 'an expired notification lease was not reclaimed';

  -- After eight attempts it stops and is visible as failed.
  update public.notification_outbox set attempts = 8 where id = v_id;
  assert public.complete_notification(v_id, v_note.claim_token, 'retry', 'still failing'), 'retry refused';
  assert (select status from public.notification_outbox where id = v_id) = 'failed', 'a hopeless notification kept retrying';

  -- Sent records when.
  update public.notification_outbox set status = 'pending', attempts = 0, next_attempt_at = now() - interval '1 second' where id = v_id;
  select * into v_note from public.claim_notifications(100) where id = v_id;
  assert public.complete_notification(v_id, v_note.claim_token, 'sent'), 'could not mark sent';
  select * into v_note from public.notification_outbox where id = v_id;
  assert v_note.status = 'sent' and v_note.sent_at is not null and v_note.claim_token is null, 'sent not recorded';
end $$;

-- ---------------------------------------------------------------------------
-- 5. Calendly, in any order (M4)
-- ---------------------------------------------------------------------------
do $$
declare
  c1 uuid; c2 uuid; c5 uuid; c6 uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; b5 uuid; b6 uuid; b7 uuid;
  v_claim record;
  v_parked public.booking_reconciliation;
begin
  raise notice '5. calendly';
  insert into public.contacts (first_name, last_name, email) values ('Cal', 'Verify', 'cal__webhookverify@example.invalid') returning id into c1;
  insert into public.contacts (first_name, last_name, email) values ('Two', 'Verify', 'two__webhookverify@example.invalid') returning id into c2;
  insert into public.contacts (first_name, last_name, email) values ('Five', 'Verify', 'five__webhookverify@example.invalid') returning id into c5;
  insert into public.contacts (first_name, last_name, email) values ('Six', 'Verify', 'six__webhookverify@example.invalid') returning id into c6;
  insert into public.bookings (token_hash, contact_id, status, expires_at) values (repeat('1', 64), c1, 'paid', now() + interval '1 day') returning id into b1;
  insert into public.bookings (token_hash, contact_id, status, expires_at) values (repeat('2', 64), c2, 'paid', now() + interval '1 day') returning id into b2;
  insert into public.bookings (token_hash, contact_id, status, expires_at) values (repeat('3', 64), c1, 'paid', now() + interval '1 day') returning id into b3;
  insert into public.bookings (token_hash, contact_id, status, expires_at) values (repeat('4', 64), c1, 'paid', now() + interval '1 day') returning id into b4;
  insert into public.bookings (token_hash, contact_id, status, expires_at) values (repeat('5', 64), c5, 'paid', now() + interval '1 day') returning id into b5;
  insert into public.bookings (token_hash, contact_id, status, expires_at) values (repeat('6', 64), c6, 'paid', now() + interval '1 day') returning id into b6;

  -- 5a. Create then cancel; the tracking id is honoured when the email matches.
  select * into v_claim from public.claim_webhook_event('calendly', 'evt_c1__webhookverify', 'invitee.created', 120);
  assert public.apply_calendly_event('invitee.created', 'inv1__wv', 'ev1__wv', now() + interval '2 days', 'CAL__webhookverify@example.invalid ',
         b1, false, null, 'calendly', 'evt_c1__webhookverify', v_claim.claim_token) = 'applied', 'create not applied';
  assert (select status = 'booked' and calendly_invitee_uri = 'inv1__wv' and scheduled_at is not null from public.bookings where id = b1),
         'booking not booked';
  assert (select status from public.webhook_events where event_id = 'evt_c1__webhookverify') = 'completed', 'event not completed with the booking';
  assert public.apply_calendly_event('invitee.created', 'inv1__wv', 'ev1__wv', null, 'cal__webhookverify@example.invalid', b1, false, null) = 'ignored',
         'a duplicate create was not ignored';
  assert public.apply_calendly_event('invitee.canceled', 'inv1__wv', null, null, null, null, false, null) = 'applied', 'cancel not applied';
  assert (select status from public.bookings where id = b1) = 'cancelled', 'booking not cancelled';
  assert public.apply_calendly_event('invitee.canceled', 'inv1__wv', null, null, null, null, false, null) = 'ignored', 'a repeated cancel was applied';

  -- 5b. Cancel before create: parked, then the scheduled retry converges.
  assert public.apply_calendly_event('invitee.canceled', 'inv2__wv', null, null, 'two__webhookverify@example.invalid', null, false, null) = 'unmatched',
         'an early cancel was not parked';
  select * into v_parked from public.booking_reconciliation where invitee_uri = 'inv2__wv';
  assert v_parked.event_type = 'invitee.canceled' and v_parked.resolved_at is null and not v_parked.rescheduled, 'parked cancel not recorded';
  assert public.apply_calendly_event('invitee.canceled', 'inv2__wv', null, null, null, null, false, null) = 'unmatched', 'second early cancel';
  assert (select attempts from public.booking_reconciliation where invitee_uri = 'inv2__wv') = 2, 'parking attempts not counted';
  assert public.apply_calendly_event('invitee.created', 'inv2__wv', 'ev2__wv', null, 'two__webhookverify@example.invalid', null, false, null) = 'applied',
         'create after an early cancel not applied';
  assert public.apply_calendly_event('invitee.canceled', 'inv2__wv', null, null, null, null, v_parked.rescheduled, null) = 'applied',
         'the parked cancel did not converge on retry';
  assert (select status from public.bookings where id = b2) = 'cancelled', 'cancel-then-create did not end cancelled';
  assert (select resolution from public.booking_reconciliation where invitee_uri = 'inv2__wv') = 'applied', 'parked cancel not resolved';

  -- 5c. Reschedule, cancel of the old slot first.
  perform public.apply_calendly_event('invitee.created', 'inv3__wv', 'ev3__wv', null, 'cal__webhookverify@example.invalid', b3, false, null);
  assert public.apply_calendly_event('invitee.canceled', 'inv3__wv', null, null, null, null, true, null) = 'applied', 'reschedule cancel not applied';
  assert (select status = 'booked' and 'inv3__wv' = any (calendly_superseded_invitees) from public.bookings where id = b3),
         'a reschedule cancel cancelled the booking';
  assert public.apply_calendly_event('invitee.created', 'inv3b__wv', 'ev3b__wv', null, 'cal__webhookverify@example.invalid', null, false, 'inv3__wv') = 'applied',
         'replacement not applied';
  assert (select status = 'booked' and calendly_invitee_uri = 'inv3b__wv' from public.bookings where id = b3), 'replacement not on the booking';
  -- The old invitee's late events cannot touch the replacement.
  assert public.apply_calendly_event('invitee.canceled', 'inv3__wv', null, null, null, null, false, null) = 'ignored', 'old cancel touched the replacement';
  assert public.apply_calendly_event('invitee.created', 'inv3__wv', null, null, 'cal__webhookverify@example.invalid', b3, false, null) = 'ignored',
         'old create touched the replacement';
  assert (select status = 'booked' and calendly_invitee_uri = 'inv3b__wv' from public.bookings where id = b3), 'replacement lost';
  -- A real cancellation of the replacement still works.
  assert public.apply_calendly_event('invitee.canceled', 'inv3b__wv', null, null, null, null, false, null) = 'applied', 'final cancel not applied';
  assert (select status from public.bookings where id = b3) = 'cancelled', 'final cancel did not cancel';

  -- 5d. Reschedule, replacement before the original's cancel.
  perform public.apply_calendly_event('invitee.created', 'inv4__wv', null, null, 'cal__webhookverify@example.invalid', b4, false, null);
  assert public.apply_calendly_event('invitee.created', 'inv4b__wv', null, null, 'cal__webhookverify@example.invalid', null, false, 'inv4__wv') = 'applied',
         'replacement-first not applied';
  assert public.apply_calendly_event('invitee.canceled', 'inv4__wv', null, null, null, null, true, null) = 'ignored', 'late reschedule cancel not ignored';
  assert (select status = 'booked' and calendly_invitee_uri = 'inv4b__wv' from public.bookings where id = b4), 'replacement-first did not converge';

  -- 5e. An unrelated appointment cannot take over a scheduled booking (20261008020000).
  perform public.apply_calendly_event('invitee.created', 'inv5__wv', null, null, 'five__webhookverify@example.invalid', b5, false, null);
  assert public.apply_calendly_event('invitee.created', 'inv5x__wv', null, null, 'five__webhookverify@example.invalid', null, false, null) = 'unmatched',
         'an unrelated appointment matched a booked booking';
  assert public.apply_calendly_event('invitee.created', 'inv5y__wv', null, null, 'five__webhookverify@example.invalid', b5, false, null) = 'unmatched',
         'a tracked second appointment took over a booked booking';
  assert (select status = 'booked' and calendly_invitee_uri = 'inv5__wv' and not ('inv5__wv' = any (calendly_superseded_invitees))
            from public.bookings where id = b5), 'the scheduled booking was modified by an unrelated appointment';

  -- 5f. A tracking id is not authorisation: another person's email cannot claim it.
  assert public.apply_calendly_event('invitee.created', 'inv6__wv', null, null, 'stranger__webhookverify@example.invalid', b6, false, null) = 'unmatched',
         'a tracking id with a foreign email matched';
  assert (select status from public.bookings where id = b6) = 'paid', 'a stranger moved the booking';

  -- 5g. A parked reschedule cancel keeps its meaning (20261008020000).
  insert into public.bookings (token_hash, contact_id, status, expires_at) values (repeat('7', 64), c2, 'checkout_started', now() + interval '1 day') returning id into b7;
  assert public.apply_calendly_event('invitee.canceled', 'inv7__wv', null, null, null, null, true, null) = 'unmatched', 'early reschedule cancel not parked';
  assert (select rescheduled from public.booking_reconciliation where invitee_uri = 'inv7__wv'), 'the parked cancel lost its reschedule flag';

  -- 5h. A parked event settled as nothing-to-do is resolved, not retried for a week.
  assert public.apply_calendly_event('invitee.canceled', 'inv3__wv', null, null, null, null, false, null) = 'ignored', 'superseded cancel';
  insert into public.booking_reconciliation (event_type, invitee_uri, reason) values ('invitee.created', 'inv4__wv', 'parked earlier');
  assert public.apply_calendly_event('invitee.created', 'inv4__wv', null, null, 'cal__webhookverify@example.invalid', null, false, null) = 'ignored',
         'a superseded create was not ignored';
  assert (select resolution from public.booking_reconciliation where invitee_uri = 'inv4__wv' and event_type = 'invitee.created') = 'ignored',
         'an ignored parked event was left unresolved';
end $$;

rollback;
