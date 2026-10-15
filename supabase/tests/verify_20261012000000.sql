-- Verification for 20261012000000_cron_runs.sql.
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK.
--
-- Run with:  npm run db:verify -- cronruns
--
-- What this guards: the service role records runs; members can read them and nothing
-- else; anon sees nothing; rows are append-only (no update, no delete); bad values are
-- refused.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000f0b01', 'operator__cronverify@example.invalid'),
  ('00000000-0000-4000-8000-0000000f0b02', 'outsider__cronverify@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000f0b01', 'operator', true);

do $$
begin
  raise notice '1. privileges';
  assert not has_table_privilege('anon', 'public.cron_runs', 'select'), 'anon can read cron runs';
  assert not has_table_privilege('authenticated', 'public.cron_runs', 'insert'), 'members can record cron runs';
  assert not has_table_privilege('authenticated', 'public.cron_runs', 'delete'), 'members can delete cron runs';
  assert not has_table_privilege('service_role', 'public.cron_runs', 'delete'), 'the service role can delete cron runs';
  assert not has_table_privilege('service_role', 'public.cron_runs', 'update'), 'the service role can rewrite cron runs';
  assert (select relrowsecurity from pg_class where oid = 'public.cron_runs'::regclass), 'RLS is off';
  assert exists (select 1 from pg_policies where tablename = 'cron_runs'
                  and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'),
         'membership is not enforced';
end $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_id     uuid;
  v_failed boolean := false;
begin
  raise notice '2. the service role records a run';
  insert into public.cron_runs (job, status, started_at, summary)
  values ('jobs', 'succeeded', timezone('utc'::text, now()) - interval '1 minute', '{"campaigns":1}')
  returning id into v_id;

  raise notice '3. append-only';
  begin
    update public.cron_runs set status = 'failed' where id = v_id;
  exception when insufficient_privilege or sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a cron run was rewritten';

  raise notice '4. bad values are refused';
  v_failed := false;
  begin
    insert into public.cron_runs (job, status, started_at) values ('backup', 'succeeded', timezone('utc'::text, now()));
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'an unknown job was recorded';

  v_failed := false;
  begin
    insert into public.cron_runs (job, status, started_at, error_code)
    values ('jobs', 'failed', timezone('utc'::text, now()), 'Error: connection to 10.0.0.1 refused');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'free error text was recorded';
end $$;

reset role;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000f0b01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  raise notice '5. members read runs';
  assert (select count(*) from public.cron_runs where summary ? 'campaigns') >= 1, 'a member cannot read cron runs';
end $$;

reset role;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000f0b02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  raise notice '6. non-members read nothing';
  assert (select count(*) from public.cron_runs) = 0, 'a non-member read cron runs';
end $$;

rollback;
