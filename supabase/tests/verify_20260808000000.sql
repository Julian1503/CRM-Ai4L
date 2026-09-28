-- Verification for migration 20260808000000_segments_and_campaigns.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end, so it is safe against any environment that already has the migration
-- applied. Every fixture carries the suffix `__p4verify`.
--
-- Run with:
--   npm run db:verify:campaigns
--   npx supabase db query --linked --file supabase/tests/verify_20260808000000.sql
-- Or paste into the Supabase SQL editor.
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- Why this file matters more than the others: sending is IRREVERSIBLE. Once mail is
-- queued at the provider there is no recall. The application refuses to send an
-- unapproved campaign, but the application is not the last line of defence -- the
-- status trigger is, because it also binds a direct SQL edit. Everything the Jest
-- suite asserts about approval is asserted against a mock; this asserts it against
-- the thing that actually enforces it.

begin;

do $$
declare
  v_failed      boolean;
  v_count       int;
  v_segment_id  uuid;
  v_segment2_id uuid;
  v_campaign_id uuid;
  v_contact_id  uuid;
begin
  ----------------------------------------------------------------------------
  raise notice '1. schema objects exist';
  ----------------------------------------------------------------------------
  assert (select count(*) from pg_class
          where relname in ('segments','campaigns','campaign_sends') and relkind='r') = 3,
         'one of segments / campaigns / campaign_sends is missing';

  assert (select count(*) from pg_type where typname='campaign_status') = 1,
         'enum campaign_status missing';

  assert (select count(*) from pg_enum e join pg_type t on t.oid=e.enumtypid
          where t.typname='campaign_status') = 6,
         'campaign_status should have exactly six labels';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='campaign_sends_unique_recipient_idx') = 1,
         'campaign_sends_unique_recipient_idx missing - a retry can double-send';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='segments_name_ci_idx') = 1,
         'segments_name_ci_idx missing';

  assert (select count(*) from pg_trigger
          where tgname='campaigns_status_transition' and not tgisinternal) = 1,
         'the campaigns_status_transition trigger is missing - approval is unenforced';

  ----------------------------------------------------------------------------
  raise notice '2. segment names are unique case-insensitively';
  ----------------------------------------------------------------------------
  insert into public.segments (name, definition)
  values ('RTOs in NSW __p4verify', '{"state":"NSW"}'::jsonb)
  returning id into v_segment_id;

  v_failed := false;
  begin
    insert into public.segments (name) values ('rtos in nsw __P4VERIFY');
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed, 'two segments differing only by case were allowed';

  ----------------------------------------------------------------------------
  raise notice '3. a campaign MUST be created as draft';
  ----------------------------------------------------------------------------
  -- Otherwise an insert could arrive pre-approved and skip the human gate entirely.
  v_failed := false;
  begin
    insert into public.campaigns (name, segment_id, status, provider_automation_id, approved_by)
    values ('Born approved __p4verify', v_segment_id, 'approved', 'auto_1', gen_random_uuid());
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'a campaign was inserted directly as approved';

  insert into public.campaigns (name, segment_id)
  values ('Winter promo __p4verify', v_segment_id)
  returning id into v_campaign_id;

  assert (select status = 'draft' from public.campaigns where id = v_campaign_id),
         'a new campaign should default to draft';

  ----------------------------------------------------------------------------
  raise notice '4. draft cannot jump straight to sending';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    update public.campaigns set status='sending' where id = v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'draft -> sending was allowed, bypassing review and approval';

  ----------------------------------------------------------------------------
  raise notice '5. approval requires an approver';
  ----------------------------------------------------------------------------
  update public.campaigns set status='in_review' where id = v_campaign_id;
  assert (select status = 'in_review' from public.campaigns where id = v_campaign_id),
         'draft -> in_review should be allowed';

  v_failed := false;
  begin
    update public.campaigns
       set status='approved', provider_automation_id='auto__p4verify'
     where id = v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'a campaign was approved with no approved_by - approval is unattributable';

  ----------------------------------------------------------------------------
  raise notice '6. approval requires a provider automation id';
  ----------------------------------------------------------------------------
  -- Without one there is nothing to queue contacts into, so approving would produce a
  -- campaign that can never send. Blank must be rejected the same as null.
  v_failed := false;
  begin
    update public.campaigns
       set status='approved', approved_by=gen_random_uuid()
     where id = v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'a campaign was approved with no provider_automation_id';

  v_failed := false;
  begin
    update public.campaigns
       set status='approved', approved_by=gen_random_uuid(), provider_automation_id='   '
     where id = v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'a whitespace-only provider_automation_id was accepted as an automation id';

  ----------------------------------------------------------------------------
  raise notice '7. the full happy path runs draft -> in_review -> approved -> sending -> sent';
  ----------------------------------------------------------------------------
  update public.campaigns
     set status='approved', approved_by=gen_random_uuid(),
         provider_automation_id='auto__p4verify', approved_at=now()
   where id = v_campaign_id;
  assert (select status = 'approved' from public.campaigns where id = v_campaign_id),
         'a properly attributed approval was refused';

  update public.campaigns set status='sending', started_at=now() where id = v_campaign_id;
  update public.campaigns set status='sent', completed_at=now() where id = v_campaign_id;
  assert (select status = 'sent' from public.campaigns where id = v_campaign_id),
         'sending -> sent should be allowed';

  ----------------------------------------------------------------------------
  raise notice '8. sent is terminal';
  ----------------------------------------------------------------------------
  -- Mail is out. Re-opening a sent campaign would let it be edited and re-sent while
  -- its ledger still claims the first send, so there is no route out of this state.
  v_failed := false;
  begin
    update public.campaigns set status='draft' where id = v_campaign_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'a sent campaign was reopened';

  ----------------------------------------------------------------------------
  raise notice '9. a recipient cannot be queued twice for one campaign';
  ----------------------------------------------------------------------------
  -- EmailOctopus refuses a repeat trigger by default, but with "Allow contacts to
  -- repeat" enabled it will happily send twice. This index is then the only thing
  -- standing between a resumed send and a double delivery.
  insert into public.contacts (first_name, last_name, email)
  values ('Send', 'Target', 'send__p4verify@example.com')
  returning id into v_contact_id;

  insert into public.campaign_sends (campaign_id, contact_id, status)
  values (v_campaign_id, v_contact_id, 'sent');

  v_failed := false;
  begin
    insert into public.campaign_sends (campaign_id, contact_id, status)
    values (v_campaign_id, v_contact_id, 'pending');
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed,
    'the same contact was queued twice for one campaign - a resumed send will double-deliver';

  ----------------------------------------------------------------------------
  raise notice '10. campaign_sends.status is constrained to the four known values';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    insert into public.campaign_sends (campaign_id, contact_id, status)
    values (v_campaign_id, gen_random_uuid(), 'delivered');
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'an unknown campaign_sends.status was accepted';

  ----------------------------------------------------------------------------
  raise notice '11. deleting a contact removes its ledger rows';
  ----------------------------------------------------------------------------
  -- on delete cascade. A send ledger pointing at a hard-deleted contact would be
  -- unreadable history rather than useful history.
  delete from public.contacts where id = v_contact_id;
  assert (select count(*) from public.campaign_sends where contact_id = v_contact_id) = 0,
         'campaign_sends rows survived the deletion of their contact';

  ----------------------------------------------------------------------------
  raise notice '12. a segment in use cannot be deleted';
  ----------------------------------------------------------------------------
  -- on delete restrict. Deleting one out from under a sent campaign would orphan the
  -- record of who was actually mailed.
  v_failed := false;
  begin
    delete from public.segments where id = v_segment_id;
  exception when foreign_key_violation then
    v_failed := true;
  end;
  assert v_failed, 'a segment referenced by a campaign was deleted';

  -- As the owner an unreferenced segment still deletes. The application role cannot:
  -- 20260930000000 dropped the delete policy, and the app archives instead.
  insert into public.segments (name) values ('Unused __p4verify') returning id into v_segment2_id;
  delete from public.segments where id = v_segment2_id;
  assert (select count(*) from public.segments where id = v_segment2_id) = 0,
         'an unreferenced segment should be deletable';

  ----------------------------------------------------------------------------
  raise notice '13. RLS is enabled on all three tables';
  ----------------------------------------------------------------------------
  select count(*) into v_count from pg_class
  where relname in ('segments','campaigns','campaign_sends') and relrowsecurity;
  assert v_count = 3, format('RLS is enabled on only %s of the three tables', v_count);

  select count(*) into v_count from pg_policies
  where schemaname='public' and tablename in ('segments','campaigns','campaign_sends')
    and cmd in ('SELECT','INSERT','UPDATE');
  assert v_count = 9,
    format('expected select/insert/update policies on all three tables (9), found %s', v_count);

  ----------------------------------------------------------------------------
  raise notice '14. nothing here may be deleted by an authenticated user';
  ----------------------------------------------------------------------------
  -- Segments used to be deletable; since 20260930000000 they are archived or removed
  -- (a soft delete) instead, and no delete policy remains.
  select count(*) into v_count from pg_policies
  where schemaname='public' and tablename in ('segments','campaigns','campaign_sends') and cmd='DELETE';
  assert v_count = 0,
    format('campaigns / campaign_sends must not be deletable - that is the send history (%s policies found)', v_count);

  raise notice '';
  raise notice 'ALL PHASE 4 (segments, campaigns, send ledger) CHECKS PASSED';
end $$;

rollback;
