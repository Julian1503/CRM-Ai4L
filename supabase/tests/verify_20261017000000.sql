-- Verification for 20261017000000_content_suggestions.sql.
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK.
--
-- Run with:  npm run db:verify -- suggestions
--
-- What this guards: members claim and settle their own requests only through the two
-- functions; the 51st request in a minute is refused with CRM10; a request settles once;
-- non-members and anon can neither claim nor read; bad values are refused.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000005e001', 'member__suggestverify@example.invalid'),
  ('00000000-0000-4000-8000-00000005e002', 'other__suggestverify@example.invalid'),
  ('00000000-0000-4000-8000-00000005e003', 'outsider__suggestverify@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-00000005e001', 'operator', true),
  ('00000000-0000-4000-8000-00000005e002', 'operator', true);

do $$
begin
  raise notice '1. privileges';
  assert not has_table_privilege('anon', 'public.content_suggestion_requests', 'select'), 'anon can read suggestions';
  assert not has_table_privilege('authenticated', 'public.content_suggestion_requests', 'insert'), 'members insert directly';
  assert not has_table_privilege('authenticated', 'public.content_suggestion_requests', 'update'), 'members update directly';
  assert not has_table_privilege('authenticated', 'public.content_suggestion_requests', 'delete'), 'members delete';
  assert not has_function_privilege('anon', 'public.claim_content_suggestion(text, text)', 'execute'), 'anon can claim';
  assert (select relrowsecurity from pg_class where oid = 'public.content_suggestion_requests'::regclass), 'RLS is off';
  assert exists (select 1 from pg_policies where tablename = 'content_suggestion_requests'
                  and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'),
         'membership is not enforced';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000005e001","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_hash   text := repeat('a', 64);
  v_id     uuid;
  v_failed boolean := false;
  v_row    public.content_suggestion_requests;
begin
  raise notice '2. a member claims and settles a request';
  v_id := public.claim_content_suggestion('image_prompts', v_hash);
  perform public.finish_content_suggestion(v_id, 'succeeded', '{"suggestions":[]}', 'mock', 'v1', '{"promptTokens":3}', 120, null);
  select * into v_row from public.content_suggestion_requests where id = v_id;
  assert v_row.status = 'succeeded' and v_row.finished_at is not null and v_row.usage ->> 'promptTokens' = '3',
         'the request was not settled';

  raise notice '3. a request settles once';
  begin
    perform public.finish_content_suggestion(v_id, 'failed', null, null, null, null, null, 'x');
  exception when sqlstate 'P0002' then v_failed := true;
  end;
  assert v_failed, 'a settled request was settled again';

  raise notice '4. a succeeded request needs a result; unknown kinds are refused';
  v_id := public.claim_content_suggestion('content_ideas', v_hash);
  v_failed := false;
  begin
    perform public.finish_content_suggestion(v_id, 'succeeded', null, 'mock', 'v1', '{}', 10, null);
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a succeeded request has no result';
  v_failed := false;
  begin
    perform public.claim_content_suggestion('poems', v_hash);
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'an unknown kind was claimed';
  v_failed := false;
  begin
    perform public.claim_content_suggestion('content_ideas', 'not-a-hash');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a malformed context hash was claimed';
end $$;

do $$
declare
  v_failed boolean := false;
begin
  raise notice '5. the 51st request in a minute is refused';
  -- Two requests were taken above (one of them still pending); take 48 more.
  for i in 1..48 loop
    perform public.claim_content_suggestion('rewrite_instructions', repeat('b', 64));
  end loop;
  begin
    perform public.claim_content_suggestion('rewrite_instructions', repeat('b', 64));
  exception when sqlstate 'CRM10' then v_failed := true;
  end;
  assert v_failed, 'the rate limit did not hold';
end $$;

reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000005e002","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_failed boolean := false;
  v_other  uuid;
begin
  raise notice '6. another member has their own limit, reads the shared cache, cannot settle others';
  perform public.claim_content_suggestion('rewrite_instructions', repeat('b', 64));
  assert (select count(*) from public.content_suggestion_requests where status = 'succeeded') = 1,
         'the shared cache is not readable';
  select id into v_other from public.content_suggestion_requests
   where requested_by = '00000000-0000-4000-8000-00000005e001' and status = 'pending' limit 1;
  begin
    perform public.finish_content_suggestion(v_other, 'failed', null, null, null, null, null, 'x');
  exception when sqlstate 'P0002' then v_failed := true;
  end;
  assert v_failed, 'a member settled another member''s request';
end $$;

reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000005e003","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_failed boolean := false;
begin
  raise notice '7. non-members can neither claim nor read';
  begin
    perform public.claim_content_suggestion('content_ideas', repeat('c', 64));
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'a non-member claimed a suggestion';
  assert (select count(*) from public.content_suggestion_requests) = 0, 'a non-member read suggestions';
end $$;

rollback;
