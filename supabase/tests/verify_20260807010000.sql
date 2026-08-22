-- Verification for migration 20260807010000_webhook_events_and_contact_source.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end, so it is safe against any environment that already has the migration
-- applied. Every fixture carries the suffix `__p3verify`.
--
-- Run with:
--   npm run db:verify:webhooks
--   npx supabase db query --linked --file supabase/tests/verify_20260807010000.sql
-- Or paste into the Supabase SQL editor.
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- What this covers that the Jest suite cannot: the webhook route's tests mock the
-- database, so they verify the handler *asks* for an idempotent insert. Whether the
-- database actually refuses the duplicate is a property of the unique index, and only
-- a real database can answer that.

begin;

do $$
declare
  v_failed   boolean;
  v_count    int;
  v_received timestamptz;
begin
  ----------------------------------------------------------------------------
  raise notice '1. schema objects exist';
  ----------------------------------------------------------------------------
  assert (select count(*) from pg_class where relname='webhook_events' and relkind='r') = 1,
         'webhook_events table missing';

  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='webhook_events'
            and column_name in ('id','provider','event_id','event_type','received_at')) = 5,
         'webhook_events is missing one of its five columns';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='webhook_events_provider_event_idx') = 1,
         'unique index webhook_events_provider_event_idx missing - idempotency is unenforced';

  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='contacts' and column_name='source') = 1,
         'contacts.source missing';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='contacts_source_idx') = 1,
         'contacts_source_idx missing';

  ----------------------------------------------------------------------------
  raise notice '2. provider and event_id are NOT NULL';
  ----------------------------------------------------------------------------
  -- A null event_id would defeat the unique index: nulls do not conflict, so every
  -- retry of an id-less event would insert a fresh row and be reprocessed.
  assert (select is_nullable = 'NO' from information_schema.columns
          where table_schema='public' and table_name='webhook_events' and column_name='provider'),
         'webhook_events.provider should be NOT NULL';

  assert (select is_nullable = 'NO' from information_schema.columns
          where table_schema='public' and table_name='webhook_events' and column_name='event_id'),
         'webhook_events.event_id should be NOT NULL';

  ----------------------------------------------------------------------------
  raise notice '3. the ledger accepts a first delivery';
  ----------------------------------------------------------------------------
  insert into public.webhook_events (provider, event_id, event_type)
  values ('emailoctopus', 'evt__p3verify', 'contact.unsubscribed');

  select received_at into v_received from public.webhook_events
  where provider='emailoctopus' and event_id='evt__p3verify';
  assert v_received is not null, 'received_at should default rather than being left null';

  ----------------------------------------------------------------------------
  raise notice '4. a REPLAY of the same event is refused';
  ----------------------------------------------------------------------------
  -- The entire idempotency mechanism. Providers deliver at-least-once, and without
  -- this a retried "unsubscribed" lands after a newer "subscribed" and undoes it.
  v_failed := false;
  begin
    insert into public.webhook_events (provider, event_id, event_type)
    values ('emailoctopus', 'evt__p3verify', 'contact.unsubscribed');
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed,
    'a duplicate (provider, event_id) was accepted - retried webhooks will reprocess';

  ----------------------------------------------------------------------------
  raise notice '5. the same event id from a DIFFERENT provider is allowed';
  ----------------------------------------------------------------------------
  -- Stripe and EmailOctopus mint ids independently; a collision between them is not a
  -- replay, and treating it as one would silently drop a real event.
  insert into public.webhook_events (provider, event_id, event_type)
  values ('stripe', 'evt__p3verify', 'checkout.session.completed');

  assert (select count(*) from public.webhook_events where event_id='evt__p3verify') = 2,
         'the unique index should be scoped to (provider, event_id), not event_id alone';

  ----------------------------------------------------------------------------
  raise notice '6. event_type is optional';
  ----------------------------------------------------------------------------
  -- Recorded for traceability back to the provider dashboard, but a payload that omits
  -- it must still be marked handled rather than reprocessed forever.
  insert into public.webhook_events (provider, event_id)
  values ('calendly', 'evt-untyped__p3verify');

  assert (select event_type is null from public.webhook_events
          where event_id='evt-untyped__p3verify'),
         'event_type should be nullable';

  ----------------------------------------------------------------------------
  raise notice '7. RLS is enabled; reads are granted, writes are not';
  ----------------------------------------------------------------------------
  assert (select relrowsecurity from pg_class where relname='webhook_events'),
         'RLS is not enabled on webhook_events';

  assert (select count(*) from pg_policies
          where schemaname='public' and tablename='webhook_events' and cmd='SELECT') = 1,
         'authenticated users should be able to read the ledger to diagnose deliveries';

  select count(*) into v_count from pg_policies
  where schemaname='public' and tablename='webhook_events'
    and cmd in ('INSERT','UPDATE','DELETE');
  assert v_count = 0,
    format('webhook_events should have no write policy (service-role only), found %s', v_count);

  ----------------------------------------------------------------------------
  raise notice '8. contacts.source records provenance';
  ----------------------------------------------------------------------------
  -- Needed so the client can tell which records carry a genuine opt-in, which is the
  -- Spam Act question in PLAN.md.
  insert into public.contacts (first_name, last_name, email, source)
  values ('Source', 'Check', 'source__p3verify@example.com', 'newsletter');

  assert (select source = 'newsletter' from public.contacts
          where email='source__p3verify@example.com'),
         'contacts.source did not round-trip';

  -- Null for pre-existing rows is intended, not an oversight: the 5,202 imported
  -- contacts predate this column, and guessing their origin would misrepresent consent.
  insert into public.contacts (first_name, last_name, email)
  values ('NoSource', 'Check', 'nosource__p3verify@example.com');

  assert (select source is null from public.contacts
          where email='nosource__p3verify@example.com'),
         'source should be nullable';

  raise notice '';
  raise notice 'ALL PHASE 3 (webhook ledger + provenance) CHECKS PASSED';
end $$;

rollback;
