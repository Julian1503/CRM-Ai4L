-- Verification for migrations 20260930000000_archive_and_remove.sql and
-- 20260930010000_archive_rules_hardening.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end. Every fixture carries the suffix `__archverify`.
--
-- Run with:
--   npm run db:verify:archive
--   npx supabase db query --linked --file supabase/tests/verify_20260930000000.sql
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- What this guards: nothing can be physically deleted by the application, a segment in
-- use cannot be archived, a campaign in flight cannot be archived, an archived campaign
-- is frozen, and a removal cannot be undone from the application role.

begin;

do $$
declare
  v_failed      boolean;
  v_segment_id  uuid;
  v_campaign_id uuid;
begin
  ----------------------------------------------------------------------------
  raise notice '1. columns, constraints and no delete policies';
  ----------------------------------------------------------------------------
  assert (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name in ('segments', 'campaigns')
            and column_name in ('archived_at', 'removed_at', 'removed_by')) = 6,
         'archive/remove columns are missing';

  assert not exists (
           select 1 from pg_policies
           where schemaname = 'public' and cmd = 'DELETE'
             and tablename in ('contacts', 'segments', 'organisations', 'services', 'campaigns')
         ), 'a business table still grants delete to the application';

  ----------------------------------------------------------------------------
  raise notice '2. fixtures';
  ----------------------------------------------------------------------------
  insert into public.segments (name, definition)
  values ('seg__archverify', '{}'::jsonb)
  returning id into v_segment_id;

  insert into public.campaigns (name, segment_id, provider_automation_id)
  values ('camp__archverify', v_segment_id, 'auto-archverify')
  returning id into v_campaign_id;

  -- Handed to the block that runs as the application role (section 11).
  perform set_config('archverify.segment_id', v_segment_id::text, true);

  ----------------------------------------------------------------------------
  raise notice '3. removed implies archived';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    update public.segments set removed_at = now() where id = v_segment_id;
  exception when check_violation then
    v_failed := true;
  end;
  assert v_failed, 'removed_at without archived_at must be rejected';

  ----------------------------------------------------------------------------
  raise notice '4. a segment used by a draft campaign cannot be archived';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    update public.segments set archived_at = now() where id = v_segment_id;
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'a segment in use must not be archivable';

  ----------------------------------------------------------------------------
  raise notice '5. an approved campaign cannot be archived';
  ----------------------------------------------------------------------------
  update public.campaigns set status = 'in_review' where id = v_campaign_id;
  update public.campaigns set status = 'approved', approved_by = gen_random_uuid()
  where id = v_campaign_id;

  v_failed := false;
  begin
    update public.campaigns set archived_at = now() where id = v_campaign_id;
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'an approved campaign must not be archivable';

  ----------------------------------------------------------------------------
  raise notice '6. an archived campaign is frozen';
  ----------------------------------------------------------------------------
  update public.campaigns set status = 'draft' where id = v_campaign_id;
  update public.campaigns set archived_at = now() where id = v_campaign_id;

  v_failed := false;
  begin
    update public.campaigns set status = 'in_review' where id = v_campaign_id;
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'an archived campaign must not change status';

  ----------------------------------------------------------------------------
  raise notice '7. with its campaign archived, the segment can be archived';
  ----------------------------------------------------------------------------
  update public.segments set archived_at = now() where id = v_segment_id;

  ----------------------------------------------------------------------------
  raise notice '8. a draft cannot be restored onto, or created for, an archived segment';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    update public.campaigns set archived_at = null where id = v_campaign_id;
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'restoring a draft onto an archived segment must be rejected';

  v_failed := false;
  begin
    insert into public.campaigns (name, segment_id) values ('camp2__archverify', v_segment_id);
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'a new campaign must not target an archived segment';

  -- 20260930010000: a live schedule cannot be pointed at an archived segment either.
  v_failed := false;
  begin
    update public.newsletter_schedules set segment_id = v_segment_id
    where id = (select id from public.newsletter_schedules where archived_at is null limit 1);
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed or not exists (select 1 from public.newsletter_schedules where archived_at is null),
         'a live schedule must not target an archived segment';

  ----------------------------------------------------------------------------
  raise notice '9. an archived segment name can be reused';
  ----------------------------------------------------------------------------
  insert into public.segments (name, definition) values ('SEG__archverify', '{}'::jsonb);

  ----------------------------------------------------------------------------
  raise notice '10. remove';
  ----------------------------------------------------------------------------
  update public.segments set removed_at = now(), removed_by = gen_random_uuid() where id = v_segment_id;
  update public.campaigns set removed_at = now(), removed_by = gen_random_uuid() where id = v_campaign_id;
end $$;

----------------------------------------------------------------------------
-- 11. As the application role: no physical delete, and no un-remove.
----------------------------------------------------------------------------
set local role authenticated;

do $$
declare
  v_failed boolean;
  v_segment_id uuid := current_setting('archverify.segment_id')::uuid;
begin
  delete from public.segments where id = v_segment_id;
  assert exists (select 1 from public.segments where id = v_segment_id),
         'the application role must not be able to delete a segment';

  v_failed := false;
  begin
    update public.segments set removed_at = null, archived_at = null where id = v_segment_id;
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'the application role must not be able to undo a removal';

  raise notice 'All archive and remove checks passed.';
end $$;

reset role;

rollback;
