-- Verification for migrations 20261001000000_archive_and_remove_phase2.sql and
-- 20261001010000_refresh_active_contacts_view.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end. Every fixture carries the suffix `__arch2verify`.
--
-- Run with:
--   npm run db:verify:archive2
--   npx supabase db query --linked --file supabase/tests/verify_20261001000000.sql
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- What this guards: a removed contact never comes back through consent, its address is
-- importable again without regaining a consent it had withdrawn, a template a live
-- schedule uses cannot be archived, and topics are never physically deleted.

begin;

do $$
declare
  v_failed      boolean;
  v_contact_id  uuid;
  v_segment_id  uuid;
  v_template_id uuid;
  v_schedule_id uuid;
  v_topic_id    uuid;
  v_result      jsonb;
begin
  ----------------------------------------------------------------------------
  raise notice '1. columns and no delete policy on topics';
  ----------------------------------------------------------------------------
  assert (select count(*) from information_schema.columns
          where table_schema = 'public'
            and table_name in ('contacts', 'campaign_templates', 'newsletter_schedules', 'newsletter_topics')
            and column_name in ('removed_at', 'removed_by')) = 8,
         'removed_at / removed_by missing somewhere';

  assert not exists (
           select 1 from pg_policies
           where schemaname = 'public' and cmd = 'DELETE' and tablename = 'newsletter_topics'
         ), 'topics must not be deletable by the application';

  -- 20261001010000: the view carries every column of the table again.
  assert (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'active_contacts')
       = (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'contacts'),
         'active_contacts is missing columns of contacts - recreate the view';

  ----------------------------------------------------------------------------
  raise notice '2. a removed contact must be archived';
  ----------------------------------------------------------------------------
  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
  values ('Gone', 'Verify', 'gone__arch2verify@example.com', true)
  returning id into v_contact_id;

  v_failed := false;
  begin
    update public.contacts set removed_at = now() where id = v_contact_id;
  exception when check_violation then
    v_failed := true;
  end;
  assert v_failed, 'removed_at without deleted_at must be rejected';

  ----------------------------------------------------------------------------
  raise notice '3. regaining consent never brings a removed contact back';
  ----------------------------------------------------------------------------
  -- Opting out archives with reason opted_out; removing then makes it final.
  update public.contacts set subscribed_to_newsletter = false where id = v_contact_id;
  assert (select archive_reason = 'opted_out' from public.contacts where id = v_contact_id),
         'opting out should archive with reason opted_out';

  update public.contacts set removed_at = now() where id = v_contact_id;

  -- Before this migration, this write failed on the CHECK (the trigger un-archived it).
  update public.contacts set subscribed_to_newsletter = true where id = v_contact_id;
  assert (select deleted_at is not null and removed_at is not null
          from public.contacts where id = v_contact_id),
         'a removed contact must stay archived and removed when consent returns';

  -- Put the withdrawal back, so the import below sees a removed contact without consent.
  update public.contacts set subscribed_to_newsletter = false where id = v_contact_id;

  ----------------------------------------------------------------------------
  raise notice '4. import: a removed address comes back, without its withdrawn consent';
  ----------------------------------------------------------------------------
  select public.import_contacts($json$[
    {"email":"gone__arch2verify@example.com","first_name":"Back","last_name":"Verify"}
  ]$json$::jsonb) into v_result;

  assert (v_result->>'inserted')::int = 1 and (v_result->>'archived_collisions')::int = 0,
         format('a removed address should import as a new contact, got %s', v_result);
  -- Never more consent than the removed record held: it had withdrawn the newsletter
  -- and never had programmes (the column defaults to false), so neither is granted.
  assert (select not subscribed_to_newsletter and not subscribed_to_programs
          from public.active_contacts where email = 'gone__arch2verify@example.com'),
         'the new contact must not hold more consent than the removed one did';

  ----------------------------------------------------------------------------
  raise notice '5. a template a live schedule uses cannot be archived';
  ----------------------------------------------------------------------------
  insert into public.segments (name, definition)
  values ('seg__arch2verify', '{}'::jsonb)
  returning id into v_segment_id;

  insert into public.campaign_templates (name, provider_automation_id, slots, consent_stream)
  values ('tpl__arch2verify', 'auto-arch2', '[{"tag":"Headline"}]'::jsonb, 'newsletter')
  returning id into v_template_id;

  insert into public.newsletter_schedules (name, template_id, segment_id, frequency, next_run_at, goal)
  values ('sched__arch2verify', v_template_id, v_segment_id, 'monthly', now(), 'Keep readers informed')
  returning id into v_schedule_id;

  v_failed := false;
  begin
    update public.campaign_templates set archived_at = now() where id = v_template_id;
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'a template in use by a live schedule must not be archivable';

  ----------------------------------------------------------------------------
  raise notice '6. a schedule cannot be restored onto an archived template';
  ----------------------------------------------------------------------------
  update public.newsletter_schedules set archived_at = now() where id = v_schedule_id;
  update public.campaign_templates set archived_at = now() where id = v_template_id;

  v_failed := false;
  begin
    update public.newsletter_schedules set archived_at = null where id = v_schedule_id;
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'restoring a schedule onto an archived template must be rejected';

  ----------------------------------------------------------------------------
  raise notice '7. archived names can be reused';
  ----------------------------------------------------------------------------
  insert into public.campaign_templates (name, provider_automation_id, slots, consent_stream)
  values ('TPL__arch2verify', 'auto-arch2b', '[{"tag":"Headline"}]'::jsonb, 'newsletter');

  ----------------------------------------------------------------------------
  raise notice '8. a used topic cannot be removed';
  ----------------------------------------------------------------------------
  insert into public.newsletter_topics (schedule_id, title, position, used_at)
  values (v_schedule_id, 'Used__arch2verify', 1, now())
  returning id into v_topic_id;

  v_failed := false;
  begin
    update public.newsletter_topics set removed_at = now() where id = v_topic_id;
  exception when check_violation then
    v_failed := true;
  end;
  assert v_failed, 'a used topic must not be removable';

  -- Handed to the block that runs as the application role.
  perform set_config('arch2verify.contact_id', v_contact_id::text, true);
  perform set_config('arch2verify.topic_id', v_topic_id::text, true);
end $$;

----------------------------------------------------------------------------
-- 9. As the application role: no physical delete, and no un-remove.
----------------------------------------------------------------------------
set local role authenticated;

do $$
declare
  v_failed     boolean;
  v_contact_id uuid := current_setting('arch2verify.contact_id')::uuid;
  v_topic_id   uuid := current_setting('arch2verify.topic_id')::uuid;
begin
  delete from public.newsletter_topics where id = v_topic_id;
  assert exists (select 1 from public.newsletter_topics where id = v_topic_id),
         'the application role must not be able to delete a topic';

  delete from public.contacts where id = v_contact_id;
  assert exists (select 1 from public.contacts where id = v_contact_id),
         'the application role must not be able to delete a contact';

  v_failed := false;
  begin
    update public.contacts set removed_at = null, deleted_at = null where id = v_contact_id;
  exception when sqlstate 'CRM01' then
    v_failed := true;
  end;
  assert v_failed, 'the application role must not be able to undo a contact removal';

  raise notice 'All phase 2 archive and remove checks passed.';
end $$;

reset role;

rollback;
