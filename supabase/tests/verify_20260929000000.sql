-- Verification for migration 20260929000000_segment_control.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end. Every fixture carries the suffix `__segverify`.
--
-- Run with:
--   npm run db:verify:segments
--   npx supabase db query --linked --file supabase/tests/verify_20260929000000.sql
--
-- Success = no error. Any failed assertion raises and aborts the script.
--
-- What this guards: an exclusion removes a contact, an inclusion adds one the criteria
-- miss but never one without consent, and a segment an approved campaign depends on
-- cannot change underneath it.

begin;

do $$
declare
  v_failed      boolean;
  v_segment_id  uuid;
  v_matching    uuid;
  v_outsider    uuid;
  v_courses     uuid;
  v_campaign_id uuid;
  v_ids         uuid[];
begin
  ----------------------------------------------------------------------------
  raise notice '1. objects exist';
  ----------------------------------------------------------------------------
  assert to_regclass('public.segment_overrides') is not null, 'segment_overrides is missing';
  assert to_regprocedure('public.segment_contacts(uuid)') is not null, 'segment_contacts() is missing';
  assert (select relrowsecurity from pg_class where oid = 'public.segment_overrides'::regclass),
         'RLS must be enabled on segment_overrides';

  ----------------------------------------------------------------------------
  raise notice '2. fixtures';
  ----------------------------------------------------------------------------
  insert into public.segments (name, definition)
  values ('seg__segverify', '{"state":"TAS"}'::jsonb)
  returning id into v_segment_id;

  -- Matches the criteria, newsletter consent.
  insert into public.contacts (first_name, last_name, email, state, subscribed_to_newsletter)
  values ('Match', 'Verify', 'match__segverify@example.com', 'TAS', true)
  returning id into v_matching;

  -- Outside the criteria, newsletter consent.
  insert into public.contacts (first_name, last_name, email, state, subscribed_to_newsletter)
  values ('Outside', 'Verify', 'outside__segverify@example.com', 'WA', true)
  returning id into v_outsider;

  -- Courses consent only: never a newsletter recipient, included or not.
  insert into public.contacts (first_name, last_name, email, state, subscribed_to_programs)
  values ('Courses', 'Verify', 'courses__segverify@example.com', 'WA', true)
  returning id into v_courses;

  ----------------------------------------------------------------------------
  raise notice '3. with no overrides, everyone active is a candidate and nobody is included';
  ----------------------------------------------------------------------------
  assert (select count(*) from public.segment_contacts(v_segment_id)
          where id in (v_matching, v_outsider, v_courses)) = 3,
         'every active fixture should be a candidate';
  assert not exists (select 1 from public.segment_contacts(v_segment_id) where is_included),
         'nothing should be flagged as included yet';

  ----------------------------------------------------------------------------
  raise notice '4. an exclusion removes the contact';
  ----------------------------------------------------------------------------
  insert into public.segment_overrides (segment_id, contact_id, mode)
  values (v_segment_id, v_matching, 'exclude');

  assert not exists (select 1 from public.segment_contacts(v_segment_id) where id = v_matching),
         'an excluded contact must not be a candidate';

  -- Other segments are unaffected.
  assert exists (select 1 from public.segment_contacts(null) where id = v_matching),
         'an exclusion must only apply to its own segment';

  ----------------------------------------------------------------------------
  raise notice '5. an inclusion adds a contact the criteria miss, within consent';
  ----------------------------------------------------------------------------
  insert into public.segment_overrides (segment_id, contact_id, mode)
  values (v_segment_id, v_outsider, 'include'), (v_segment_id, v_courses, 'include');

  -- The same shape the application sends: consent AND (included OR criteria).
  select array_agg(id) into v_ids
  from public.segment_contacts(v_segment_id)
  where subscribed_to_newsletter
    and (is_included or state = 'TAS')
    and id in (v_matching, v_outsider, v_courses);

  assert v_ids = array[v_outsider],
         format('newsletter audience should be only the included outsider, got %s', v_ids);

  ----------------------------------------------------------------------------
  raise notice '6. one row per person per segment';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    insert into public.segment_overrides (segment_id, contact_id, mode)
    values (v_segment_id, v_outsider, 'exclude');
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed, 'a contact must not be both included and excluded';

  v_failed := false;
  begin
    insert into public.segment_overrides (segment_id, contact_id, mode)
    values (v_segment_id, v_courses, 'maybe');
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'an unknown mode must be rejected';

  ----------------------------------------------------------------------------
  raise notice '7. an approved campaign locks the segment';
  ----------------------------------------------------------------------------
  insert into public.campaigns (name, segment_id, provider_automation_id)
  values ('locking campaign__segverify', v_segment_id, 'auto-lock')
  returning id into v_campaign_id;

  -- Still a draft: edits are allowed.
  update public.segments set definition = '{"state":"VIC"}'::jsonb where id = v_segment_id;

  update public.campaigns set status = 'in_review' where id = v_campaign_id;
  update public.campaigns set status = 'approved', approved_by = gen_random_uuid()
  where id = v_campaign_id;

  v_failed := false;
  begin
    update public.segments set definition = '{"state":"NSW"}'::jsonb where id = v_segment_id;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'editing a segment an approved campaign uses must be rejected';

  v_failed := false;
  begin
    delete from public.segment_overrides where segment_id = v_segment_id and contact_id = v_outsider;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'changing overrides of a locked segment must be rejected';

  v_failed := false;
  begin
    insert into public.segment_overrides (segment_id, contact_id, mode)
    values (v_segment_id, v_matching, 'include')
    on conflict (segment_id, contact_id) do update set mode = excluded.mode;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'adding overrides to a locked segment must be rejected';

  -- Back to draft unlocks it.
  update public.campaigns set status = 'draft' where id = v_campaign_id;
  update public.segments set definition = '{"state":"NSW"}'::jsonb where id = v_segment_id;

  raise notice 'All segment control checks passed.';
end $$;

rollback;
