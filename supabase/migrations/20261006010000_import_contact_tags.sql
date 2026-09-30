-- Tags in imports (docs/CLIENT_FEATURES_IMPLEMENTATION_PLAN.md, B "Importación").
--
-- Requires 20261006000000_contact_tags.sql. Each payload row may carry `tag_names`: the
-- row's own tags already merged with the import's common tags by the client. They are
-- validated again here, because the database is the last line: names are normalised
-- (normalize_tag_name), deduplicated ignoring case, at most 80 characters each and at
-- most 50 per row; a violation refuses the whole payload with CRM07.
--
-- Import only ADDS tags. An absent, null or empty `tag_names` keeps what the contact
-- has, exactly like a blank cell keeps any other field. A payload with no tags at all
-- behaves exactly as before this migration: same outcomes, same result keys, same
-- preview token.
--
-- Preview (no writes, catalog included):
--   * a matched contact whose only change is receiving new tags counts as `changed`,
--     and also in `tags_only_changed`;
--   * `tags_assigned`: contacts that would receive at least one tag they lack;
--   * `tags_created`: names not yet in the catalog (the import would create them).
-- The token additionally covers which of the payload's tag names exist in the catalog.
-- Tag assignments on matched contacts are already covered: every tag change moves
-- contacts.revision, which the token hashes.
--
-- Import creates missing tags (a concurrent creation of the same name is absorbed by
-- ON CONFLICT), links them, and reports `tags_assigned` / `tags_created`. Matched
-- contacts are updated by the upsert anyway, so their revision moves in the same step.
-- The 50-tags-per-contact limit is enforced by the contact_tags trigger (CRM07,
-- hint tag_limit); the preview reports the same violation before anything is written.

-- Normalises one row's `tag_names`. Raises CRM07 on anything the client should have
-- refused: a non-list, a non-string, an over-long name, more than 50 names.
create or replace function public._import_tag_names(p_value jsonb)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_item  jsonb;
  v_name  text;
  v_names text[] := '{}';
  v_keys  text[] := '{}';
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return '{}';
  end if;
  if jsonb_typeof(p_value) <> 'array' then
    raise exception 'tag_names must be a list of tag names.' using errcode = 'CRM07';
  end if;

  for v_item in select value from jsonb_array_elements(p_value) loop
    if jsonb_typeof(v_item) <> 'string' then
      raise exception 'tag_names must contain only text.' using errcode = 'CRM07';
    end if;

    v_name := public.normalize_tag_name(v_item #>> '{}');
    continue when v_name is null;

    if char_length(v_name) > 80 then
      raise exception 'Tag "%" is longer than 80 characters.', left(v_name, 30) || '…'
        using errcode = 'CRM07';
    end if;
    continue when lower(v_name) = any (v_keys);

    v_keys := v_keys || lower(v_name);
    v_names := v_names || v_name;
  end loop;

  if cardinality(v_names) > 50 then
    raise exception 'A row has % tags; a contact can have at most 50.', cardinality(v_names)
      using errcode = 'CRM07', hint = 'tag_limit';
  end if;

  return v_names;
end;
$$;

-- Shared staging: one definition of how a payload is read, for both callers.
-- Unchanged from 20261004010000 except for `tag_names` and the _import_row_tags table.
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
  drop table if exists _import_row_tags;

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
    (r->>'subscribed_to_programs')::boolean    as subscribed_to_programs,
    -- Duplicate addresses: the first row wins, its tags included.
    public._import_tag_names(r->'tag_names')   as tag_names
  from jsonb_array_elements(payload) with ordinality as t(r, ord)
  where nullif(btrim(r->>'email'), '') is not null
    and nullif(btrim(r->>'first_name'), '') is not null
    and nullif(btrim(r->>'last_name'), '') is not null
  order by email, ord;

  -- One row per (contact email, tag). `ord` keeps the file's spelling order so the
  -- first spelling of a new tag is the one created.
  create temporary table _import_row_tags on commit drop as
  select i.email, t.name, lower(t.name) as tag_key, t.ord
    from _import_rows i
   cross join lateral unnest(i.tag_names) with ordinality as t(name, ord);

  select count(*) into v_usable from _import_rows;
  return v_usable;
end;
$$;

-- The optimistic token over every live contact the staged rows match, plus -- only when
-- the payload has tags -- which of its tag names the catalog already holds.
create or replace function public._import_match_token()
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_contacts text;
  v_tags     text;
begin
  select md5(coalesce(string_agg(c.id::text || ':' || c.revision, ',' order by c.id), ''))
    into v_contacts
    from _import_rows i
    join public.contacts c on c.email = i.email and c.deleted_at is null;

  if not exists (select 1 from _import_row_tags) then
    return v_contacts;
  end if;

  select string_agg(k.tag_key || ':' || coalesce(g.id::text, '-'), ',' order by k.tag_key)
    into v_tags
    from (select distinct tag_key from _import_row_tags) k
    left join public.tags g on lower(btrim(g.name)) = k.tag_key;

  return md5(v_contacts || '|' || v_tags);
end;
$$;

-- A live contact that would end up with more than 50 tags, or null.
create or replace function public._import_tag_limit_violation()
returns text
language plpgsql
stable
set search_path = public
as $$
begin
  return (
    select i.email
      from _import_rows i
      join public.contacts c on c.email = i.email and c.deleted_at is null
     where (select count(*) from public.contact_tags ct where ct.contact_id = c.id)
         + (select count(*) from _import_row_tags t
             where t.email = i.email
               and not exists (select 1 from public.contact_tags ct
                                 join public.tags g on g.id = ct.tag_id
                                where ct.contact_id = c.id and lower(btrim(g.name)) = t.tag_key)) > 50
     order by i.email
     limit 1
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
  v_total    integer := coalesce(jsonb_array_length(payload), 0);
  v_usable   integer;
  v_distinct integer;
  v_has_tags boolean;
  v_over     text;
  v_result   jsonb;
begin
  v_distinct := public._stage_import_rows(payload);
  v_usable := public._count_usable_import_rows(payload);
  v_has_tags := exists (select 1 from _import_row_tags);

  if v_has_tags then
    v_over := public._import_tag_limit_violation();
    if v_over is not null then
      raise exception 'A contact can have at most 50 tags; % would have more.', v_over
        using errcode = 'CRM07', hint = 'tag_limit';
    end if;
  end if;

  with matched as (
    select i.*, c.id as contact_id, c.status as current_status,
           c.subscribed_to_newsletter as current_newsletter,
           c.subscribed_to_programs as current_programs,
           c.first_name as current_first_name, c.last_name as current_last_name,
           (c.id is not null) as exists_live,
           exists (select 1 from public.contacts a
                    where a.email = i.email and a.deleted_at is not null and a.removed_at is null)
             and c.id is null as archived_collision,
           -- A tag in the row that the contact (if any) does not have yet.
           exists (select 1 from _import_row_tags t
                    where t.email = i.email
                      and (c.id is null or not exists (
                            select 1 from public.contact_tags ct
                              join public.tags g on g.id = ct.tag_id
                             where ct.contact_id = c.id and lower(btrim(g.name)) = t.tag_key))) as has_new_tags
      from _import_rows i
      left join public.contacts c on c.email = i.email and c.deleted_at is null
  ), compared as (
    select m.*,
      (m.is_customer is true and m.current_status <> 'customer')
        or (m.is_customer is false and m.current_status = 'customer')
        or (m.subscribed_to_newsletter is false and m.current_newsletter)
        or (m.subscribed_to_programs is false and m.current_programs)
        or (m.first_name is distinct from m.current_first_name)
        or (m.last_name is distinct from m.current_last_name)
        or m.preferred_name is not null or m.mobile_number is not null or m.work_phone is not null
        or m.address is not null or m.suburb is not null or m.state is not null
        or m.postcode is not null or m.country is not null or m.department is not null
        or m."position" is not null or m.organisation_name is not null or m.job_type_name is not null
        as fields_changed
    from matched m
  ), classified as (
    select c.*,
      case
        when c.archived_collision then 'held_back'
        when not c.exists_live then 'new'
        when c.fields_changed or c.has_new_tags then 'changed'
        else 'unchanged'
      end as outcome
    from compared c
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
  ) || case when not v_has_tags then '{}'::jsonb else jsonb_build_object(
    'tags_only_changed', count(*) filter (where outcome = 'changed' and not fields_changed),
    'tags_assigned', count(*) filter (where outcome in ('new', 'changed') and has_new_tags),
    'tags_created', coalesce((
      select jsonb_agg(n.name order by n.tag_key)
        from (
          select distinct on (t.tag_key) t.tag_key, t.name
            from _import_row_tags t
            join _import_rows i on i.email = t.email
           -- Held-back rows are not imported, so their tags would not be created.
           where not (exists (select 1 from public.contacts a
                               where a.email = i.email and a.deleted_at is not null and a.removed_at is null)
                      and not exists (select 1 from public.contacts l
                                       where l.email = i.email and l.deleted_at is null))
             and not exists (select 1 from public.tags g where lower(btrim(g.name)) = t.tag_key)
           order by t.tag_key, t.email, t.ord
        ) n
    ), '[]'::jsonb)
  ) end
  into v_result
  from classified;

  return v_result;
end;
$$;

create or replace function public.import_contacts(payload jsonb, p_preview_token text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inserted      int := 0;
  v_updated       int := 0;
  v_total         int := coalesce(jsonb_array_length(payload), 0);
  v_usable        int := 0;
  v_distinct      int := 0;
  v_collisions    int := 0;
  v_has_tags      boolean := false;
  v_tags_created  int := 0;
  v_tags_assigned int := 0;
  v_result        jsonb;
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

  -- Held-back rows keep no tags either.
  delete from _import_row_tags t
   where not exists (select 1 from _import_rows i where i.email = t.email);
  v_has_tags := exists (select 1 from _import_row_tags);

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

  -- Tags: add only. Every staged contact now exists and is locked by the upsert above,
  -- which the 50-tag trigger on contact_tags relies on.
  if v_has_tags then
    with created as (
      insert into public.tags (name)
      select distinct on (tag_key) name
        from _import_row_tags
       order by tag_key, email, ord
      on conflict ((lower(btrim(name)))) do nothing
      returning 1
    )
    select count(*) into v_tags_created from created;

    with assigned as (
      insert into public.contact_tags (contact_id, tag_id)
      select c.id, g.id
        from _import_row_tags t
        join public.contacts c on c.email = t.email and c.deleted_at is null
        join public.tags g on lower(btrim(g.name)) = t.tag_key
      on conflict do nothing
      returning contact_id
    )
    select count(distinct contact_id) into v_tags_assigned from assigned;
  end if;

  v_result := jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated,
    'skipped',  v_total - v_usable,
    'duplicates', v_usable - v_distinct,
    'archived_collisions', v_collisions,
    'total',    v_total
  );

  if v_has_tags then
    v_result := v_result || jsonb_build_object(
      'tags_assigned', v_tags_assigned,
      'tags_created', v_tags_created
    );
  end if;

  return v_result;
end;
$$;

comment on function public.import_contacts(jsonb, text) is
  'Bulk contact upsert. Unmapped or blank fields never overwrite; is_customer only changes '
  'status when the spreadsheet says yes or no; consent is granted to new contacts unless '
  'withheld and never re-granted to existing ones; tag_names only ever add tags. With '
  'p_preview_token, refuses (CRM08) if a matched contact or the tag catalog changed since '
  'preview_import_contacts().';

revoke all on function public._import_tag_names(jsonb) from public, anon;
revoke all on function public._stage_import_rows(jsonb) from public, anon;
revoke all on function public._import_match_token() from public, anon;
revoke all on function public._import_tag_limit_violation() from public, anon;
revoke all on function public.preview_import_contacts(jsonb) from public, anon;
revoke all on function public.import_contacts(jsonb, text) from public, anon;
grant execute on function public._import_tag_names(jsonb) to authenticated, service_role;
grant execute on function public._stage_import_rows(jsonb) to authenticated, service_role;
grant execute on function public._import_match_token() to authenticated, service_role;
grant execute on function public._import_tag_limit_violation() to authenticated, service_role;
grant execute on function public.preview_import_contacts(jsonb) to authenticated, service_role;
grant execute on function public.import_contacts(jsonb, text) to authenticated, service_role;
