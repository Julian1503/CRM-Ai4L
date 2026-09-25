-- Verification for migration 20260901000000_dual_consent.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end, so it is safe against any environment that already has the migration
-- applied. Every fixture carries the suffix `__consentverify`.
--
-- Run with:
--   npm run db:verify:consent
--   npx supabase db query --linked --file supabase/tests/verify_20260901000000.sql
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- What this guards: the archive rule and the consent ledger survive a bug in the
-- application, because five separate write paths touch these columns and only the
-- database sees all five.

begin;

do $$
declare
  v_id        uuid;
  v_deleted   timestamptz;
  v_reason    text;
  v_status    public.contact_status;
  v_count      int;
  v_rejected   boolean;
  v_result     jsonb;
  v_newsletter boolean;
  v_programs   boolean;
begin
  ----------------------------------------------------------------------------
  raise notice '1. columns and constraint exist';
  ----------------------------------------------------------------------------
  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='contacts'
            and column_name='subscribed_to_programs') = 1,
         'contacts.subscribed_to_programs is missing';

  assert (select is_nullable from information_schema.columns
          where table_schema='public' and table_name='contacts'
            and column_name='subscribed_to_programs') = 'NO',
         'contacts.subscribed_to_programs must be NOT NULL';

  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='contacts'
            and column_name='archive_reason') = 1,
         'contacts.archive_reason is missing';

  assert (select count(*) from pg_constraint
          where conname = 'contacts_archive_reason_valid') = 1,
         'contacts_archive_reason_valid is missing';

  assert (select count(*) from information_schema.tables
          where table_schema='public' and table_name='contact_consent_events') = 1,
         'contact_consent_events is missing';

  ----------------------------------------------------------------------------
  raise notice '2. a contact created without consent is NOT archived';
  ----------------------------------------------------------------------------
  -- Someone typed this contact into the CRM. No consent is not an unsubscribe.
  insert into public.contacts (first_name, last_name, email, status)
  values ('Nobody', 'Consent__consentverify', 'nobody__consentverify@example.invalid', 'prospect')
  returning id into v_id;

  select deleted_at, status into v_deleted, v_status
  from public.contacts where id = v_id;

  assert v_deleted is null, 'a contact created with no consent was archived on insert';
  assert v_status = 'prospect', 'status was changed on insert';

  assert (select count(*) from public.contact_consent_events where contact_id = v_id) = 0,
         'granting nothing recorded a consent event';

  ----------------------------------------------------------------------------
  raise notice '3. consent on insert is recorded';
  ----------------------------------------------------------------------------
  insert into public.contacts
    (first_name, last_name, email, status, subscribed_to_newsletter, subscribed_to_programs)
  values ('Both', 'Consent__consentverify', 'both__consentverify@example.invalid',
          'prospect', true, true)
  returning id into v_id;

  assert (select count(*) from public.contact_consent_events
          where contact_id = v_id and granted) = 2,
         'two grants on insert were not both recorded';

  assert (select count(*) from public.contact_consent_events
          where contact_id = v_id and stream = 'programs' and granted) = 1,
         'the programs grant was not recorded';

  ----------------------------------------------------------------------------
  raise notice '4. dropping one consent does not archive';
  ----------------------------------------------------------------------------
  update public.contacts set subscribed_to_newsletter = false where id = v_id;

  select deleted_at into v_deleted from public.contacts where id = v_id;
  assert v_deleted is null,
         'losing one consent archived the contact; only losing every consent may';

  assert (select count(*) from public.contact_consent_events
          where contact_id = v_id and stream = 'newsletter' and not granted) = 1,
         'the newsletter withdrawal was not recorded';

  ----------------------------------------------------------------------------
  raise notice '5. dropping the last consent archives, with a reason';
  ----------------------------------------------------------------------------
  update public.contacts set subscribed_to_programs = false where id = v_id;

  select deleted_at, archive_reason, status into v_deleted, v_reason, v_status
  from public.contacts where id = v_id;

  assert v_deleted is not null, 'losing every consent did not archive the contact';
  assert v_reason = 'opted_out', format('archive_reason should be opted_out, got %s', v_reason);
  assert v_status = 'archived', format('status should be archived, got %s', v_status);

  ----------------------------------------------------------------------------
  raise notice '6. regaining any consent un-archives an opted-out contact';
  ----------------------------------------------------------------------------
  update public.contacts set subscribed_to_programs = true where id = v_id;

  select deleted_at, archive_reason, status into v_deleted, v_reason, v_status
  from public.contacts where id = v_id;

  assert v_deleted is null, 're-subscribing did not restore the opted-out contact';
  assert v_reason is null, 'archive_reason survived the restore';
  assert v_status <> 'archived', 'status stayed archived after restore';

  ----------------------------------------------------------------------------
  raise notice '7. re-subscribing must NOT resurrect a manual archive';
  ----------------------------------------------------------------------------
  -- The rule applyNewsletterEvent has always enforced in the application: an external
  -- form cannot undo a decision a person made in the CRM.
  --
  -- The contact is put in the state the rule is actually about — archived by a person,
  -- holding no consent — so that the un-archive branch is reached and refused on the
  -- reason, rather than skipped because consent never went away.
  update public.contacts
  set deleted_at = timezone('utc'::text, now()), archive_reason = 'manual'
  where id = v_id;

  update public.contacts
  set subscribed_to_newsletter = false, subscribed_to_programs = false
  where id = v_id;

  select deleted_at, archive_reason into v_deleted, v_reason
  from public.contacts where id = v_id;

  assert v_deleted is not null, 'the manual archive was lifted by withdrawing consent';
  assert v_reason = 'manual',
         'losing consent while already archived overwrote the manual reason';

  update public.contacts
  set subscribed_to_newsletter = true
  where id = v_id;

  select deleted_at, archive_reason into v_deleted, v_reason
  from public.contacts where id = v_id;

  assert v_deleted is not null, 'a newsletter signup un-archived a manually archived contact';
  assert v_reason = 'manual', 'the manual archive reason was overwritten';

  ----------------------------------------------------------------------------
  raise notice '8. an opted-out contact can still be restored by hand';
  ----------------------------------------------------------------------------
  -- The archive screen restores by clearing deleted_at. With both flags false, a rule
  -- that read the resting state instead of the transition would archive it again on
  -- the same statement and make restore silently impossible.
  insert into public.contacts
    (first_name, last_name, email, status, subscribed_to_newsletter)
  values ('Restore', 'Consent__consentverify', 'restore__consentverify@example.invalid',
          'prospect', true)
  returning id into v_id;

  update public.contacts set subscribed_to_newsletter = false where id = v_id;
  update public.contacts set deleted_at = null where id = v_id;

  select deleted_at, archive_reason into v_deleted, v_reason
  from public.contacts where id = v_id;

  assert v_deleted is null, 'restoring an opted-out contact re-archived it immediately';
  assert v_reason is null, 'archive_reason was left behind on a restored contact';

  ----------------------------------------------------------------------------
  raise notice '9. writing the same value back is not an event';
  ----------------------------------------------------------------------------
  select count(*) into v_count from public.contact_consent_events where contact_id = v_id;

  update public.contacts set subscribed_to_newsletter = false where id = v_id;

  assert (select count(*) from public.contact_consent_events where contact_id = v_id) = v_count,
         'a no-op write recorded a consent event; an import would forge consent history';

  ----------------------------------------------------------------------------
  raise notice '10. archive_reason cannot contradict deleted_at';
  ----------------------------------------------------------------------------
  -- Two mechanisms, checked in the order they fire. The trigger normalises first, so a
  -- write claiming a reason on an active row is corrected rather than rejected; the
  -- CHECK constraint behind it is the backstop for anything that reaches the table
  -- without the trigger (a disabled trigger, a COPY, a future column list that forgets
  -- one of these columns).
  insert into public.contacts (first_name, last_name, email, archive_reason)
  values ('Bad', 'Reason__consentverify', 'bad__consentverify@example.invalid', 'opted_out')
  returning id into v_id;

  select archive_reason into v_reason from public.contacts where id = v_id;
  assert v_reason is null,
         format('an active contact kept archive_reason %s', v_reason);

  v_rejected := false;
  begin
    alter table public.contacts disable trigger contacts_sync_customer_status;

    insert into public.contacts (first_name, last_name, email, archive_reason)
    values ('Worse', 'Reason__consentverify', 'worse__consentverify@example.invalid', 'opted_out');
  exception
    when check_violation then v_rejected := true;
  end;

  alter table public.contacts enable trigger contacts_sync_customer_status;

  assert v_rejected, 'the CHECK constraint let an active contact carry an archive_reason';

  ----------------------------------------------------------------------------
  raise notice '11. the consent ledger is read-only through the API';
  ----------------------------------------------------------------------------
  assert (select count(*) from pg_policies
          where schemaname='public' and tablename='contact_consent_events'
            and cmd in ('INSERT', 'UPDATE', 'DELETE')) = 0,
         'contact_consent_events has a write policy; the trigger must be its only writer';

  assert (select relrowsecurity from pg_class
          where oid = 'public.contact_consent_events'::regclass),
         'RLS is not enabled on contact_consent_events';

  ----------------------------------------------------------------------------
  raise notice '12. import grants both consents to a new contact';
  ----------------------------------------------------------------------------
  v_result := public.import_contacts(
    '[{"email":"fresh__consentverify@example.invalid","first_name":"Fresh","last_name":"Import__consentverify"}]'::jsonb
  );

  assert (v_result->>'inserted')::int = 1,
         format('expected one insert, got %s', v_result->>'inserted');

  select id, subscribed_to_newsletter, subscribed_to_programs
  into v_id, v_newsletter, v_programs
  from public.contacts where email = 'fresh__consentverify@example.invalid';

  assert v_newsletter, 'an imported contact did not get newsletter consent';
  assert v_programs, 'an imported contact did not get programme consent';

  assert (select count(*) from public.contact_consent_events
          where contact_id = v_id and source = 'import') = 2,
         'the import did not label its consent events';

  ----------------------------------------------------------------------------
  raise notice '13. re-importing cannot re-grant a withdrawn consent';
  ----------------------------------------------------------------------------
  update public.contacts
  set subscribed_to_newsletter = false
  where email = 'fresh__consentverify@example.invalid';

  -- The same file again: the addresses are there, the consent columns are not.
  v_result := public.import_contacts(
    '[{"email":"fresh__consentverify@example.invalid","first_name":"Fresh","last_name":"Import__consentverify"}]'::jsonb
  );

  assert (v_result->>'updated')::int = 1,
         format('expected one update, got %s', v_result->>'updated');

  select subscribed_to_newsletter into v_newsletter
  from public.contacts where email = 'fresh__consentverify@example.invalid';

  assert not v_newsletter,
         're-importing a spreadsheet re-subscribed a contact who had unsubscribed';

  -- An explicit "No" still withdraws: the spreadsheet may lower consent, never raise it.
  v_result := public.import_contacts(
    '[{"email":"fresh__consentverify@example.invalid","first_name":"Fresh","last_name":"Import__consentverify","subscribed_to_programs":false}]'::jsonb
  );

  select deleted_at, archive_reason into v_deleted, v_reason
  from public.contacts where email = 'fresh__consentverify@example.invalid';

  assert v_deleted is not null,
         'an import that withdrew the last consent did not archive the contact';
  assert v_reason = 'opted_out', 'the import-driven archive was not recorded as opted_out';

  ----------------------------------------------------------------------------
  raise notice '14. an archived address is reported, not duplicated';
  ----------------------------------------------------------------------------
  -- Email is unique only among live rows, so this address conflicts with nothing and
  -- the old function inserted a second, live, fully-subscribed copy of the person who
  -- had just unsubscribed.
  v_result := public.import_contacts(
    '[{"email":"fresh__consentverify@example.invalid","first_name":"Fresh","last_name":"Import__consentverify"}]'::jsonb
  );

  assert (v_result->>'archived_collisions')::int = 1,
         format('expected one archived collision, got %s', v_result->>'archived_collisions');
  assert (v_result->>'inserted')::int = 0,
         'an archived contact was duplicated by the importer';

  assert (select count(*) from public.contacts
          where email = 'fresh__consentverify@example.invalid') = 1,
         'the importer left two rows for one address';

  ----------------------------------------------------------------------------
  raise notice '15. apply_contact_consent labels the ledger and leaves nulls alone';
  ----------------------------------------------------------------------------
  insert into public.contacts
    (first_name, last_name, email, status, subscribed_to_newsletter, subscribed_to_programs)
  values ('Rpc', 'Consent__consentverify', 'rpc__consentverify@example.invalid',
          'prospect', true, true)
  returning id into v_id;

  perform public.apply_contact_consent(
    v_id, false, null, 'preference_center', '{"ip":"203.0.113.7"}'::jsonb
  );

  select subscribed_to_newsletter, subscribed_to_programs
  into v_newsletter, v_programs
  from public.contacts where id = v_id;

  assert not v_newsletter, 'the RPC did not withdraw the consent it was given';
  assert v_programs, 'a null flag changed the stream it was supposed to leave alone';

  assert (select count(*) from public.contact_consent_events
          where contact_id = v_id and source = 'preference_center'
            and stream = 'newsletter' and not granted) = 1,
         'the RPC did not attribute the withdrawal to its caller';

  assert (select evidence->>'ip' from public.contact_consent_events
          where contact_id = v_id and source = 'preference_center'
          order by occurred_at desc limit 1) = '203.0.113.7',
         'the request context was not recorded with the consent change';

  -- Attribution must not leak past the call that set it.
  update public.contacts set subscribed_to_programs = false where id = v_id;

  assert (select source from public.contact_consent_events
          where contact_id = v_id and stream = 'programs' and not granted) = 'unknown',
         'one call''s attribution leaked into a later, unrelated write';

  v_rejected := false;
  begin
    perform public.apply_contact_consent(v_id, true, null, '', null);
  exception
    when others then v_rejected := true;
  end;

  assert v_rejected, 'the RPC accepted an unattributed consent change';

  ----------------------------------------------------------------------------
  raise notice '16. campaigns carry the consent they spend';
  ----------------------------------------------------------------------------
  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='campaigns'
            and column_name='consent_stream') = 1,
         'campaigns.consent_stream is missing';

  assert (select column_default from information_schema.columns
          where table_schema='public' and table_name='campaigns'
            and column_name='consent_stream') like '%newsletter%',
         'campaigns.consent_stream should default to newsletter for existing rows';

  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='campaign_templates'
            and column_name='consent_stream') = 1,
         'campaign_templates.consent_stream is missing';

  raise notice 'All dual-consent assertions passed.';
end $$;

rollback;
