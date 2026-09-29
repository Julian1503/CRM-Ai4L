-- Import field presence and change preview (audit H9, P3).
--
-- H9: import_contacts always wrote `is_customer` and `status`. The client sent `false`
-- whenever the spreadsheet had no customer column, so importing a plain name-and-email
-- list demoted every existing customer in it to prospect. Now a missing `is_customer`
-- key (or null) means "the spreadsheet said nothing": an existing contact keeps its
-- status, and only a NEW contact gets the default (prospect). An explicit `false`
-- demotes a customer to prospect and leaves a lead a lead.
--
-- Field rules, for existing contacts (recorded in docs/IMPORTS.md):
--   text fields          a value replaces; blank or unmapped keeps (import never clears)
--   is_customer          true -> customer; false -> customer becomes prospect; absent keeps
--   consent              absent keeps; true never re-grants; false withdraws (unchanged)
-- Duplicate addresses within one file: the first row wins; the rest are counted.
--
-- P3: preview_import_contacts() stages the rows the same way and reports what an import
-- would change, without writing. It returns a token over the (id, revision) of every
-- existing contact it matched; import_contacts() refuses with CRM08 if that token no
-- longer holds, so an obsolete preview is never applied silently.

-- Shared staging: one definition of how a payload is read, for both callers.
create or replace function public._stage_import_rows(payload jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_usable integer;
begin
  if payload is null or jsonb_typeof(payload) <> 'array' then
    raise exception 'import_contacts: payload must be a JSON array, got %',
      coalesce(jsonb_typeof(payload), 'null');
  end if;

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
    -- Null when absent: "no information", never "not a customer".
    (r->>'is_customer')::boolean               as is_customer,
    (r->>'subscribed_to_newsletter')::boolean  as subscribed_to_newsletter,
    (r->>'subscribed_to_programs')::boolean    as subscribed_to_programs
  from jsonb_array_elements(payload) with ordinality as t(r, ord)
  where nullif(btrim(r->>'email'), '') is not null
    and nullif(btrim(r->>'first_name'), '') is not null
    and nullif(btrim(r->>'last_name'), '') is not null
  order by email, ord;

  select count(*) into v_usable from _import_rows;
  return v_usable;
end;
$$;

-- Usable rows before de-duplication, to report duplicates within the file.
create or replace function public._count_usable_import_rows(payload jsonb)
returns integer
language sql
immutable
set search_path = public
as $$
  select count(*)::integer
    from jsonb_array_elements(payload) r
   where nullif(btrim(r->>'email'), '') is not null
     and nullif(btrim(r->>'first_name'), '') is not null
     and nullif(btrim(r->>'last_name'), '') is not null;
$$;

-- The optimistic token over every live contact the staged rows match.
-- plpgsql, not sql: _import_rows is a per-transaction temporary table, so the body must
-- be resolved when it runs rather than when it is created.
create or replace function public._import_match_token()
returns text
language plpgsql
stable
set search_path = public
as $$
begin
  return (
    select md5(coalesce(string_agg(c.id::text || ':' || c.revision, ',' order by c.id), ''))
      from _import_rows i
      join public.contacts c on c.email = i.email and c.deleted_at is null
  );
end;
$$;

create or replace function public.preview_import_contacts(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total   integer := coalesce(jsonb_array_length(payload), 0);
  v_usable  integer;
  v_distinct integer;
  v_result  jsonb;
begin
  v_distinct := public._stage_import_rows(payload);
  v_usable := public._count_usable_import_rows(payload);

  with matched as (
    select i.*, c.id as contact_id, c.status as current_status,
           c.subscribed_to_newsletter as current_newsletter,
           c.subscribed_to_programs as current_programs,
           c.first_name as current_first_name, c.last_name as current_last_name,
           (c.id is not null) as exists_live,
           exists (select 1 from public.contacts a
                    where a.email = i.email and a.deleted_at is not null and a.removed_at is null)
             and c.id is null as archived_collision
      from _import_rows i
      left join public.contacts c on c.email = i.email and c.deleted_at is null
  ), classified as (
    select m.*,
      case
        when m.archived_collision then 'held_back'
        when not m.exists_live then 'new'
        when (m.is_customer is true and m.current_status <> 'customer')
          or (m.is_customer is false and m.current_status = 'customer')
          or (m.subscribed_to_newsletter is false and m.current_newsletter)
          or (m.subscribed_to_programs is false and m.current_programs)
          or (m.first_name is distinct from m.current_first_name)
          or (m.last_name is distinct from m.current_last_name)
          or m.preferred_name is not null or m.mobile_number is not null or m.work_phone is not null
          or m.address is not null or m.suburb is not null or m.state is not null
          or m.postcode is not null or m.country is not null or m.department is not null
          or m."position" is not null or m.organisation_name is not null or m.job_type_name is not null
          then 'changed'
        else 'unchanged'
      end as outcome
    from matched m
  )
  select jsonb_build_object(
    'total', v_total,
    'rejected', v_total - v_usable,
    'duplicates', v_usable - v_distinct,
    'new', count(*) filter (where outcome = 'new'),
    'changed', count(*) filter (where outcome = 'changed'),
    'unchanged', count(*) filter (where outcome = 'unchanged'),
    'held_back', count(*) filter (where outcome = 'held_back'),
    'becoming_customers', count(*) filter (where exists_live and is_customer is true and current_status <> 'customer'),
    'leaving_customers', count(*) filter (where exists_live and is_customer is false and current_status = 'customer'),
    'withdrawing_newsletter', count(*) filter (where exists_live and subscribed_to_newsletter is false and current_newsletter),
    'withdrawing_programs', count(*) filter (where exists_live and subscribed_to_programs is false and current_programs),
    'customer_column_present', bool_or(is_customer is not null),
    'samples', coalesce((
      select jsonb_agg(sample) from (
        select jsonb_build_object(
          'email', email,
          'outcome', outcome,
          'status', case
            when not exists_live then (case when is_customer then 'customer' else 'prospect' end)
            when is_customer is true then 'customer'
            when is_customer is false and current_status = 'customer' then 'prospect'
            else current_status::text end,
          'previous_status', case when exists_live then current_status::text end,
          'newsletter', case when exists_live then (current_newsletter and coalesce(subscribed_to_newsletter, true))
                             else coalesce(subscribed_to_newsletter, true) end,
          'previous_newsletter', case when exists_live then current_newsletter end
        ) as sample
        from classified
        where outcome in ('new', 'changed', 'held_back')
        order by outcome, email
        limit 20
      ) s
    ), '[]'::jsonb),
    'token', public._import_match_token()
  )
  into v_result
  from classified;

  return v_result;
end;
$$;

drop function if exists public.import_contacts(jsonb);

create or replace function public.import_contacts(payload jsonb, p_preview_token text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inserted   int := 0;
  v_updated    int := 0;
  v_total      int := coalesce(jsonb_array_length(payload), 0);
  v_usable     int := 0;
  v_distinct   int := 0;
  v_collisions int := 0;
begin
  v_distinct := public._stage_import_rows(payload);
  v_usable := public._count_usable_import_rows(payload);

  if v_distinct = 0 then
    return jsonb_build_object(
      'inserted', 0, 'updated', 0, 'skipped', v_total,
      'archived_collisions', 0, 'duplicates', 0, 'total', v_total
    );
  end if;

  -- Revalidate against the preview the operator approved (P3).
  if p_preview_token is not null and p_preview_token <> public._import_match_token() then
    raise exception 'Some of these contacts changed after the preview. Preview the import again.'
      using errcode = 'CRM08';
  end if;

  perform set_config('app.consent_source', 'import', true);

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
      subscribed_to_newsletter, subscribed_to_programs, source
    )
    select
      i.email, i.first_name, i.last_name, i.preferred_name, i.mobile_number, i.work_phone,
      i.address, i.suburb, i.state, i.postcode, i.country, i.department, i."position",
      o.id, jt.id,
      -- Defaults apply to NEW contacts only; ON CONFLICT below reads the raw value.
      coalesce(i.is_customer, false),
      case when coalesce(i.is_customer, false) then 'customer'::public.contact_status
           else 'prospect'::public.contact_status end,
      coalesce(i.subscribed_to_newsletter, true) and coalesce(removed.subscribed_to_newsletter, true),
      coalesce(i.subscribed_to_programs, true)   and coalesce(removed.subscribed_to_programs, true),
      'import'
    from _import_rows i
    left join public.organisations o
      on lower(btrim(o.name)) = lower(i.organisation_name)
    left join public.job_types jt
      on lower(btrim(jt.name)) = lower(i.job_type_name)
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
      -- `excluded` holds the defaulted insert value, so the spreadsheet's own answer is
      -- read from the staged row: null keeps the contact's status (H9).
      is_customer = coalesce(
        (select s.is_customer from _import_rows s where s.email = excluded.email),
        public.contacts.is_customer),
      status = case (select s.is_customer from _import_rows s where s.email = excluded.email)
        when true then 'customer'::public.contact_status
        when false then case when public.contacts.status = 'customer'
                             then 'prospect'::public.contact_status
                             else public.contacts.status end
        else public.contacts.status
      end,
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

  perform set_config('app.consent_source', '', true);

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated,
    'skipped',  v_total - v_usable,
    'duplicates', v_usable - v_distinct,
    'archived_collisions', v_collisions,
    'total',    v_total
  );
end;
$$;

comment on function public.import_contacts(jsonb, text) is
  'Bulk contact upsert. Unmapped or blank fields never overwrite; is_customer only changes '
  'status when the spreadsheet says yes or no; consent is granted to new contacts unless '
  'withheld and never re-granted to existing ones. With p_preview_token, refuses (CRM08) if '
  'a matched contact changed since preview_import_contacts().';

revoke all on function public._stage_import_rows(jsonb) from public, anon;
revoke all on function public._count_usable_import_rows(jsonb) from public, anon;
revoke all on function public._import_match_token() from public, anon;
revoke all on function public.preview_import_contacts(jsonb) from public, anon;
revoke all on function public.import_contacts(jsonb, text) from public, anon;
grant execute on function public._stage_import_rows(jsonb) to authenticated, service_role;
grant execute on function public._count_usable_import_rows(jsonb) to authenticated, service_role;
grant execute on function public._import_match_token() to authenticated, service_role;
grant execute on function public.preview_import_contacts(jsonb) to authenticated, service_role;
grant execute on function public.import_contacts(jsonb, text) to authenticated, service_role;
