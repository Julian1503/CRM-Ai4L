-- Archive and remove, phase 2: contacts, templates, schedules and topics.
--
-- Same model as 20260930000000: nothing is physically deleted. `removed_at` is a soft
-- delete that hides a row everywhere in the application and cannot be undone from it;
-- it always implies archived. For contacts, "archived" is the existing `deleted_at`.
--
-- Refusals raise SQLSTATE CRM01, answered as 409 by the API.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid;

alter table public.campaign_templates
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid;

alter table public.newsletter_schedules
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid;

alter table public.newsletter_topics
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid;

do $$
begin
  alter table public.contacts
    add constraint contacts_removed_is_archived
    check (removed_at is null or deleted_at is not null);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.campaign_templates
    add constraint campaign_templates_removed_is_archived
    check (removed_at is null or archived_at is not null);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.newsletter_schedules
    add constraint newsletter_schedules_removed_is_archived
    check (removed_at is null or archived_at is not null);
exception
  when duplicate_object then null;
end $$;

-- A topic has no archive of its own: an unused one is queued or removed, a used one is
-- history. So a used topic can never be removed, and a removed one never used.
do $$
begin
  alter table public.newsletter_topics
    add constraint newsletter_topics_used_or_removed
    check (used_at is null or removed_at is null);
exception
  when duplicate_object then null;
end $$;

comment on column public.contacts.removed_at is
  'Set when the contact is removed: hidden everywhere, never physically deleted. Implies deleted_at (archived).';

-- ---------------------------------------------------------------------------
-- 2. No physical deletes
-- ---------------------------------------------------------------------------
drop policy if exists "Allow delete of unused topics to authenticated users" on public.newsletter_topics;

-- ---------------------------------------------------------------------------
-- 3. A removal is final for the application (function from 20260930000000)
-- ---------------------------------------------------------------------------
drop trigger if exists contacts_removal_final on public.contacts;
create trigger contacts_removal_final
    before update of removed_at, deleted_at on public.contacts
    for each row execute function public.enforce_removal_is_final();

drop trigger if exists campaign_templates_removal_final on public.campaign_templates;
create trigger campaign_templates_removal_final
    before update of removed_at, archived_at on public.campaign_templates
    for each row execute function public.enforce_removal_is_final();

drop trigger if exists newsletter_schedules_removal_final on public.newsletter_schedules;
create trigger newsletter_schedules_removal_final
    before update of removed_at, archived_at on public.newsletter_schedules
    for each row execute function public.enforce_removal_is_final();

drop trigger if exists newsletter_topics_removal_final on public.newsletter_topics;
create trigger newsletter_topics_removal_final
    before update of removed_at on public.newsletter_topics
    for each row execute function public.enforce_removal_is_final();

-- ---------------------------------------------------------------------------
-- 4. Consent never brings a removed contact back
-- ---------------------------------------------------------------------------
-- As in 20260901000000, except for the un-archive branch: regaining consent restores a
-- contact archived for opting out, but never one that was removed. Without the guard
-- the restore would also violate contacts_removed_is_archived and fail the write --
-- which would be a newsletter webhook or a preference-centre click erroring out.
create or replace function public.sync_contact_customer_status()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_had_consent boolean;
  v_has_consent boolean;
begin
  v_has_consent := new.subscribed_to_newsletter or new.subscribed_to_programs;

  if tg_op = 'UPDATE' then
    v_had_consent := old.subscribed_to_newsletter or old.subscribed_to_programs;

    if v_had_consent and not v_has_consent and new.deleted_at is null then
      new.deleted_at := timezone('utc'::text, now());
      new.archive_reason := 'opted_out';
    end if;

    if not v_had_consent and v_has_consent
       and new.deleted_at is not null
       and new.archive_reason = 'opted_out'
       and new.removed_at is null
    then
      new.deleted_at := null;
      new.archive_reason := null;
    end if;
  end if;

  if new.deleted_at is not null then
    new.status := 'archived'::public.contact_status;
    new.archive_reason := coalesce(new.archive_reason, 'manual');
  else
    if new.status = 'archived'::public.contact_status then
      new.status := 'prospect'::public.contact_status;
    end if;
    new.archive_reason := null;
  end if;

  new.is_customer := (new.status = 'customer'::public.contact_status);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Import: a removed contact does not hold its address back
-- ---------------------------------------------------------------------------
-- As in 20260901010000, with two changes:
--   * Only an *archived, not removed* contact holds an address back. A removed one can
--     never be restored from the application, so holding its address back would lock
--     that address out of imports for good.
--   * An address with a removed record is imported with no more consent than its latest
--     removed record held. Consent is never raised by an import, and removing a contact
--     must not become a way to re-subscribe someone who unsubscribed. Conservative on
--     purpose: a consent the old record simply never had is not granted either.
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
    left join lateral (
      select c.subscribed_to_newsletter, c.subscribed_to_programs
      from public.contacts c
      where c.email = i.email and c.removed_at is not null
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

-- ---------------------------------------------------------------------------
-- 6. Templates and schedules: a live schedule keeps its template live
-- ---------------------------------------------------------------------------
-- The runner re-checks the template on every run and reports `template_unusable`, but a
-- schedule that silently stops working is exactly what these rules exist to prevent.
create or replace function public.lock_template_for_archive_rules(p_template_id uuid)
returns void
language sql
volatile
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended('template-archive:' || p_template_id::text, 0));
$$;

create or replace function public.enforce_template_archivable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_schedule text;
begin
  if new.archived_at is null or old.archived_at is not null then
    return new;
  end if;

  perform public.lock_template_for_archive_rules(new.id);

  select name into v_schedule
  from public.newsletter_schedules
  where template_id = new.id and archived_at is null
  limit 1;

  if found then
    raise exception 'Template is in use by newsletter schedule "%". Archive that first.', v_schedule
      using errcode = 'CRM01';
  end if;

  return new;
end;
$$;

drop trigger if exists campaign_templates_archivable on public.campaign_templates;
create trigger campaign_templates_archivable
    before update of archived_at on public.campaign_templates
    for each row execute function public.enforce_template_archivable();

create or replace function public.enforce_schedule_template_live()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.archived_at is not null then
    return new;
  end if;

  perform public.lock_template_for_archive_rules(new.template_id);

  if exists (
    select 1 from public.campaign_templates t
    where t.id = new.template_id and t.archived_at is not null
  ) then
    raise exception 'Template is archived. Choose another template or restore it first.'
      using errcode = 'CRM01';
  end if;

  return new;
end;
$$;

drop trigger if exists newsletter_schedules_template_live on public.newsletter_schedules;
create trigger newsletter_schedules_template_live
    before insert or update of template_id, archived_at on public.newsletter_schedules
    for each row execute function public.enforce_schedule_template_live();

-- ---------------------------------------------------------------------------
-- 7. Uniqueness only among live rows
-- ---------------------------------------------------------------------------
-- As for segments in 20260930000000: an archived or removed name never blocks reusing
-- it. Removed rows are invisible, so a clash with one could not even be explained.
drop index if exists public.campaign_templates_name_ci_idx;
create unique index campaign_templates_name_ci_idx
    on public.campaign_templates (lower(btrim(name))) where archived_at is null;

drop index if exists public.newsletter_schedules_name_ci_idx;
create unique index newsletter_schedules_name_ci_idx
    on public.newsletter_schedules (lower(btrim(name))) where archived_at is null;

-- One live draft per schedule occurrence. Archiving or removing an issue is how an
-- operator throws it away; "Generate now" can then draft that day again instead of
-- pointing at a campaign nobody can see.
drop index if exists public.campaigns_schedule_occurrence_idx;
create unique index campaigns_schedule_occurrence_idx
    on public.campaigns (schedule_id, scheduled_for)
    where schedule_id is not null and archived_at is null;
