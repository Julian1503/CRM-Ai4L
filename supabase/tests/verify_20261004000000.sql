-- Verification for 20261004000000_contact_save.sql and
-- 20261004010000_import_field_presence.sql (audit H8, H9, P3).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__contactverify`.
--
-- Run with:  npm run db:verify -- contacts2

begin;

do $$
declare
  v_failed  boolean;
  v_service uuid;
  v_saved   jsonb;
  v_id      uuid;
  v_rev     integer;
  v_preview jsonb;
begin
  insert into public.services (name) values ('Service __contactverify') returning id into v_service;

  ----------------------------------------------------------------------------
  raise notice '1. save_contact creates contact, organisation and services together (H8)';
  ----------------------------------------------------------------------------
  v_saved := public.save_contact(
    jsonb_build_object('first_name', 'Ada', 'last_name', 'Verify', 'email', 'ada__contactverify@example.invalid',
                       'status', 'customer', 'organisation_name', 'Org __contactverify'),
    array[v_service]);
  v_id := (v_saved->>'id')::uuid;
  v_rev := (v_saved->>'revision')::integer;
  assert (select count(*) from public.contact_services where contact_id = v_id) = 1, 'service not linked';
  assert v_saved->'organisation'->>'name' = 'Org __contactverify', 'organisation not linked';

  ----------------------------------------------------------------------------
  raise notice '2. an invalid service changes nothing';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    perform public.save_contact(
      jsonb_build_object('id', v_id, 'first_name', 'Renamed', 'last_name', 'Verify',
                         'email', 'ada__contactverify@example.invalid', 'status', 'customer'),
      array[gen_random_uuid()], v_rev);
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an unknown service was accepted';
  assert (select first_name from public.contacts where id = v_id) = 'Ada', 'the failed save changed the contact';
  assert (select count(*) from public.contact_services where contact_id = v_id) = 1, 'the failed save dropped services';

  ----------------------------------------------------------------------------
  raise notice '3. an edit over a newer revision is a conflict';
  ----------------------------------------------------------------------------
  update public.contacts set notes = 'someone else' where id = v_id;
  v_failed := false;
  begin
    perform public.save_contact(
      jsonb_build_object('id', v_id, 'first_name', 'Ada', 'last_name', 'Verify',
                         'email', 'ada__contactverify@example.invalid', 'status', 'customer'),
      array[v_service], v_rev);
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a stale revision overwrote a newer edit';

  ----------------------------------------------------------------------------
  raise notice '4. an import without a customer column keeps the customer (H9)';
  ----------------------------------------------------------------------------
  perform public.import_contacts(jsonb_build_array(jsonb_build_object(
    'email', 'ada__contactverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify', 'position', 'CTO')));
  assert (select status = 'customer' and is_customer and "position" = 'CTO' from public.contacts where id = v_id),
         'an import without a customer column demoted a customer';

  ----------------------------------------------------------------------------
  raise notice '5. the preview writes nothing and its token catches a later edit (P3)';
  ----------------------------------------------------------------------------
  v_preview := public.preview_import_contacts(jsonb_build_array(
    jsonb_build_object('email', 'ada__contactverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify', 'is_customer', false),
    jsonb_build_object('email', 'new__contactverify@example.invalid', 'first_name', 'New', 'last_name', 'Verify')));
  assert (v_preview->>'new')::int = 1 and (v_preview->>'leaving_customers')::int = 1, format('unexpected preview %s', v_preview);
  assert not exists (select 1 from public.contacts where email = 'new__contactverify@example.invalid'), 'the preview wrote';

  update public.contacts set notes = 'edited after preview' where id = v_id;
  v_failed := false;
  begin
    perform public.import_contacts(jsonb_build_array(
      jsonb_build_object('email', 'ada__contactverify@example.invalid', 'first_name', 'Ada', 'last_name', 'Verify', 'is_customer', false)),
      v_preview->>'token');
  exception when sqlstate 'CRM08' then v_failed := true;
  end;
  assert v_failed, 'a stale preview was applied';

  raise notice 'All contact save and import checks passed.';
end $$;

rollback;
