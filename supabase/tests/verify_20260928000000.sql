-- Verification for migration 20260928000000_newsletter_schedules.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end. Every fixture carries the suffix `__schedverify`.
--
-- Run with:
--   npm run db:verify:schedules
--   npx supabase db query --linked --file supabase/tests/verify_20260928000000.sql
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- What this guards: a schedule can only spend newsletter consent, and the cron can
-- never draft the same occurrence twice.

begin;

do $$
declare
  v_failed        boolean;
  v_segment_id    uuid;
  v_news_tpl      uuid;
  v_course_tpl    uuid;
  v_schedule_id   uuid;
  v_topic_id      uuid;
  v_campaign_id   uuid;
begin
  ----------------------------------------------------------------------------
  raise notice '1. tables, columns and indexes exist';
  ----------------------------------------------------------------------------
  assert to_regclass('public.newsletter_schedules') is not null, 'newsletter_schedules is missing';
  assert to_regclass('public.newsletter_topics') is not null, 'newsletter_topics is missing';

  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='campaigns'
            and column_name in ('schedule_id', 'scheduled_for')) = 2,
         'campaigns.schedule_id / scheduled_for are missing';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='campaigns_schedule_occurrence_idx') = 1,
         'the one-campaign-per-occurrence index is missing';

  assert (select relrowsecurity from pg_class where oid = 'public.newsletter_schedules'::regclass),
         'RLS must be enabled on newsletter_schedules';
  assert (select relrowsecurity from pg_class where oid = 'public.newsletter_topics'::regclass),
         'RLS must be enabled on newsletter_topics';

  ----------------------------------------------------------------------------
  raise notice '2. fixtures';
  ----------------------------------------------------------------------------
  insert into public.segments (name, definition)
  values ('sched segment__schedverify', '{}'::jsonb)
  returning id into v_segment_id;

  insert into public.campaign_templates (name, provider_automation_id, slots, consent_stream)
  values ('news tpl__schedverify', 'auto-news', '[{"tag":"Headline"}]'::jsonb, 'newsletter')
  returning id into v_news_tpl;

  insert into public.campaign_templates (name, provider_automation_id, slots, consent_stream)
  values ('course tpl__schedverify', 'auto-course', '[{"tag":"Headline"}]'::jsonb, 'programs')
  returning id into v_course_tpl;

  ----------------------------------------------------------------------------
  raise notice '3. a schedule may only use a newsletter template';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    insert into public.newsletter_schedules (name, template_id, segment_id, frequency, next_run_at, goal)
    values ('course sched__schedverify', v_course_tpl, v_segment_id, 'weekly', now(), 'Fill intakes');
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'a schedule on a programs template must be rejected';

  insert into public.newsletter_schedules (name, template_id, segment_id, frequency, next_run_at, goal)
  values ('news sched__schedverify', v_news_tpl, v_segment_id, 'monthly', now(), 'Keep readers informed')
  returning id into v_schedule_id;

  v_failed := false;
  begin
    update public.newsletter_schedules set template_id = v_course_tpl where id = v_schedule_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 're-pointing a schedule at a programs template must be rejected';

  v_failed := false;
  begin
    insert into public.newsletter_schedules (name, template_id, segment_id, frequency, next_run_at, goal)
    values ('blank goal__schedverify', v_news_tpl, v_segment_id, 'weekly', now(), '   ');
  exception when check_violation then
    v_failed := true;
  end;
  assert v_failed, 'a schedule without a goal must be rejected';

  ----------------------------------------------------------------------------
  raise notice '4. one campaign per occurrence';
  ----------------------------------------------------------------------------
  insert into public.campaigns (name, segment_id, template_id, consent_stream, schedule_id, scheduled_for)
  values ('issue 1__schedverify', v_segment_id, v_news_tpl, 'newsletter', v_schedule_id, date '2026-10-01')
  returning id into v_campaign_id;

  v_failed := false;
  begin
    insert into public.campaigns (name, segment_id, template_id, consent_stream, schedule_id, scheduled_for)
    values ('issue 1 again__schedverify', v_segment_id, v_news_tpl, 'newsletter', v_schedule_id, date '2026-10-01');
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed, 'a second campaign for the same occurrence must be rejected - this is the cron idempotency guard';

  -- Hand-made campaigns are unaffected: many rows with a null schedule are fine.
  insert into public.campaigns (name, consent_stream) values ('manual a__schedverify', 'newsletter');
  insert into public.campaigns (name, consent_stream) values ('manual b__schedverify', 'newsletter');

  ----------------------------------------------------------------------------
  raise notice '5. topics';
  ----------------------------------------------------------------------------
  insert into public.newsletter_topics (schedule_id, title, position)
  values (v_schedule_id, 'AI in the workplace__schedverify', 1)
  returning id into v_topic_id;

  v_failed := false;
  begin
    insert into public.newsletter_topics (schedule_id, title) values (v_schedule_id, '  ');
  exception when check_violation then
    v_failed := true;
  end;
  assert v_failed, 'a topic without a title must be rejected';

  update public.newsletter_topics
  set used_at = now(), campaign_id = v_campaign_id
  where id = v_topic_id;

  -- Topics used to be deletable while unused. Since 20261001000000 removing one is a
  -- soft delete, a CHECK keeps a used topic from being removed, and no delete policy
  -- remains (see verify_20261001000000.sql).
  assert (select count(*) from pg_policies
          where schemaname='public' and tablename='newsletter_topics' and cmd='DELETE') = 0,
         'topics must not be physically deletable';

  raise notice 'All newsletter schedule checks passed.';
end $$;

rollback;
