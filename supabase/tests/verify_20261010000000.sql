-- Verification for 20261010000000_segment_tag_criteria.sql (saved groups by tag).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__segtagverify`.
--
-- Run with:  npm run db:verify -- segtags
--
-- What this guards: segment_contacts() still returns the same rows and columns (in the
-- same order), now with each contact's tag ids; exclusions, inclusions and archiving
-- behave exactly as before; the tag criteria the application builds (`tag_ids && ...`,
-- `not tag_ids && ...`) select the right people and never bypass consent; a tag removed
-- from the catalogue leaves a saved segment working (it matches nobody); anon cannot
-- execute the function.

begin;

do $$
declare
  v_segment  uuid;
  v_vip      uuid;
  v_workshop uuid;
  v_both     uuid;
  v_vip_only uuid;
  v_none     uuid;
  v_courses  uuid;
  v_archived uuid;
  v_ids      uuid[];
  v_columns  text;
begin
  raise notice '1. shape and access';
  select string_agg(name, ',' order by ord) into v_columns
    from unnest((select proargnames from pg_proc where oid = 'public.segment_contacts(uuid)'::regprocedure))
         with ordinality as t(name, ord)
   where ord > 1;
  assert v_columns = 'id,first_name,last_name,email,mobile_number,work_phone,organisation_id,job_type_id,state,'
                  || 'status,department,position,source,created_at,subscribed_to_newsletter,'
                  || 'subscribed_to_programs,service_ids,is_included,tag_ids',
         format('segment_contacts() columns changed: %s', v_columns);
  assert not has_function_privilege('anon', 'public.segment_contacts(uuid)', 'execute'), 'anon can resolve segments';
  assert has_function_privilege('authenticated', 'public.segment_contacts(uuid)', 'execute'), 'members cannot resolve segments';

  raise notice '2. fixtures';
  insert into public.tags (name) values ('VIP __segtagverify') returning id into v_vip;
  insert into public.tags (name) values ('Workshop __segtagverify') returning id into v_workshop;

  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
  values ('Both', 'Segtag', 'both__segtagverify@example.com', true) returning id into v_both;
  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
  values ('Vip', 'Segtag', 'vip__segtagverify@example.com', true) returning id into v_vip_only;
  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
  values ('None', 'Segtag', 'none__segtagverify@example.com', true) returning id into v_none;
  insert into public.contacts (first_name, last_name, email, subscribed_to_programs)
  values ('Courses', 'Segtag', 'courses__segtagverify@example.com', true) returning id into v_courses;
  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
  values ('Archived', 'Segtag', 'archived__segtagverify@example.com', true) returning id into v_archived;

  insert into public.contact_tags (contact_id, tag_id) values
    (v_both, v_vip), (v_both, v_workshop), (v_vip_only, v_vip), (v_courses, v_vip), (v_archived, v_vip);
  update public.contacts set deleted_at = timezone('utc'::text, now()) where id = v_archived;

  insert into public.segments (name, definition)
  values ('seg __segtagverify', jsonb_build_object('tagIds', v_vip::text)) returning id into v_segment;

  raise notice '3. tag ids are flattened, sorted, empty when none';
  assert (select tag_ids from public.segment_contacts(null) where id = v_both)
         = (select array_agg(t order by t) from unnest(array[v_vip, v_workshop]) t), 'tag_ids wrong for a two-tag contact';
  assert (select tag_ids from public.segment_contacts(null) where id = v_none) = '{}'::uuid[], 'tag_ids not empty for an untagged contact';
  assert not exists (select 1 from public.segment_contacts(null) where id = v_archived), 'an archived contact is a candidate';

  raise notice '4. any-of, none-of and consent';
  select array_agg(id order by id) into v_ids
    from public.segment_contacts(v_segment)
   where subscribed_to_newsletter and (is_included or tag_ids && array[v_vip])
     and email like '%__segtagverify%';
  assert v_ids = (select array_agg(t order by t) from unnest(array[v_both, v_vip_only]) t),
         'any-of VIP (newsletter) is not exactly Both + Vip';

  select array_agg(id order by id) into v_ids
    from public.segment_contacts(v_segment)
   where subscribed_to_newsletter and (is_included or (tag_ids && array[v_vip] and not tag_ids && array[v_workshop]))
     and email like '%__segtagverify%';
  assert v_ids = array[v_vip_only], 'VIP but not Workshop is not exactly Vip';

  raise notice '5. overrides unchanged: exclusion removes, inclusion widens criteria but not consent';
  insert into public.segment_overrides (segment_id, contact_id, mode) values
    (v_segment, v_vip_only, 'exclude'), (v_segment, v_none, 'include'), (v_segment, v_courses, 'include');
  select array_agg(id order by id) into v_ids
    from public.segment_contacts(v_segment)
   where subscribed_to_newsletter and (is_included or tag_ids && array[v_vip])
     and email like '%__segtagverify%';
  assert v_ids = (select array_agg(t order by t) from unnest(array[v_both, v_none]) t),
         'overrides changed behaviour with tag criteria';

  raise notice '6. a tag removed from the catalogue never breaks a saved segment';
  delete from public.tags where id = v_workshop;   -- SQL-only; contact_tags cascades
  assert (select tag_ids from public.segment_contacts(null) where id = v_both) = array[v_vip],
         'a removed tag is still reported';
  assert not exists (
    select 1 from public.segment_contacts(v_segment)
     where not is_included and tag_ids && array[v_workshop]
  ), 'a removed tag still matches contacts';
end $$;

rollback;
