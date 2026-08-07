-- Phase 0.1 — Soft delete, job types, contact status, and a safe bulk-import path.
--
-- Why the import RPC exists: making the email uniqueness partial (ignoring archived
-- rows) means a bare `ON CONFLICT (email)` can no longer infer an index. supabase-js
-- cannot emit the required index predicate, so the client-side bulk upsert in
-- src/app/page.tsx is replaced by the import_contacts() function at the bottom of
-- this file, which can express `ON CONFLICT (email) WHERE deleted_at IS NULL`.

-- ---------------------------------------------------------------------------
-- 1. Organisations: de-duplicate, then enforce case-insensitive uniqueness
-- ---------------------------------------------------------------------------
-- The previous lookup-then-insert path (page.tsx) was race-prone and could create
-- duplicate organisations differing only by case/whitespace. Collapse them onto the
-- oldest row and repoint contacts before adding the constraint.

with ranked as (
  select
    id,
    first_value(id) over (
      partition by lower(btrim(name)) order by created_at, id
    ) as keep_id
  from public.organisations
)
update public.contacts c
set organisation_id = r.keep_id
from ranked r
where c.organisation_id = r.id
  and r.id <> r.keep_id;

with ranked as (
  select
    id,
    first_value(id) over (
      partition by lower(btrim(name)) order by created_at, id
    ) as keep_id
  from public.organisations
)
delete from public.organisations o
using ranked r
where o.id = r.id
  and r.id <> r.keep_id;

create unique index if not exists organisations_name_ci_idx
  on public.organisations (lower(btrim(name)));

-- ---------------------------------------------------------------------------
-- 2. Job types (scope 3.1: "job type" as a filterable field)
-- ---------------------------------------------------------------------------
create table if not exists public.job_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create unique index if not exists job_types_name_ci_idx
  on public.job_types (lower(btrim(name)));

alter table public.contacts
  add column if not exists job_type_id uuid references public.job_types(id) on delete set null;

alter table public.job_types enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'job_types'
      and policyname = 'Allow read access to authenticated users'
  ) then
    create policy "Allow read access to authenticated users"
      on public.job_types for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'job_types'
      and policyname = 'Allow insert access to authenticated users'
  ) then
    create policy "Allow insert access to authenticated users"
      on public.job_types for insert to authenticated with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'job_types'
      and policyname = 'Allow update access to authenticated users'
  ) then
    create policy "Allow update access to authenticated users"
      on public.job_types for update to authenticated using (true) with check (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Contact status enum (replaces the is_customer boolean)
-- ---------------------------------------------------------------------------
do $$
begin
  create type public.contact_status as enum ('lead', 'prospect', 'customer', 'archived');
exception
  when duplicate_object then null;
end $$;

alter table public.contacts
  add column if not exists status public.contact_status not null default 'lead';

-- Backfill from the existing boolean. is_customer is intentionally retained for now
-- so nothing breaks mid-migration; a later migration drops it once no code reads it.
update public.contacts
set status = case when is_customer then 'customer'::public.contact_status
                  else 'prospect'::public.contact_status end
where status = 'lead';

-- ---------------------------------------------------------------------------
-- 4. Soft delete
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists deleted_at timestamptz;

-- Drop whatever single-column UNIQUE constraint exists on contacts(email). Looked up
-- by shape rather than by name so this works regardless of the generated name.
do $$
declare
  v_constraint text;
  v_email_attnum smallint;
begin
  select attnum into v_email_attnum
  from pg_attribute
  where attrelid = 'public.contacts'::regclass and attname = 'email';

  select con.conname into v_constraint
  from pg_constraint con
  where con.conrelid = 'public.contacts'::regclass
    and con.contype = 'u'
    and con.conkey = array[v_email_attnum];

  if v_constraint is not null then
    execute format('alter table public.contacts drop constraint %I', v_constraint);
  end if;
end $$;

-- Email is unique only among live contacts, so an archived contact never blocks
-- re-importing the same address.
create unique index if not exists contacts_email_active_idx
  on public.contacts (email) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 5. Filter indexes (scope 3.1: filter by job type, state, status)
-- ---------------------------------------------------------------------------
create index if not exists contacts_status_idx    on public.contacts (status)      where deleted_at is null;
create index if not exists contacts_state_idx     on public.contacts (state)       where deleted_at is null;
create index if not exists contacts_job_type_idx  on public.contacts (job_type_id) where deleted_at is null;
create index if not exists contacts_deleted_at_idx on public.contacts (deleted_at) where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- 6. active_contacts view
-- ---------------------------------------------------------------------------
-- security_invoker keeps the caller's RLS in force (Postgres 15+). Default reads go
-- through this view so a forgotten `.is('deleted_at', null)` cannot leak archived rows;
-- the archive screen queries public.contacts directly with an explicit filter.
create or replace view public.active_contacts
with (security_invoker = on) as
select * from public.contacts where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 7. import_contacts() — bulk upsert honouring the partial unique index
-- ---------------------------------------------------------------------------
-- Accepts a JSON array of snake_case contact objects. Resolves organisation_name and
-- job_type_name to ids (creating them if needed), de-duplicates by email within the
-- batch, and upserts. Returns {inserted, updated, skipped, total}.
--
-- security invoker: runs as the calling user so RLS still applies.
-- set search_path: prevents search_path hijacking (Supabase security lint).
create or replace function public.import_contacts(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_updated  int := 0;
  v_total    int := 0;
  v_usable   int := 0;
begin
  if payload is null or jsonb_typeof(payload) <> 'array' then
    raise exception 'import_contacts: payload must be a JSON array, got %',
      coalesce(jsonb_typeof(payload), 'null');
  end if;

  v_total := jsonb_array_length(payload);

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
    coalesce((r->>'is_customer')::boolean, false)              as is_customer,
    coalesce((r->>'subscribed_to_newsletter')::boolean, false) as subscribed_to_newsletter
  from jsonb_array_elements(payload) with ordinality as t(r, ord)
  where nullif(btrim(r->>'email'), '') is not null
    and nullif(btrim(r->>'first_name'), '') is not null
    and nullif(btrim(r->>'last_name'), '') is not null
  order by email, ord;

  select count(*) into v_usable from _import_rows;

  if v_usable = 0 then
    return jsonb_build_object(
      'inserted', 0, 'updated', 0, 'skipped', v_total, 'total', v_total
    );
  end if;

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
      organisation_id, job_type_id, is_customer, status, subscribed_to_newsletter
    )
    select
      i.email, i.first_name, i.last_name, i.preferred_name, i.mobile_number, i.work_phone,
      i.address, i.suburb, i.state, i.postcode, i.country, i.department, i."position",
      o.id, jt.id, i.is_customer,
      case when i.is_customer then 'customer'::public.contact_status
           else 'prospect'::public.contact_status end,
      i.subscribed_to_newsletter
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
      subscribed_to_newsletter = excluded.subscribed_to_newsletter
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
    'total',    v_total
  );
end;
$$;

comment on function public.import_contacts(jsonb) is
  'Bulk contact upsert. Required because the partial unique index contacts_email_active_idx '
  'cannot be inferred by a bare ON CONFLICT (email) from supabase-js.';
