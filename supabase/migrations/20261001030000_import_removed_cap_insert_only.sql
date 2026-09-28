-- Fix for 20261001000000: the removed-record consent cap leaked into updates.
--
-- import_contacts caps a new contact's consent at what the address's latest removed
-- record held. That cap was computed in the SELECT feeding the upsert, which is also
-- what ON CONFLICT DO UPDATE sees as `excluded`. So re-importing the address of a live
-- contact who had re-subscribed after an older record was removed would AND their
-- consent with the removed record's and silently unsubscribe them.
--
-- The cap now applies only when the address has no live contact -- exactly the rows
-- that will be inserted. Everything else is unchanged from 20261001000000.

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

  perform set_config('app.consent_source', 'import', true);

  v_total := jsonb_array_length(payload);

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

  -- Addresses that belong to an archived (restorable) contact and to no live one.
  with collisions as (
    delete from _import_rows i
    where exists (
      select 1 from public.contacts c
      where c.email = i.email and c.deleted_at is not null and c.removed_at is null
    )
    and not exists (
      select 1 from public.contacts c
      where c.email = i.email and c.deleted_at is null
    )
    returning 1
  )
  select count(*) into v_collisions from collisions;

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
      coalesce(i.subscribed_to_newsletter, true) and coalesce(removed.subscribed_to_newsletter, true),
      coalesce(i.subscribed_to_programs, true)   and coalesce(removed.subscribed_to_programs, true)
    from _import_rows i
    left join public.organisations o
      on lower(btrim(o.name)) = lower(i.organisation_name)
    left join public.job_types jt
      on lower(btrim(jt.name)) = lower(i.job_type_name)
    -- Only for an address with no live contact, i.e. a row that will be inserted. The
    -- value computed here is also what ON CONFLICT reads as `excluded`, so without this
    -- guard an old removed record would lower the consent of a live contact who
    -- re-subscribed since.
    left join lateral (
      select c.subscribed_to_newsletter, c.subscribed_to_programs
      from public.contacts c
      where c.email = i.email
        and c.removed_at is not null
        and not exists (
          select 1 from public.contacts live
          where live.email = i.email and live.deleted_at is null
        )
      order by c.removed_at desc
      limit 1
    ) removed on true
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
    'archived_collisions', v_collisions,
    'total',    v_total
  );
end;
$$;

comment on function public.import_contacts(jsonb) is
  'Bulk contact upsert. Grants both email consents to new contacts unless the spreadsheet '
  'withholds them or the address''s latest removed record did not hold them; never re-grants them to '
  'existing ones; holds back addresses belonging to archived (not removed) contacts and '
  'reports them as archived_collisions.';
