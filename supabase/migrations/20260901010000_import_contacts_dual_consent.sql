-- import_contacts(): grant both consents to new contacts, never re-grant to old ones.
--
-- The client's rule is that an imported contact is subscribed to both streams. Applied
-- naively — `subscribed_to_newsletter = excluded.subscribed_to_newsletter`, as the
-- previous version did — re-importing a spreadsheet would re-subscribe every contact
-- who had unsubscribed since the last import. The addresses are in the file, the file
-- says nothing about consent, and the old function read "nothing" as `false`, wrote it
-- as fact, and on the next run wrote `true` back over a real withdrawal.
--
-- So consent moves in one direction here:
--
--   insert  →  coalesce(payload, true)                     both streams on by default
--   update  →  existing AND excluded                       never raised, only lowered
--
-- `excluded` already carries the coalesced value, which makes the update rule read
-- correctly for all three cases: a column the spreadsheet does not have becomes `true`
-- and leaves the existing value alone; an explicit "Yes" likewise cannot raise it; only
-- an explicit "No" lowers it. A person re-consenting goes through the preference centre
-- or the CRM, both of which are evidence. A spreadsheet is not.
--
-- The second change is the archived collision. Email is unique only among live rows
-- (contacts_email_active_idx), so an address belonging to an archived contact matches
-- no conflict target and the old function inserted a *second*, live row for them —
-- duplicating the person and handing back the consent they had just withdrawn, since
-- losing every consent is now what archives a contact in the first place. Those rows
-- are held back and counted instead, the same choice applyNewsletterEvent makes for the
-- same collision: report it and let a human decide, rather than guess.

create or replace function public.import_contacts(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inserted   int := 0;
  v_updated    int := 0;
  v_total      int := 0;
  v_usable     int := 0;
  v_collisions int := 0;
begin
  if payload is null or jsonb_typeof(payload) <> 'array' then
    raise exception 'import_contacts: payload must be a JSON array, got %',
      coalesce(jsonb_typeof(payload), 'null');
  end if;

  -- Labels every consent event this call produces. Transaction-local, so it cannot
  -- leak into an unrelated statement on a pooled connection.
  perform set_config('app.consent_source', 'import', true);

  v_total := jsonb_array_length(payload);

  -- Dropped first so the function is re-entrant inside a single transaction.
  --
  -- `on commit drop` releases the table at COMMIT, not at RETURN. Every production
  -- call arrives as its own PostgREST transaction, so this never surfaced there --
  -- but any caller that imports twice without committing in between hit
  -- `42P07 relation "_import_rows" already exists` on the second call, and the
  -- verification script in supabase/tests is exactly such a caller.
  drop table if exists _import_rows;

  create temporary table _import_rows on commit drop as
  select distinct on (email)
    lower(nullif(btrim(r->>'email'), ''))      as email,
    nullif(btrim(r->>'first_name'), '')        as first_name,
    nullif(btrim(r->>'last_name'), '')         as last_name,
    nullif(btrim(r->>'preferred_name'), '')    as preferred_name,
    nullif(btrim(r->>'mobile_number'), '')     as mobile_number,
    nullif(btrim(r->>'work_phone'), '')        as work_phone,
    nullif(btrim(r->>'address'), '')           as address,
    nullif(btrim(r->>'suburb'), '')            as suburb,
    nullif(btrim(r->>'state'), '')             as state,
    nullif(btrim(r->>'postcode'), '')          as postcode,
    nullif(btrim(r->>'country'), '')           as country,
    nullif(btrim(r->>'department'), '')        as department,
    nullif(btrim(r->>'position'), '')          as "position",
    nullif(btrim(r->>'organisation_name'), '') as organisation_name,
    nullif(btrim(r->>'job_type_name'), '')     as job_type_name,
    coalesce((r->>'is_customer')::boolean, false) as is_customer,
    -- Left NULL when the key is absent, which is the whole point: "the spreadsheet has
    -- no consent column" and "the spreadsheet says no" are different facts, and the
    -- previous version collapsed them into `false`.
    (r->>'subscribed_to_newsletter')::boolean  as subscribed_to_newsletter,
    (r->>'subscribed_to_programs')::boolean    as subscribed_to_programs
  from jsonb_array_elements(payload) with ordinality as t(r, ord)
  where nullif(btrim(r->>'email'), '') is not null
    and nullif(btrim(r->>'first_name'), '') is not null
    and nullif(btrim(r->>'last_name'), '') is not null
  order by email, ord;

  select count(*) into v_usable from _import_rows;

  if v_usable = 0 then
    return jsonb_build_object(
      'inserted', 0, 'updated', 0, 'skipped', v_total,
      'archived_collisions', 0, 'total', v_total
    );
  end if;

  -- Addresses that belong to an archived contact and to no live one. Importing them
  -- would create a duplicate live record rather than update anybody.
  with collisions as (
    delete from _import_rows i
    where exists (
      select 1 from public.contacts c
      where c.email = i.email and c.deleted_at is not null
    )
    and not exists (
      select 1 from public.contacts c
      where c.email = i.email and c.deleted_at is null
    )
    returning 1
  )
  select count(*) into v_collisions from collisions;

  -- Create any organisations / job types referenced but not yet known.
  insert into public.organisations (name)
  select distinct organisation_name from _import_rows
  where organisation_name is not null
  on conflict (lower(btrim(name))) do nothing;

  insert into public.job_types (name)
  select distinct job_type_name from _import_rows
  where job_type_name is not null
  on conflict (lower(btrim(name))) do nothing;

  with upserted as (
    insert into public.contacts (
      email, first_name, last_name, preferred_name, mobile_number, work_phone,
      address, suburb, state, postcode, country, department, "position",
      organisation_id, job_type_id, is_customer, status,
      subscribed_to_newsletter, subscribed_to_programs
    )
    select
      i.email, i.first_name, i.last_name, i.preferred_name, i.mobile_number, i.work_phone,
      i.address, i.suburb, i.state, i.postcode, i.country, i.department, i."position",
      o.id, jt.id, i.is_customer,
      case when i.is_customer then 'customer'::public.contact_status
           else 'prospect'::public.contact_status end,
      -- A contact the client is importing is one they intend to email. Both consents
      -- start on, unless the spreadsheet explicitly says otherwise.
      coalesce(i.subscribed_to_newsletter, true),
      coalesce(i.subscribed_to_programs, true)
    from _import_rows i
    left join public.organisations o
      on lower(btrim(o.name)) = lower(i.organisation_name)
    left join public.job_types jt
      on lower(btrim(jt.name)) = lower(i.job_type_name)
    on conflict (email) where deleted_at is null
    do update set
      first_name              = coalesce(excluded.first_name, public.contacts.first_name),
      last_name               = coalesce(excluded.last_name, public.contacts.last_name),
      preferred_name          = coalesce(excluded.preferred_name, public.contacts.preferred_name),
      mobile_number           = coalesce(excluded.mobile_number, public.contacts.mobile_number),
      work_phone              = coalesce(excluded.work_phone, public.contacts.work_phone),
      address                 = coalesce(excluded.address, public.contacts.address),
      suburb                  = coalesce(excluded.suburb, public.contacts.suburb),
      state                   = coalesce(excluded.state, public.contacts.state),
      postcode                = coalesce(excluded.postcode, public.contacts.postcode),
      country                 = coalesce(excluded.country, public.contacts.country),
      department              = coalesce(excluded.department, public.contacts.department),
      "position"              = coalesce(excluded."position", public.contacts."position"),
      organisation_id         = coalesce(excluded.organisation_id, public.contacts.organisation_id),
      job_type_id             = coalesce(excluded.job_type_id, public.contacts.job_type_id),
      is_customer             = excluded.is_customer,
      status                  = excluded.status,
      -- Never raised, only lowered. See the header.
      subscribed_to_newsletter = public.contacts.subscribed_to_newsletter
                                 and excluded.subscribed_to_newsletter,
      subscribed_to_programs   = public.contacts.subscribed_to_programs
                                 and excluded.subscribed_to_programs
    returning (xmax = 0) as was_inserted
  )
  select
    count(*) filter (where was_inserted),
    count(*) filter (where not was_inserted)
  into v_inserted, v_updated
  from upserted;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated,
    'skipped',  v_total - v_usable,
    -- Rows held back because the address belongs to an archived contact. Not an error
    -- and not a silent success: somebody has to look at them.
    'archived_collisions', v_collisions,
    'total',    v_total
  );
end;
$$;

comment on function public.import_contacts(jsonb) is
  'Bulk contact upsert. Required because the partial unique index contacts_email_active_idx '
  'cannot be inferred by a bare ON CONFLICT (email). Grants both email consents to new '
  'contacts and never re-grants them to existing ones; holds back addresses belonging to '
  'archived contacts and reports them as archived_collisions.';
