-- Verification for migration 20260827000000_campaign_reruns.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end, so it is safe against any environment that already has the migration
-- applied. Every fixture carries the suffix `__rerunverify`.
--
-- Run with:
--   npm run db:verify:reruns
--   npx supabase db query --linked --file supabase/tests/verify_20260827000000.sql
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- What this guards: a second send must not be able to overwrite the first one's
-- history, and re-opening a sent campaign must not be able to skip the approval gate.
-- Both are enforced by the database, because both survive a bug in the application.

begin;

do $$
declare
  v_failed      boolean;
  v_count       int;
  v_segment_id  uuid;
  v_campaign_id uuid;
  v_contact_id  uuid;
begin
  ----------------------------------------------------------------------------
  raise notice '1. run columns exist with the right defaults';
  ----------------------------------------------------------------------------
  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='campaigns' and column_name='send_run') = 1,
         'campaigns.send_run is missing';

  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='campaign_sends' and column_name='run') = 1,
         'campaign_sends.run is missing';

  assert (select is_nullable from information_schema.columns
          where table_schema='public' and table_name='campaigns' and column_name='send_run') = 'NO',
         'campaigns.send_run must be NOT NULL';

  ----------------------------------------------------------------------------
  raise notice '2. deduplication is per run, not per campaign';
  ----------------------------------------------------------------------------
  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='campaign_sends_unique_recipient_run_idx') = 1,
         'the per-run unique index is missing';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='campaign_sends_unique_recipient_idx') = 0,
         'the old campaign-wide unique index is still present; a second run would be blocked';

  ----------------------------------------------------------------------------
  raise notice '3. fixtures';
  ----------------------------------------------------------------------------
  insert into public.segments (name, definition)
  values ('rerun segment__rerunverify', '{}'::jsonb)
  returning id into v_segment_id;

  insert into public.contacts (first_name, last_name, email)
  values ('Rerun', 'Verify', 'rerun__rerunverify@example.com')
  returning id into v_contact_id;

  insert into public.campaigns (name, segment_id, provider_automation_id)
  values ('rerun campaign__rerunverify', v_segment_id, 'auto-rerun')
  returning id into v_campaign_id;

  ----------------------------------------------------------------------------
  raise notice '4. the same contact can be sent to twice, in different runs';
  ----------------------------------------------------------------------------
  insert into public.campaign_sends (campaign_id, contact_id, status, run)
  values (v_campaign_id, v_contact_id, 'sent', 1);

  insert into public.campaign_sends (campaign_id, contact_id, status, run)
  values (v_campaign_id, v_contact_id, 'pending', 2);

  select count(*) into v_count from public.campaign_sends
  where campaign_id = v_campaign_id and contact_id = v_contact_id;
  assert v_count = 2, format('expected one ledger row per run, found %s', v_count);

  ----------------------------------------------------------------------------
  raise notice '5. but never twice within one run';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    insert into public.campaign_sends (campaign_id, contact_id, status, run)
    values (v_campaign_id, v_contact_id, 'pending', 2);
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed, 'a duplicate recipient within a run must be rejected - this is the double-send guard';

  ----------------------------------------------------------------------------
  raise notice '6. a sent campaign can be re-opened, but only to draft';
  ----------------------------------------------------------------------------
  update public.campaigns set status='in_review' where id=v_campaign_id;
  update public.campaigns set status='approved', approved_by=gen_random_uuid() where id=v_campaign_id;
  insert into public.campaign_runs (campaign_id, run, revision, segment_id, consent_stream, audience_status) select id, send_run, revision, segment_id, consent_stream, 'prepared' from public.campaigns where id = v_campaign_id on conflict do nothing;  -- audience prepared (20261003000000)
  update public.campaigns set status='sending' where id=v_campaign_id;
  update public.campaigns set status='sent' where id=v_campaign_id;

  v_failed := false;
  begin
    -- Straight back to sending would skip the approval gate entirely.
    update public.campaigns set status='sending' where id=v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'sent -> sending must be rejected; a second send must be approved again';

  v_failed := false;
  begin
    update public.campaigns set status='approved' where id=v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'sent -> approved must be rejected; re-opening returns a campaign to draft';

  update public.campaigns set status='draft' where id=v_campaign_id;
  assert (select status from public.campaigns where id=v_campaign_id) = 'draft',
         'sent -> draft must be allowed so a campaign can be re-sent';

  ----------------------------------------------------------------------------
  raise notice '7. the run counter only goes forward';
  ----------------------------------------------------------------------------
  update public.campaigns set send_run = 2 where id=v_campaign_id;

  v_failed := false;
  begin
    update public.campaigns set send_run = 1 where id=v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'send_run must not go backwards - a re-used run would overwrite send history';

  v_failed := false;
  begin
    update public.campaigns set send_run = 0 where id=v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'send_run must be at least 1';

  raise notice '';
  raise notice 'ALL CAMPAIGN RE-RUN CHECKS PASSED';
end $$;

rollback;
