-- Verification for 20261028010000_bulk_contact_lifecycle.sql (bulk archive/remove).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__bulklife`.
--
-- Run with:  npm run db:verify -- bulklife
--
-- What this guards: a member archives or removes a selection in one call; both stay soft
-- deletes (the rows are still there); the status trigger records the status before
-- archive; a stale selection changes nothing; a non-member is refused.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000b1f01', 'member__bulklife@example.invalid'),
  ('00000000-0000-4000-8000-0000000b1f02', 'outsider__bulklife@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000b1f01', 'operator', true);

insert into public.contacts (id, first_name, last_name, email, status) values
  ('00000000-0000-4000-8000-0000000c1f01', 'One', 'Bulk', 'one__bulklife@example.invalid', 'customer'),
  ('00000000-0000-4000-8000-0000000c1f02', 'Two', 'Bulk', 'two__bulklife@example.invalid', 'prospect'),
  ('00000000-0000-4000-8000-0000000c1f03', 'Three', 'Bulk', 'three__bulklife@example.invalid', 'prospect'),
  ('00000000-0000-4000-8000-0000000c1f04', 'Four', 'Bulk', 'four__bulklife@example.invalid', 'prospect');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000b1f01","role":"authenticated"}', true);

do $$
declare
  v_result jsonb;
  v_failed boolean;
begin
  raise notice '1. archive two contacts in one call';
  v_result := public.set_contacts_lifecycle(
    array['00000000-0000-4000-8000-0000000c1f01', '00000000-0000-4000-8000-0000000c1f02']::uuid[], 'archive');
  assert (v_result ->> 'updated')::int = 2, format('expected 2 archived, got %s', v_result);
  assert (select count(*) from public.contacts
           where email like '%__bulklife@example.invalid' and deleted_at is not null and removed_at is null) = 2,
    'archived contacts are not soft-deleted';
  assert (select status_before_archive from public.contacts where id = '00000000-0000-4000-8000-0000000c1f01') = 'customer',
    'the status before archive was not recorded';

  raise notice '2. a stale selection (an already archived contact) changes nothing';
  v_failed := false;
  begin
    perform public.set_contacts_lifecycle(
      array['00000000-0000-4000-8000-0000000c1f02', '00000000-0000-4000-8000-0000000c1f03']::uuid[], 'remove');
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a stale selection was accepted';
  assert (select removed_at from public.contacts where id = '00000000-0000-4000-8000-0000000c1f03') is null
     and (select deleted_at from public.contacts where id = '00000000-0000-4000-8000-0000000c1f03') is null,
    'the stale request changed a contact';

  raise notice '3. remove is a soft delete that names who removed';
  v_result := public.set_contacts_lifecycle(array['00000000-0000-4000-8000-0000000c1f03']::uuid[], 'remove');
  assert (v_result ->> 'updated')::int = 1, 'remove did not report one contact';
  assert exists (select 1 from public.contacts
                  where id = '00000000-0000-4000-8000-0000000c1f03'
                    and removed_at is not null and deleted_at is not null
                    and removed_by = '00000000-0000-4000-8000-0000000b1f01'),
    'removed contact is missing removed_at, deleted_at or removed_by';

  raise notice '4. empty selections and unknown actions are refused';
  v_failed := false;
  begin
    perform public.set_contacts_lifecycle(array[]::uuid[], 'archive');
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an empty selection was accepted';
  v_failed := false;
  begin
    perform public.set_contacts_lifecycle(array['00000000-0000-4000-8000-0000000c1f04']::uuid[], 'delete');
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an unknown action was accepted';
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000b1f02","role":"authenticated"}', true);

do $$
declare
  v_failed boolean := false;
begin
  raise notice '5. a non-member is refused';
  begin
    perform public.set_contacts_lifecycle(array['00000000-0000-4000-8000-0000000c1f04']::uuid[], 'archive');
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'a non-member archived a contact';
end $$;

reset role;
rollback;
