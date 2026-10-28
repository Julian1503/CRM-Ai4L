-- Archive or remove a selection of contacts at once (2026-10-28).
--
-- The contacts list already ticks rows across pages for bulk tagging; this gives the same
-- selection Archive and Remove. Both stay soft deletes (project rule: no physical
-- deletes): archive sets deleted_at, remove also sets removed_at/removed_by, exactly as
-- the single-contact PATCH does. The status trigger moves the status to 'archived' and
-- remembers the one before (20261021000000), so a restore brings a customer back as one.
--
-- All or nothing, like apply_contact_tags: a selection where any contact was archived or
-- removed meanwhile is refused as a whole (CRM06) so the user refreshes instead of getting
-- a partial change, and an archive rule raised by a trigger (CRM01) rolls back every row.

create or replace function public.set_contacts_lifecycle(
  p_contact_ids uuid[],
  p_action      text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_contacts uuid[];
  v_locked   integer;
  v_updated  integer;
  v_now      timestamptz := now();
begin
  -- RLS would refuse a non-member anyway; checking first gives a clear error instead of
  -- a misleading "contacts missing".
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  if p_action is null or p_action not in ('archive', 'remove') then
    raise exception 'Action must be archive or remove.' using errcode = 'CRM07';
  end if;

  select coalesce(array_agg(distinct c), '{}') into v_contacts
    from unnest(coalesce(p_contact_ids, '{}')) c where c is not null;

  if cardinality(v_contacts) = 0 then
    raise exception 'Select at least one contact.' using errcode = 'CRM07';
  end if;
  if cardinality(v_contacts) > 2000 then
    raise exception 'Select at most 2000 contacts.' using errcode = 'CRM07';
  end if;

  perform 1
     from public.contacts
    where id = any (v_contacts)
      and deleted_at is null
      and removed_at is null
    order by id
      for update;
  get diagnostics v_locked = row_count;

  if v_locked <> cardinality(v_contacts) then
    raise exception 'Some selected contacts were archived or no longer exist. Refresh the selection and try again.'
      using errcode = 'CRM06';
  end if;

  update public.contacts
     set deleted_at = v_now,
         removed_at = case when p_action = 'remove' then v_now else removed_at end,
         removed_by = case when p_action = 'remove' then auth.uid() else removed_by end
   where id = any (v_contacts);
  get diagnostics v_updated = row_count;

  return jsonb_build_object('updated', v_updated, 'action', p_action);
end;
$$;

comment on function public.set_contacts_lifecycle(uuid[], text) is
  'Archives or removes (soft) an explicit selection of active contacts, all or nothing.';

revoke all on function public.set_contacts_lifecycle(uuid[], text) from public, anon;
grant execute on function public.set_contacts_lifecycle(uuid[], text) to authenticated, service_role;
