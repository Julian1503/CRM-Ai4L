-- Verification for 20261008000000_newsletter_schedule_occurrences.sql (audit H12).
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end. Every fixture carries the suffix `__occurrenceverify`.
--
-- Run with:
--   npm run db:verify -- occurrences
--
-- Two concurrent schedulers and the full draft path (template, campaign, copy) need
-- real separate connections; they live in
-- src/lib/marketing/schedules/occurrences.integration.test.ts (npm run test:integration).

begin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_failed    boolean;
  v_segment   uuid;
  v_template  uuid;
  v_schedule  uuid;
  v_due       timestamptz := date_trunc('minute', now()) - interval '21 days';
  v_result    jsonb;
  v_pending   uuid;
  v_claimed   public.newsletter_schedule_occurrences;
  v_status    text;
  v_campaign  uuid;
  v_count     integer;
begin
  insert into public.segments (name) values ('Segment __occurrenceverify') returning id into v_segment;
  insert into public.campaign_templates (name, provider_automation_id, slots, consent_stream)
    values ('Template __occurrenceverify', 'auto__occurrenceverify', '[{"tag":"Headline"}]'::jsonb, 'newsletter') returning id into v_template;
  insert into public.newsletter_schedules (name, template_id, segment_id, frequency, next_run_at, goal)
    values ('Schedule __occurrenceverify', v_template, v_segment, 'weekly', v_due, 'Verify')
    returning id into v_schedule;

  ----------------------------------------------------------------------------
  raise notice '1. recording advances next_run_at in the same transaction; catch-up keeps the latest';
  ----------------------------------------------------------------------------
  v_result := public.record_newsletter_occurrences(
    v_schedule, v_due, v_due + interval '28 days',
    jsonb_build_array(
      jsonb_build_object('scheduledFor', (v_due)::date, 'dueAt', v_due),
      jsonb_build_object('scheduledFor', (v_due + interval '7 days')::date, 'dueAt', v_due + interval '7 days'),
      jsonb_build_object('scheduledFor', (v_due + interval '14 days')::date, 'dueAt', v_due + interval '14 days')
    ));
  assert v_result ->> 'outcome' = 'recorded', 'occurrences were not recorded';
  assert (v_result ->> 'skipped')::int = 2, 'older missed occurrences were not recorded as skipped';
  v_pending := (v_result ->> 'pendingId')::uuid;
  assert (select scheduled_for from public.newsletter_schedule_occurrences where id = v_pending) = (v_due + interval '14 days')::date,
         'the pending occurrence is not the most recent one';
  assert (select count(*) from public.newsletter_schedule_occurrences
           where schedule_id = v_schedule and status = 'skipped' and skip_reason is not null) = 2,
         'skipped occurrences carry no reason';
  assert (select next_run_at from public.newsletter_schedules where id = v_schedule) = v_due + interval '28 days',
         'next_run_at was not advanced with the occurrences';

  ----------------------------------------------------------------------------
  raise notice '2. a second scheduler holding the old next_run_at records nothing';
  ----------------------------------------------------------------------------
  v_result := public.record_newsletter_occurrences(
    v_schedule, v_due, v_due + interval '28 days',
    jsonb_build_array(jsonb_build_object('scheduledFor', (v_due)::date, 'dueAt', v_due)));
  assert v_result ->> 'outcome' = 'claimed_elsewhere', 'a stale scheduler recorded again';
  assert (select count(*) from public.newsletter_schedule_occurrences where schedule_id = v_schedule) = 3,
         'a stale scheduler created occurrences';

  ----------------------------------------------------------------------------
  raise notice '3. bad input is refused and changes nothing';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    perform public.record_newsletter_occurrences(
      v_schedule, v_due + interval '28 days', v_due + interval '35 days',
      jsonb_build_array(jsonb_build_object('scheduledFor', (v_due + interval '28 days')::date, 'dueAt', v_due + interval '28 days')));
  exception when sqlstate '22023' then v_failed := true;
  end;
  assert v_failed, 'a future occurrence was recorded';

  ----------------------------------------------------------------------------
  raise notice '4. claim leases one occurrence; a second claim gets nothing';
  ----------------------------------------------------------------------------
  select * into v_claimed from public.claim_newsletter_occurrences(5, 60, null) where schedule_id = v_schedule;
  assert v_claimed.id = v_pending and v_claimed.status = 'drafting' and v_claimed.attempts = 1,
         'the pending occurrence was not leased';
  select count(*) into v_count from public.claim_newsletter_occurrences(5, 60, null) where schedule_id = v_schedule;
  assert v_count = 0, 'a leased occurrence was claimed twice';

  ----------------------------------------------------------------------------
  raise notice '5. a retryable failure goes back to pending with backoff; the old token is refused';
  ----------------------------------------------------------------------------
  v_status := public.fail_newsletter_occurrence(v_pending, v_claimed.claim_token, 'template read failed', true);
  assert v_status = 'pending', 'a retryable failure was not requeued';
  assert (select next_attempt_at > now() and last_error = 'template read failed'
            from public.newsletter_schedule_occurrences where id = v_pending), 'no backoff or error recorded';
  assert public.fail_newsletter_occurrence(v_pending, v_claimed.claim_token, 'x', true) = 'lost',
         'a stale token could fail the occurrence';

  ----------------------------------------------------------------------------
  raise notice '6. an expired lease is retryable; after max attempts it is failed, visibly';
  ----------------------------------------------------------------------------
  update public.newsletter_schedule_occurrences set next_attempt_at = now() where id = v_pending;
  select * into v_claimed from public.claim_newsletter_occurrences(5, 60, v_pending);
  update public.newsletter_schedule_occurrences set lease_expires_at = now() - interval '1 second' where id = v_pending;
  select * into v_claimed from public.claim_newsletter_occurrences(5, 60, v_pending);
  assert v_claimed.attempts = 3, 'an expired lease was not reclaimable';
  update public.newsletter_schedule_occurrences set lease_expires_at = now() - interval '1 second' where id = v_pending;
  select count(*) into v_count from public.claim_newsletter_occurrences(5, 60, v_pending);
  assert v_count = 0, 'an occurrence was claimed past its attempts';
  assert (select status = 'failed' and last_error like '%lease%' from public.newsletter_schedule_occurrences where id = v_pending),
         'an exhausted lease did not become failed with a reason';

  ----------------------------------------------------------------------------
  raise notice '7. complete requires the occurrence''s own campaign and the current token';
  ----------------------------------------------------------------------------
  insert into public.campaigns (name, segment_id, provider_automation_id, consent_stream, schedule_id, scheduled_for)
    values ('Campaign __occurrenceverify', v_segment, 'auto__occurrenceverify', 'newsletter', v_schedule, (v_due)::date)
    returning id into v_campaign;
  update public.newsletter_schedule_occurrences
     set status = 'pending', attempts = 0, next_attempt_at = now(), skip_reason = null, finished_at = null
   where schedule_id = v_schedule and scheduled_for = (v_due)::date;
  select * into v_claimed from public.claim_newsletter_occurrences(5, 60, null) where schedule_id = v_schedule;
  v_failed := false;
  begin
    perform public.complete_newsletter_occurrence(v_claimed.id, v_claimed.claim_token, gen_random_uuid());
  exception when sqlstate '22023' then v_failed := true;
  end;
  assert v_failed, 'an occurrence was completed with someone else''s campaign';
  assert public.complete_newsletter_occurrence(v_claimed.id, v_claimed.claim_token, v_campaign),
         'the lease holder could not complete';
  assert (select status = 'drafted' and campaign_id = v_campaign from public.newsletter_schedule_occurrences where id = v_claimed.id),
         'the occurrence was not recorded as drafted';
  assert not public.complete_newsletter_occurrence(v_claimed.id, v_claimed.claim_token, v_campaign),
         'a finished occurrence was completed twice';

  ----------------------------------------------------------------------------
  raise notice '8. a non-retryable failure is failed at once';
  ----------------------------------------------------------------------------
  update public.newsletter_schedule_occurrences
     set status = 'pending', attempts = 0, next_attempt_at = now(), skip_reason = null, finished_at = null
   where schedule_id = v_schedule and scheduled_for = (v_due + interval '7 days')::date;
  select * into v_claimed from public.claim_newsletter_occurrences(5, 60, null) where schedule_id = v_schedule;
  assert public.fail_newsletter_occurrence(v_claimed.id, v_claimed.claim_token, 'template_unusable', false) = 'failed',
         'a non-retryable failure was requeued';

  ----------------------------------------------------------------------------
  raise notice '9. a paused schedule''s occurrences wait';
  ----------------------------------------------------------------------------
  update public.newsletter_schedule_occurrences
     set status = 'pending', attempts = 0, next_attempt_at = now(), finished_at = null
   where id = v_pending;
  update public.newsletter_schedules set is_active = false where id = v_schedule;
  select count(*) into v_count from public.claim_newsletter_occurrences(5, 60, v_pending);
  assert v_count = 0, 'an occurrence of a paused schedule was claimed';
  update public.newsletter_schedules set is_active = true where id = v_schedule;

  ----------------------------------------------------------------------------
  raise notice '10. no physical delete path';
  ----------------------------------------------------------------------------
  assert not has_table_privilege('authenticated', 'public.newsletter_schedule_occurrences', 'DELETE'),
         'members can delete occurrences';
  assert not has_table_privilege('authenticated', 'public.newsletter_schedule_occurrences', 'UPDATE'),
         'members can write occurrences directly';
  assert not has_function_privilege('anon', 'public.retry_newsletter_occurrence(uuid)', 'EXECUTE'),
         'anon can retry occurrences';
  assert exists (select 1 from pg_policies where tablename = 'newsletter_schedule_occurrences'
                   and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'),
         'the restrictive membership policy is missing';
end;
$$;

----------------------------------------------------------------------------
-- 11. The operator retry is member-only: the service role (no member) is refused.
----------------------------------------------------------------------------
do $$
declare
  v_failed boolean := false;
begin
  begin
    perform public.retry_newsletter_occurrence(gen_random_uuid());
  exception when sqlstate '42501' then v_failed := true;
  end;
  assert v_failed, 'retry did not require a CRM member';
end;
$$;

rollback;
