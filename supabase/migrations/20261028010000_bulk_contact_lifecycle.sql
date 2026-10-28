-- Archive or remove a selection of contacts at once (2026-10-28).
--
-- The contacts list already ticks rows across pages for bulk tagging; this gives the same
-- selection Archive and Remove. Both stay soft deletes (project rule: no physical
-- deletes): archive sets deleted_at, remove also sets removed_at/removed_by, exactly as
-- the single-contact PATCH does. The status trigger moves the status to 'archived' and
-- remembers the one before (20261021000000), so a restore brings a customer back as one.
--
-- A selection survives paging, so by the time it is acted on a contact in it may already
-- have been archived or removed by someone else. Those are skipped and counted rather than
-- failing the whole request: refusing would leave a selection that can never succeed,
-- with the stale contact on a page the user cannot see. Everything else is all or
-- nothing: an archive rule raised by a trigger (CRM01) rolls back every row.

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
  v_active   uuid[];
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

  -- Locked in id order so two overlapping bulk requests cannot deadlock.
  select coalesce(array_agg(id), '{}') into v_active
    from (
      select id from public.contacts
       where id = any (v_contacts)
         and deleted_at is null
         and removed_at is null
       order by id
         for update
    ) live;

  update public.contacts
     set deleted_at = v_now,
         removed_at = case when p_action = 'remove' then v_now else removed_at end,
         removed_by = case when p_action = 'remove' then auth.uid() else removed_by end
   where id = any (v_active);
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'updated', v_updated,
    'skipped', cardinality(v_contacts) - v_updated,
    'action', p_action);
end;
$$;

comment on function public.set_contacts_lifecycle(uuid[], text) is
  'Archives or removes (soft) the still-active contacts of a selection; the rest are skipped and counted.';

revoke all on function public.set_contacts_lifecycle(uuid[], text) from public, anon;
grant execute on function public.set_contacts_lifecycle(uuid[], text) to authenticated, service_role;
