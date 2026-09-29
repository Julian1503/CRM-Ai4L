-- Verification for migrations 20261002000000_crm_membership.sql and
-- 20261002000100_crm_membership_enforce.sql (audit C1, H1).
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end. Every fixture carries the suffix `__memberverify`.
--
-- Run with:
--   npm run db:verify -- membership
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- What this guards: a verified identity without an active membership reads and writes
-- nothing; members cannot promote themselves; nobody reads integration secrets through
-- PostgREST; the last administrator cannot be removed.

begin;

-- Fixtures, as the owner. Four identities the plan (section 4.1) asks CI to cover.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'admin__memberverify@example.invalid'),
  ('00000000-0000-4000-8000-0000000000b2', 'operator__memberverify@example.invalid'),
  ('00000000-0000-4000-8000-0000000000c3', 'unapproved__memberverify@example.invalid'),
  ('00000000-0000-4000-8000-0000000000d4', 'disabled__memberverify@example.invalid');

insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000000a1', 'admin', true),
  ('00000000-0000-4000-8000-0000000000b2', 'operator', true),
  ('00000000-0000-4000-8000-0000000000d4', 'operator', false);

insert into public.contacts (first_name, last_name, email)
  values ('Ada', 'Verify', 'ada__memberverify@example.invalid');

insert into public.credentials (key, value)
  values ('memberverify_secret', 'must-never-reach-a-browser')
  on conflict (key) do nothing;

do $$
begin
  ----------------------------------------------------------------------------
  raise notice '1. every public table has RLS and the restrictive membership policy';
  ----------------------------------------------------------------------------
  assert not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and not c.relrowsecurity
  ), 'a public table has RLS disabled';

  assert not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and c.relname <> 'crm_members'
       and not exists (
         select 1 from pg_policies p
          where p.schemaname = 'public'
            and p.tablename = c.relname
            and p.policyname = 'Approved CRM members only'
            and p.permissive = 'RESTRICTIVE'
       )
  ), 'a public table is missing the restrictive membership policy';

  assert not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'credentials' and permissive = 'PERMISSIVE'
  ), 'credentials still has a permissive policy';

  assert not has_table_privilege('authenticated', 'public.credentials', 'select'),
         'authenticated can still select credentials';
  assert not has_table_privilege('anon', 'public.contacts', 'select'),
         'anon can select contacts';
  assert not has_function_privilege('anon', 'public.create_campaign_booking(text, uuid, uuid, timestamptz)', 'execute'),
         'anon can execute create_campaign_booking';
end $$;

----------------------------------------------------------------------------
-- 2. Anonymous: nothing.
----------------------------------------------------------------------------
set local role anon;
do $$
declare
  v_failed boolean := false;
begin
  begin
    perform 1 from public.contacts limit 1;
  exception when insufficient_privilege then
    v_failed := true;
  end;
  assert v_failed, 'anon read contacts';
end $$;
reset role;

----------------------------------------------------------------------------
-- 3. Authenticated but never approved (self-registered): nothing.
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000c3","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_failed boolean := false;
begin
  assert not public.is_crm_member(), 'an unapproved user counts as a member';
  assert (select count(*) from public.contacts) = 0, 'an unapproved user read contacts';
  assert (select count(*) from public.active_contacts) = 0, 'an unapproved user read active_contacts';
  assert (select count(*) from public.job_types) = 0, 'an unapproved user read reference data';

  begin
    insert into public.contacts (first_name, email) values ('Eve', 'eve__memberverify@example.invalid');
  exception when insufficient_privilege then
    v_failed := true;
  end;
  assert v_failed, 'an unapproved user inserted a contact';

  update public.contacts set first_name = 'Hacked' where email = 'ada__memberverify@example.invalid';
  assert not found, 'an unapproved user updated a contact';

  v_failed := false;
  begin
    insert into public.crm_members (user_id, role)
      values ('00000000-0000-4000-8000-0000000000c3', 'admin');
  exception when insufficient_privilege then
    v_failed := true;
  end;
  assert v_failed, 'an unapproved user granted themselves membership';

  v_failed := false;
  begin
    perform public.create_campaign_booking(repeat('a', 64), gen_random_uuid(), gen_random_uuid(), now() + interval '1 day');
  exception when insufficient_privilege then
    v_failed := true;
  end;
  assert v_failed, 'an unapproved user called create_campaign_booking';
end $$;
reset role;

----------------------------------------------------------------------------
-- 4. Disabled member: nothing, even with a valid session.
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000d4","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  assert not public.is_crm_member(), 'a disabled member counts as a member';
  assert (select count(*) from public.contacts) = 0, 'a disabled member read contacts';
end $$;
reset role;

----------------------------------------------------------------------------
-- 5. Operator: daily work, no secrets, no self-promotion.
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_failed boolean := false;
begin
  assert public.is_crm_member(), 'an operator is not a member';
  assert not public.is_crm_admin(), 'an operator counts as an admin';
  assert (select count(*) from public.contacts where email = 'ada__memberverify@example.invalid') = 1,
         'an operator cannot read contacts';

  update public.contacts set notes = 'seen' where email = 'ada__memberverify@example.invalid';
  assert found, 'an operator cannot update contacts';

  assert (select count(*) from public.crm_members) = 1,
         'an operator can see other members';

  begin
    perform 1 from public.credentials limit 1;
  exception when insufficient_privilege then
    v_failed := true;
  end;
  assert v_failed, 'an operator read integration credentials';

  update public.crm_members set role = 'admin' where user_id = '00000000-0000-4000-8000-0000000000b2';
  assert not found, 'an operator promoted themselves';
end $$;
reset role;

----------------------------------------------------------------------------
-- 6. Admin: manages membership; still no secrets through PostgREST; last admin kept.
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_failed boolean := false;
begin
  assert public.is_crm_admin(), 'the admin is not an admin';
  assert (select count(*) from public.crm_members where user_id::text like '00000000-0000-4000-8000-0000000000%') = 3,
         'an admin cannot see all members';

  begin
    perform 1 from public.credentials limit 1;
  exception when insufficient_privilege then
    v_failed := true;
  end;
  assert v_failed, 'an admin read raw credentials through PostgREST';

  update public.crm_members set active = false where user_id = '00000000-0000-4000-8000-0000000000b2';
  assert found, 'an admin cannot disable a member';
end $$;
reset role;

do $$
declare
  v_failed boolean := false;
begin
  -- Only this transaction's admin fixture may remain active for the guard to bite.
  update public.crm_members set active = false
   where role = 'admin' and user_id <> '00000000-0000-4000-8000-0000000000a1';

  begin
    update public.crm_members set active = false where user_id = '00000000-0000-4000-8000-0000000000a1';
  exception when sqlstate '23514' then
    v_failed := true;
  end;
  assert v_failed, 'the last active administrator was disabled';

  raise notice 'All membership checks passed.';
end $$;

rollback;
