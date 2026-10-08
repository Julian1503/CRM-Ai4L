-- Verification for 20261008010000_campaign_test_sends.sql (UX plan P0.2).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__testsendverify`.
--
-- Run with:  npm run db:verify -- testsends
--
-- What this guards: a test send is recorded with evidence the database stamps from the
-- campaign; a stale revision is refused; at most 5 per campaign per hour; a row is
-- settled exactly once and is otherwise immutable; nothing is ever deleted; anon cannot
-- read it; members record only their own; non-members are refused; recording a test
-- touches no run, ledger row or booking and does not change the campaign.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000e0b01', 'operator__testsendverify@example.invalid'),
  ('00000000-0000-4000-8000-0000000e0b02', 'outsider__testsendverify@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000e0b01', 'operator', true);

insert into public.campaigns (id, name, provider_automation_id, consent_stream, merge_fields)
values ('00000000-0000-4000-8000-0000000e0c01', 'Campaign __testsendverify', 'auto-test', 'newsletter', '{"Headline":"Hi"}');

do $$
begin
  raise notice '1. privileges';
  assert not has_table_privilege('anon', 'public.campaign_test_sends', 'select'), 'anon can read test sends';
  assert not has_table_privilege('authenticated', 'public.campaign_test_sends', 'delete'), 'members can delete test sends';
  assert not has_table_privilege('service_role', 'public.campaign_test_sends', 'delete'), 'the service role can delete test sends';
  assert not has_column_privilege('authenticated', 'public.campaign_test_sends', 'revision', 'update'),
         'members can rewrite the tested revision';
  assert (select relrowsecurity from pg_class where oid = 'public.campaign_test_sends'::regclass), 'RLS is off';
  assert exists (select 1 from pg_policies where tablename = 'campaign_test_sends'
                  and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'),
         'membership is not enforced';
end $$;

-- A member records and settles a test send.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000e0b01","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_row     public.campaign_test_sends;
  v_failed  boolean := false;
  v_hint    text;
  i         integer;
begin
  raise notice '2. the database stamps the evidence';
  insert into public.campaign_test_sends (campaign_id, revision, recipient, outcome, cta_mode, provider_automation_id, actor_id)
  values ('00000000-0000-4000-8000-0000000e0c01', 1, 'qa@example.invalid', 'sent', 'none', 'forged',
          '00000000-0000-4000-8000-0000000e0b02')
  returning * into v_row;
  assert v_row.outcome = 'pending', 'a test send was recorded as settled before the provider call';
  assert v_row.cta_mode = 'booking' and v_row.provider_automation_id = 'auto-test',
         'evidence was taken from the caller, not the campaign';
  assert v_row.actor_id = '00000000-0000-4000-8000-0000000e0b01', 'the actor was not the member';
  assert v_row.content_snapshot_id is null and v_row.content_hash is null, 'legacy test carries a snapshot';

  raise notice '3. settled once, then immutable';
  update public.campaign_test_sends set outcome = 'sent', provider_reference = 'ref' where id = v_row.id;
  assert (select completed_at is not null from public.campaign_test_sends where id = v_row.id), 'settling left no time';
  begin
    update public.campaign_test_sends set outcome = 'failed' where id = v_row.id;
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a settled test send changed';

  v_failed := false;
  begin
    delete from public.campaign_test_sends where id = v_row.id;
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'a test send was deleted';

  raise notice '4. a stale revision is refused';
  v_failed := false;
  begin
    insert into public.campaign_test_sends (campaign_id, revision, recipient)
    values ('00000000-0000-4000-8000-0000000e0c01', 7, 'qa@example.invalid');
  exception when sqlstate 'CRM06' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'stale_revision', 'a test of another revision was recorded';

  raise notice '5. a malformed recipient is refused';
  v_failed := false;
  begin
    insert into public.campaign_test_sends (campaign_id, revision, recipient)
    values ('00000000-0000-4000-8000-0000000e0c01', 1, 'Not An Email');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a malformed recipient was recorded';

  raise notice '6. at most 5 per campaign per hour';
  for i in 1..4 loop
    insert into public.campaign_test_sends (campaign_id, revision, recipient)
    values ('00000000-0000-4000-8000-0000000e0c01', 1, 'qa@example.invalid');
  end loop;
  v_failed := false;
  begin
    insert into public.campaign_test_sends (campaign_id, revision, recipient)
    values ('00000000-0000-4000-8000-0000000e0c01', 1, 'qa@example.invalid');
  exception when sqlstate 'CRM09' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'test_send_rate_limited', 'a sixth test send in an hour was recorded';

  raise notice '7. not a delivery';
  assert not exists (select 1 from public.campaign_runs where campaign_id = '00000000-0000-4000-8000-0000000e0c01'),
         'a test send created a run';
  assert not exists (select 1 from public.campaign_sends where campaign_id = '00000000-0000-4000-8000-0000000e0c01'),
         'a test send created a ledger row';
  assert not exists (select 1 from public.bookings where campaign_id = '00000000-0000-4000-8000-0000000e0c01'),
         'a test send created a booking';
  assert (select status = 'draft' and revision = 1 and approved_revision is null
            from public.campaigns where id = '00000000-0000-4000-8000-0000000e0c01'),
         'a test send changed the campaign';
end $$;

reset role;

-- A non-member cannot record or read test sends.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000e0b02","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_failed boolean := false;
begin
  raise notice '8. non-members are refused';
  assert (select count(*) from public.campaign_test_sends) = 0, 'a non-member read test sends';
  begin
    insert into public.campaign_test_sends (campaign_id, revision, recipient)
    values ('00000000-0000-4000-8000-0000000e0c01', 1, 'qa@example.invalid');
  -- Refused by RLS, or earlier: the campaign is invisible to a non-member.
  exception when insufficient_privilege or sqlstate 'P0002' then v_failed := true;
  end;
  assert v_failed, 'a non-member recorded a test send';
end $$;

reset role;

-- The service role cannot delete either, and a pending row can only be settled once.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_failed boolean := false;
begin
  raise notice '9. the service role cannot delete or rewrite';
  begin
    delete from public.campaign_test_sends where campaign_id = '00000000-0000-4000-8000-0000000e0c01';
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'the service role deleted test sends';

  v_failed := false;
  begin
    update public.campaign_test_sends set recipient = 'other@example.invalid'
     where campaign_id = '00000000-0000-4000-8000-0000000e0c01' and outcome = 'pending';
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a pending test send was rewritten instead of settled';
end $$;

rollback;
