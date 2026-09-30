-- Verification for 20261006000000_contact_tags.sql and
-- 20261006010000_import_contact_tags.sql (client features B and D).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__tagverify`.
--
-- Run with:  npm run db:verify -- tags
--
-- What this guards: only approved members see or change tags; bulk tagging is atomic,
-- idempotent and moves a revision only on an effective change; save_contact keeps tags
-- when p_tags is null and has no ambiguous overload; imports only add tags, preview
-- without writing, and refuse a preview made stale by the tag catalog; a payload
-- without tags behaves as before; the industry filter key ignores case and spaces.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a0b2', 'operator__tagverify@example.invalid'),
  ('00000000-0000-4000-8000-00000000a0c3', 'unapproved__tagverify@example.invalid');

insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-00000000a0b2', 'operator', true);

insert into public.contacts (first_name, last_name, email) values
  ('Ada', 'Verify', 'ada__tagverify@example.invalid'),
  ('Bob', 'Verify', 'bob__tagverify@example.invalid'),
  ('Cy', 'Verify', 'archived__tagverify@example.invalid');
update public.contacts set deleted_at = now(), status = 'archived'
 where email = 'archived__tagverify@example.invalid';

insert into public.tags (name) values ('Seed __tagverify');

----------------------------------------------------------------------------
-- 1. Schema and privileges
----------------------------------------------------------------------------
do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.tags'::regclass), 'tags has no RLS';
  assert (select relrowsecurity from pg_class where oid = 'public.contact_tags'::regclass), 'contact_tags has no RLS';
  assert exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tags'
                  and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'),
         'tags lacks the restrictive membership policy';
  assert exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_tags'
                  and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'),
         'contact_tags lacks the restrictive membership policy';
  assert not has_table_privilege('anon', 'public.tags', 'select'), 'anon can read tags';
  assert not has_table_privilege('anon', 'public.contact_tags', 'select'), 'anon can read contact_tags';
  assert not has_table_privilege('authenticated', 'public.tags', 'delete'), 'tags can be physically deleted';
  assert not has_function_privilege('anon', 'public.apply_contact_tags(uuid[], uuid[], text)', 'execute'),
         'anon can execute apply_contact_tags';
  assert not has_function_privilege('anon', 'public.save_contact(jsonb, uuid[], integer, uuid[])', 'execute'),
         'anon can execute save_contact';
  -- The three-argument signature is gone, so existing calls resolve to one function.
  assert (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'save_contact') = 1,
         'save_contact has more than one overload';
end $$;

----------------------------------------------------------------------------
-- 2. Authenticated but never approved: no tags, no bulk action
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a0c3","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_failed boolean := false;
begin
  assert (select count(*) from public.tags) = 0, 'an unapproved user read tags';

  begin
    insert into public.tags (name) values ('Eve __tagverify');
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'an unapproved user created a tag';

  v_failed := false;
  begin
    perform public.apply_contact_tags(array[gen_random_uuid()], array[gen_random_uuid()], 'add');
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'an unapproved user called apply_contact_tags';
end $$;
reset role;

----------------------------------------------------------------------------
-- 3. Operator
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a0b2","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_failed   boolean;
  v_hint     text;
  v_ada      uuid := (select id from public.contacts where email = 'ada__tagverify@example.invalid');
  v_bob      uuid := (select id from public.contacts where email = 'bob__tagverify@example.invalid');
  v_archived uuid := (select id from public.contacts where email = 'archived__tagverify@example.invalid');
  v_vip      uuid;
  v_extra    uuid;
  v_rev      integer;
  v_result   jsonb;
  v_saved    jsonb;
  v_preview  jsonb;
  v_many     uuid[];
  v_i        integer;
begin
  ----------------------------------------------------------------------------
  raise notice '3.1 create_tag normalises and finds an existing name';
  ----------------------------------------------------------------------------
  v_result := public.create_tag('  VIP   __tagverify ');
  assert (v_result->>'created')::boolean, 'create_tag did not create';
  assert v_result->'tag'->>'name' = 'VIP __tagverify', format('not normalised: %s', v_result);
  v_vip := (v_result->'tag'->>'id')::uuid;

  v_result := public.create_tag('vip __TAGVERIFY');
  assert not (v_result->>'created')::boolean and (v_result->'tag'->>'id')::uuid = v_vip,
         'a differently cased name created a second tag';

  v_failed := false;
  begin
    perform public.create_tag(repeat('x', 81));
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an 81-character tag was accepted';

  v_extra := (public.create_tag('Extra __tagverify')->'tag'->>'id')::uuid;

  ----------------------------------------------------------------------------
  raise notice '3.2 apply_contact_tags adds idempotently and moves revision only on change';
  ----------------------------------------------------------------------------
  v_rev := (select revision from public.contacts where id = v_ada);
  v_result := public.apply_contact_tags(array[v_ada, v_bob], array[v_vip], 'add');
  assert (v_result->>'updated')::int = 2, format('unexpected add result %s', v_result);
  assert (select revision from public.contacts where id = v_ada) = v_rev + 1, 'add did not move the revision';

  v_result := public.apply_contact_tags(array[v_ada, v_bob], array[v_vip], 'add');
  assert (v_result->>'updated')::int = 0, 'repeating an add changed something';
  assert (select revision from public.contacts where id = v_ada) = v_rev + 1, 'a no-op add moved the revision';

  v_result := public.apply_contact_tags(array[v_bob], array[v_vip, v_extra], 'remove');
  assert (v_result->>'updated')::int = 1, format('unexpected remove result %s', v_result);
  assert not exists (select 1 from public.contact_tags where contact_id = v_bob), 'remove left a tag';
  assert exists (select 1 from public.contact_tags where contact_id = v_ada and tag_id = v_vip),
         'remove touched an unselected contact';

  ----------------------------------------------------------------------------
  raise notice '3.3 a stale selection writes nothing';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    perform public.apply_contact_tags(array[v_bob, v_archived], array[v_extra], 'add');
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'an archived contact was accepted';
  assert not exists (select 1 from public.contact_tags where contact_id = v_bob), 'a refused batch wrote';

  v_failed := false;
  begin
    perform public.apply_contact_tags(array[v_bob], array[v_extra, gen_random_uuid()], 'add');
  exception when sqlstate 'CRM07' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'stale_tags', 'an unknown tag was accepted or not flagged stale';

  v_failed := false;
  begin
    perform public.apply_contact_tags('{}', array[v_extra], 'add');
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an empty selection was accepted';

  ----------------------------------------------------------------------------
  raise notice '3.4 at most 50 tags per contact';
  ----------------------------------------------------------------------------
  select array_agg((public.create_tag(format('Bulk %s __tagverify', g))->'tag'->>'id')::uuid)
    into v_many from generate_series(1, 50) g;
  v_failed := false;
  begin
    -- Ada already has VIP: 1 + 50 = 51.
    perform public.apply_contact_tags(array[v_ada], v_many, 'add');
  exception when sqlstate 'CRM07' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'tag_limit', 'a 51st tag was accepted';
  assert (select count(*) from public.contact_tags where contact_id = v_ada) = 1, 'the refused add wrote';

  ----------------------------------------------------------------------------
  raise notice '3.5 save_contact: null keeps tags, a set replaces, [] clears';
  ----------------------------------------------------------------------------
  v_rev := (select revision from public.contacts where id = v_ada);
  -- Three positional arguments, as every existing caller sends: must still resolve.
  v_saved := public.save_contact(
    jsonb_build_object('id', v_ada, 'first_name', 'Ada', 'last_name', 'Verify',
                       'email', 'ada__tagverify@example.invalid', 'status', 'prospect'),
    '{}', v_rev);
  assert jsonb_array_length(v_saved->'tags') = 1, format('null p_tags dropped tags: %s', v_saved->'tags');

  v_saved := public.save_contact(
    jsonb_build_object('id', v_ada, 'first_name', 'Ada', 'last_name', 'Verify',
                       'email', 'ada__tagverify@example.invalid', 'status', 'prospect'),
    '{}', (v_saved->>'revision')::int, array[v_extra]);
  assert (select array_agg(tag_id) from public.contact_tags where contact_id = v_ada) = array[v_extra],
         'p_tags did not replace the set';

  v_failed := false;
  begin
    perform public.save_contact(
      jsonb_build_object('id', v_ada, 'first_name', 'Renamed', 'last_name', 'Verify',
                         'email', 'ada__tagverify@example.invalid', 'status', 'prospect'),
      '{}', (v_saved->>'revision')::int, array[gen_random_uuid()]);
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an unknown tag was saved';
  assert (select first_name from public.contacts where id = v_ada) = 'Ada', 'the refused save changed the contact';

  v_saved := public.save_contact(
    jsonb_build_object('id', v_ada, 'first_name', 'Ada', 'last_name', 'Verify',
                       'email', 'ada__tagverify@example.invalid', 'status', 'prospect'),
    '{}', (v_saved->>'revision')::int, '{}');
  assert not exists (select 1 from public.contact_tags where contact_id = v_ada), '[] did not clear tags';

  ----------------------------------------------------------------------------
  raise notice '3.6 a payload without tags previews and imports exactly as before';
  ----------------------------------------------------------------------------
  v_preview := public.preview_import_contacts(jsonb_build_array(jsonb_build_object(
    'email', 'ada__tagverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify')));
  assert not (v_preview ? 'tags_assigned') and not (v_preview ? 'tags_created'),
         format('an untagged preview reported tags: %s', v_preview);
  assert (v_preview->>'unchanged')::int = 1, format('unexpected untagged preview %s', v_preview);
  v_result := public.import_contacts(jsonb_build_array(jsonb_build_object(
    'email', 'ada__tagverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify')),
    v_preview->>'token');
  assert not (v_result ? 'tags_assigned'), format('an untagged import reported tags: %s', v_result);

  ----------------------------------------------------------------------------
  raise notice '3.7 a tag-only change previews as changed, without writing';
  ----------------------------------------------------------------------------
  v_preview := public.preview_import_contacts(jsonb_build_array(
    jsonb_build_object('email', 'ada__tagverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify',
                       'tag_names', jsonb_build_array('vip __tagverify', 'New  one __tagverify', 'NEW ONE __tagverify', ' ')),
    jsonb_build_object('email', 'archived__tagverify@example.invalid', 'first_name', 'Cy', 'last_name', 'Verify',
                       'tag_names', jsonb_build_array('Held __tagverify'))));
  assert (v_preview->>'changed')::int = 1 and (v_preview->>'tags_only_changed')::int = 1,
         format('a tag-only change was not counted: %s', v_preview);
  assert (v_preview->>'tags_assigned')::int = 1 and (v_preview->>'held_back')::int = 1,
         format('unexpected tag preview %s', v_preview);
  assert v_preview->'tags_created' = '["New one __tagverify"]'::jsonb,
         format('tags_created wrong (held-back tags must not count): %s', v_preview->'tags_created');
  assert not exists (select 1 from public.tags where lower(name) = 'new one __tagverify'), 'the preview created a tag';
  assert not exists (select 1 from public.contact_tags where contact_id = v_ada), 'the preview assigned a tag';

  ----------------------------------------------------------------------------
  raise notice '3.8 a tag created after the preview makes it stale';
  ----------------------------------------------------------------------------
  perform public.create_tag('New one __tagverify');
  v_failed := false;
  begin
    perform public.import_contacts(jsonb_build_array(
      jsonb_build_object('email', 'ada__tagverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify',
                         'tag_names', jsonb_build_array('vip __tagverify', 'New one __tagverify'))),
      v_preview->>'token');
  exception when sqlstate 'CRM08' then v_failed := true;
  end;
  assert v_failed, 'a preview made stale by the catalog was applied';

  ----------------------------------------------------------------------------
  raise notice '3.9 import creates and assigns, only adds, and is stable when repeated';
  ----------------------------------------------------------------------------
  perform public.apply_contact_tags(array[v_ada], array[v_extra], 'add');
  v_result := public.import_contacts(jsonb_build_array(
    jsonb_build_object('email', 'ada__tagverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify',
                       'tag_names', jsonb_build_array('vip __tagverify', 'Brand new __tagverify')),
    jsonb_build_object('email', 'carol__tagverify@example.invalid', 'first_name', 'Carol', 'last_name', 'Verify',
                       'tag_names', jsonb_build_array('BRAND NEW __tagverify'))));
  assert (v_result->>'tags_created')::int = 1 and (v_result->>'tags_assigned')::int = 2,
         format('unexpected tagged import %s', v_result);
  assert (select count(*) from public.contact_tags where contact_id = v_ada) = 3,
         'import did not keep Extra and add VIP and Brand new';
  assert (select name from public.tags where lower(name) = 'brand new __tagverify') = 'Brand new __tagverify',
         'the first spelling was not the one created';

  v_rev := (select revision from public.contacts where id = v_ada);
  v_result := public.import_contacts(jsonb_build_array(
    jsonb_build_object('email', 'ada__tagverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify',
                       'tag_names', jsonb_build_array('VIP __tagverify'))));
  assert (v_result->>'tags_assigned')::int = 0 and (v_result->>'tags_created')::int = 0,
         format('a repeated import changed tags: %s', v_result);
  assert (select count(*) from public.contact_tags where contact_id = v_ada) = 3, 'a repeated import changed the set';

  v_failed := false;
  begin
    perform public.preview_import_contacts(jsonb_build_array(jsonb_build_object(
      'email', 'ada__tagverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify',
      'tag_names', jsonb_build_array(repeat('y', 81)))));
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an 81-character imported tag was accepted';

  ----------------------------------------------------------------------------
  raise notice '3.10 the industry key ignores case and outer spaces';
  ----------------------------------------------------------------------------
  insert into public.organisations (name, industry) values
    ('Org A __tagverify', ' Health__tagverify '),
    ('Org B __tagverify', 'health__tagverify');
  assert (select count(*) from public.organisations where industry_key = 'health__tagverify') = 2,
         'industry_key does not normalise';
  assert (select count(*) from unnest(public.organisation_industries('health__tagverify')) i) = 1,
         'organisation_industries returned the same sector twice';
end $$;
reset role;

do $$ begin raise notice 'All contact tag checks passed.'; end $$;

rollback;
