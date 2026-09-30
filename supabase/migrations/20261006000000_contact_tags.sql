-- CRM contact tags, bulk tagging, tags in save_contact, and the organisation industry
-- filter (docs/CLIENT_FEATURES_IMPLEMENTATION_PLAN.md, B and D; contract in section 8).
--
-- Tags are CRM-owned and unrelated to EmailOctopus tags. A tag name is unique after
-- trimming and ignoring case; the stored spelling is what the UI shows. Every stored
-- name is kept in one normalised form (normalize_tag_name) so that the unique index on
-- lower(btrim(name)) and the application's comparison key agree.
--
-- Every effective change to a contact's tags moves contacts.revision, whichever path
-- makes it (drawer save, bulk action, import). That is what lets an open drawer or an
-- import preview notice that the contact changed underneath it.
--
-- Error codes follow save_contact: CRM07 validation (nothing written), CRM06 stale
-- selection / edit conflict. CRM07 carries a hint where the caller must tell cases
-- apart: `stale_tags` (a tag no longer exists) and `tag_limit` (a contact would exceed
-- 50 tags).

-- ---------------------------------------------------------------------------
-- 1. Catalog and assignments
-- ---------------------------------------------------------------------------

-- The one definition of a tag name's normal form: whitespace runs collapsed, trimmed,
-- empty as null. Mirrors normalizeTagName() in src/lib/contacts/tags.ts.
create or replace function public.normalize_tag_name(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(p_name, '\s+', ' ', 'g')), '');
$$;

create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint tags_name_length check (char_length(name) between 1 and 80),
  constraint tags_name_normalised check (name = public.normalize_tag_name(name))
);

create unique index if not exists tags_name_ci_idx on public.tags (lower(btrim(name)));

comment on table public.tags is
  'CRM-owned contact tags (not EmailOctopus tags). Unique on lower(btrim(name)); never physically deleted by the application.';

-- Contacts are never physically deleted (archive and removal are soft), so the cascades
-- only matter to an administrator working in SQL; they keep that path consistent.
create table if not exists public.contact_tags (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id     uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default timezone('utc'::text, now()),
  primary key (contact_id, tag_id)
);

-- The primary key serves reads by contact; this serves the "has any of these tags"
-- filter, which starts from the tag.
create index if not exists contact_tags_tag_idx on public.contact_tags (tag_id, contact_id);

comment on table public.contact_tags is
  'Tags assigned to a contact. Relationship rows, not CRM records: removing a tag deletes the link.';

-- At most 50 tags per contact, whatever path writes the links. Statement-level with a
-- transition table so a bulk insert of 2,000 x 50 links costs one grouped check, not
-- 100,000. Every writer (save_contact, apply_contact_tags, import_contacts) locks the
-- contact row first, so two concurrent writers cannot both pass the check.
create or replace function public.enforce_contact_tag_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_email text;
begin
  select c.email into v_email
    from public.contact_tags ct
    join public.contacts c on c.id = ct.contact_id
   where ct.contact_id in (select distinct i.contact_id from inserted i)
   group by c.id, c.email
  having count(*) > 50
   limit 1;

  if v_email is not null then
    raise exception 'A contact can have at most 50 tags; % would have more.', v_email
      using errcode = 'CRM07', hint = 'tag_limit';
  end if;

  return null;
end;
$$;

drop trigger if exists contact_tags_limit on public.contact_tags;
create trigger contact_tags_limit
  after insert on public.contact_tags
  referencing new table as inserted
  for each statement execute function public.enforce_contact_tag_limit();

-- ---------------------------------------------------------------------------
-- 2. Access: approved CRM members only (docs/ACCESS_CONTROL.md)
-- ---------------------------------------------------------------------------
-- Same shape as every other table since 20261002000100: permissive policies for the
-- operations the table allows, ANDed with a restrictive membership policy. No DELETE
-- on tags (catalog records are never physically deleted by the application) and no
-- UPDATE yet (renaming is out of scope). Links can be deleted: they are relationships.
alter table public.tags enable row level security;
alter table public.contact_tags enable row level security;

revoke all on public.tags from anon, authenticated;
revoke all on public.contact_tags from anon, authenticated;
grant select, insert on public.tags to authenticated;
grant select, insert, delete on public.contact_tags to authenticated;
grant all on public.tags to service_role;
grant all on public.contact_tags to service_role;

drop policy if exists "Allow read access to authenticated users" on public.tags;
drop policy if exists "Allow insert access to authenticated users" on public.tags;
drop policy if exists "Approved CRM members only" on public.tags;
create policy "Allow read access to authenticated users"
  on public.tags for select to authenticated using (true);
create policy "Allow insert access to authenticated users"
  on public.tags for insert to authenticated with check (true);
create policy "Approved CRM members only"
  on public.tags as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

drop policy if exists "Allow read access to authenticated users" on public.contact_tags;
drop policy if exists "Allow insert access to authenticated users" on public.contact_tags;
drop policy if exists "Allow delete access to authenticated users" on public.contact_tags;
drop policy if exists "Approved CRM members only" on public.contact_tags;
create policy "Allow read access to authenticated users"
  on public.contact_tags for select to authenticated using (true);
create policy "Allow insert access to authenticated users"
  on public.contact_tags for insert to authenticated with check (true);
create policy "Allow delete access to authenticated users"
  on public.contact_tags for delete to authenticated using (true);
create policy "Approved CRM members only"
  on public.contact_tags as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

-- ---------------------------------------------------------------------------
-- 3. create_tag: find-or-create by normalised name
-- ---------------------------------------------------------------------------
/*
 * Returns {tag: {id, name}, created}. An existing tag with the same key is returned
 * as-is (its spelling wins), including when a concurrent request created it first.
 * Errors: CRM07 empty or over-long name.
 */
create or replace function public.create_tag(p_name text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_name    text := public.normalize_tag_name(p_name);
  v_tag     public.tags;
  v_created boolean := false;
begin
  if v_name is null then
    raise exception 'A tag name is required.' using errcode = 'CRM07';
  end if;
  if char_length(v_name) > 80 then
    raise exception 'A tag name can be at most 80 characters.' using errcode = 'CRM07';
  end if;

  insert into public.tags (name) values (v_name)
  on conflict ((lower(btrim(name)))) do nothing
  returning * into v_tag;

  if v_tag.id is null then
    -- Already in the catalog, or a concurrent insert of the same name won: use theirs.
    select * into v_tag from public.tags where lower(btrim(name)) = lower(v_name);
  else
    v_created := true;
  end if;

  return jsonb_build_object(
    'tag', jsonb_build_object('id', v_tag.id, 'name', v_tag.name),
    'created', v_created
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. apply_contact_tags: bulk add/remove over an explicit selection
-- ---------------------------------------------------------------------------
/*
 * Adds or removes p_tag_ids on every contact in p_contact_ids, all or nothing.
 *
 * An empty selection never means "every contact". Contacts are locked in id order so
 * two overlapping batches queue instead of deadlocking. Repeating an operation is a
 * no-op, and only contacts whose tag set actually changed get a new revision.
 *
 * Returns {updated}: the number of contacts whose tags changed.
 * Errors: 42501 not a member; CRM07 bad operation, empty or oversized list, unknown tag
 * (hint stale_tags) or a contact over 50 tags (hint tag_limit); CRM06 a selected
 * contact is missing, archived or removed.
 */
create or replace function public.apply_contact_tags(
  p_contact_ids uuid[],
  p_tag_ids     uuid[],
  p_operation   text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_contacts uuid[];
  v_tags     uuid[];
  v_locked   integer;
  v_changed  uuid[];
begin
  -- RLS would refuse a non-member anyway; checking first gives a clear error instead of
  -- a misleading "contacts missing".
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  if p_operation is null or p_operation not in ('add', 'remove') then
    raise exception 'Operation must be add or remove.' using errcode = 'CRM07';
  end if;

  select coalesce(array_agg(distinct c), '{}') into v_contacts
    from unnest(coalesce(p_contact_ids, '{}')) c where c is not null;
  select coalesce(array_agg(distinct t), '{}') into v_tags
    from unnest(coalesce(p_tag_ids, '{}')) t where t is not null;

  if cardinality(v_contacts) = 0 then
    raise exception 'Select at least one contact.' using errcode = 'CRM07';
  end if;
  if cardinality(v_contacts) > 2000 then
    raise exception 'Select at most 2000 contacts.' using errcode = 'CRM07';
  end if;
  if cardinality(v_tags) = 0 then
    raise exception 'Choose at least one tag.' using errcode = 'CRM07';
  end if;
  if cardinality(v_tags) > 50 then
    raise exception 'Choose at most 50 tags.' using errcode = 'CRM07';
  end if;

  if (select count(*) from public.tags where id = any (v_tags)) <> cardinality(v_tags) then
    raise exception 'A selected tag no longer exists. Refresh the tags and try again.'
      using errcode = 'CRM07', hint = 'stale_tags';
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

  if p_operation = 'add' then
    with added as (
      insert into public.contact_tags (contact_id, tag_id)
      select c, t from unnest(v_contacts) c cross join unnest(v_tags) t
      on conflict do nothing
      returning contact_id
    )
    select coalesce(array_agg(distinct contact_id), '{}') into v_changed from added;
  else
    with removed as (
      delete from public.contact_tags
       where contact_id = any (v_contacts)
         and tag_id = any (v_tags)
      returning contact_id
    )
    select coalesce(array_agg(distinct contact_id), '{}') into v_changed from removed;
  end if;

  -- A no-op SET still fires contacts_revision, which moves the revision. Column-specific
  -- triggers (consent, status, archive rules) do not fire: `revision` is all that is set.
  if cardinality(v_changed) > 0 then
    update public.contacts set revision = revision where id = any (v_changed);
  end if;

  return jsonb_build_object('updated', cardinality(v_changed));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. save_contact gains p_tags
-- ---------------------------------------------------------------------------
-- Dropped rather than overloaded: a (jsonb, uuid[], integer) and a
-- (jsonb, uuid[], integer, uuid[] default null) function would make every existing
-- three-argument call ambiguous.
drop function if exists public.save_contact(jsonb, uuid[], integer);

/*
 * Creates (p_contact->>'id' absent) or updates one contact, with its organisation, its
 * services and its tags, atomically.
 *
 *   p_contact            snake_case contact fields plus `organisation_name`
 *   p_services           the complete set of service ids (applied only to customers)
 *   p_expected_revision  the revision the editor loaded; null only for creation
 *   p_tags               the complete set of tag ids; null keeps the contact's tags,
 *                        '{}' clears them (a client that predates tags sends nothing)
 *
 * An update always moves the revision (contacts_revision), so a tag change made here is
 * covered by the same revision step as the field changes.
 *
 * Errors: CRM07 validation (nothing written), CRM06 edit conflict, P0002 not found,
 * 23505 duplicate active email.
 */
create or replace function public.save_contact(
  p_contact           jsonb,
  p_services          uuid[] default '{}',
  p_expected_revision integer default null,
  p_tags              uuid[] default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id       uuid := nullif(p_contact->>'id', '')::uuid;
  v_org_name text := nullif(btrim(coalesce(p_contact->>'organisation_name', '')), '');
  v_org_id   uuid;
  v_status   text := coalesce(nullif(p_contact->>'status', ''), 'prospect');
  v_job_type uuid := nullif(p_contact->>'job_type_id', '')::uuid;
  v_email    text := lower(btrim(coalesce(p_contact->>'email', '')));
  v_services uuid[] := coalesce(p_services, '{}');
  v_tags     uuid[];
  v_unknown  uuid;
  v_saved    public.contacts;
begin
  -- Validate everything before writing anything.
  if coalesce(btrim(p_contact->>'first_name'), '') = '' then
    raise exception 'First name is required.' using errcode = 'CRM07';
  end if;
  if coalesce(btrim(p_contact->>'last_name'), '') = '' then
    raise exception 'Last name is required.' using errcode = 'CRM07';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'A valid email address is required.' using errcode = 'CRM07';
  end if;
  if v_status not in ('lead', 'prospect', 'customer') then
    -- Archiving is a lifecycle action with its own rules, not a field edit.
    raise exception 'Status must be lead, prospect or customer.' using errcode = 'CRM07';
  end if;
  if v_job_type is not null and not exists (select 1 from public.job_types where id = v_job_type) then
    raise exception 'That job type does not exist.' using errcode = 'CRM07';
  end if;
  select s into v_unknown from unnest(v_services) s
   where not exists (select 1 from public.services where id = s) limit 1;
  if v_unknown is not null then
    raise exception 'Unknown service %.', v_unknown using errcode = 'CRM07';
  end if;
  if p_tags is not null then
    select coalesce(array_agg(distinct t), '{}') into v_tags from unnest(p_tags) t where t is not null;
    if cardinality(v_tags) > 50 then
      raise exception 'A contact can have at most 50 tags.' using errcode = 'CRM07', hint = 'tag_limit';
    end if;
    select t into v_unknown from unnest(v_tags) t
     where not exists (select 1 from public.tags where id = t) limit 1;
    if v_unknown is not null then
      raise exception 'A selected tag no longer exists. Refresh the tags and try again.'
        using errcode = 'CRM07', hint = 'stale_tags';
    end if;
  end if;
  if v_id is not null and p_expected_revision is null then
    raise exception 'Send the revision you are editing.' using errcode = 'CRM07';
  end if;

  -- Organisation, matched the way its unique index compares: lower(btrim(name)).
  if v_org_name is not null then
    select id into v_org_id from public.organisations where lower(btrim(name)) = lower(v_org_name);
    if v_org_id is null then
      insert into public.organisations (name) values (v_org_name)
      on conflict ((lower(btrim(name)))) do nothing
      returning id into v_org_id;
      -- Lost a race to a concurrent insert of the same name: use theirs.
      if v_org_id is null then
        select id into v_org_id from public.organisations where lower(btrim(name)) = lower(v_org_name);
      end if;
    end if;
  end if;

  -- Consent changes made here are an operator's, and the ledger says so.
  perform set_config('app.consent_source', 'crm_operator', true);

  if v_id is null then
    insert into public.contacts (
      first_name, last_name, preferred_name, email, mobile_number, work_phone, address,
      suburb, state, postcode, country, organisation_id, job_type_id, department, position,
      notes, status, is_customer, subscribed_to_newsletter, subscribed_to_programs, source
    ) values (
      btrim(p_contact->>'first_name'), btrim(p_contact->>'last_name'),
      nullif(p_contact->>'preferred_name', ''), v_email,
      nullif(p_contact->>'mobile_number', ''), nullif(p_contact->>'work_phone', ''),
      nullif(p_contact->>'address', ''), nullif(p_contact->>'suburb', ''),
      nullif(p_contact->>'state', ''), nullif(p_contact->>'postcode', ''),
      nullif(p_contact->>'country', ''), v_org_id, v_job_type,
      nullif(p_contact->>'department', ''), nullif(p_contact->>'position', ''),
      nullif(p_contact->>'notes', ''), v_status::public.contact_status, v_status = 'customer',
      coalesce((p_contact->>'subscribed_to_newsletter')::boolean, false),
      coalesce((p_contact->>'subscribed_to_programs')::boolean, false),
      'manual'
    )
    returning * into v_saved;
  else
    update public.contacts set
      first_name = btrim(p_contact->>'first_name'),
      last_name = btrim(p_contact->>'last_name'),
      preferred_name = nullif(p_contact->>'preferred_name', ''),
      email = v_email,
      mobile_number = nullif(p_contact->>'mobile_number', ''),
      work_phone = nullif(p_contact->>'work_phone', ''),
      address = nullif(p_contact->>'address', ''),
      suburb = nullif(p_contact->>'suburb', ''),
      state = nullif(p_contact->>'state', ''),
      postcode = nullif(p_contact->>'postcode', ''),
      country = nullif(p_contact->>'country', ''),
      organisation_id = v_org_id,
      job_type_id = v_job_type,
      department = nullif(p_contact->>'department', ''),
      position = nullif(p_contact->>'position', ''),
      notes = nullif(p_contact->>'notes', ''),
      status = v_status::public.contact_status,
      is_customer = v_status = 'customer',
      subscribed_to_newsletter = coalesce((p_contact->>'subscribed_to_newsletter')::boolean, subscribed_to_newsletter),
      subscribed_to_programs = coalesce((p_contact->>'subscribed_to_programs')::boolean, subscribed_to_programs)
    where id = v_id
      and removed_at is null
      and deleted_at is null
      and revision = p_expected_revision
    returning * into v_saved;

    if v_saved.id is null then
      perform set_config('app.consent_source', '', true);
      if exists (select 1 from public.contacts where id = v_id and removed_at is null and deleted_at is null) then
        raise exception 'Someone else changed this contact while you were editing. Reload to see their changes.'
          using errcode = 'CRM06';
      end if;
      raise exception 'Contact not found.' using errcode = 'P0002';
    end if;
  end if;

  perform set_config('app.consent_source', '', true);

  -- Services: the complete set, for customers only (unchanged semantics). Links not in
  -- the set are unlinked; relationship rows are not CRM records.
  if v_status = 'customer' then
    delete from public.contact_services
     where contact_id = v_saved.id and service_id <> all (v_services);
    insert into public.contact_services (contact_id, service_id)
    select v_saved.id, s from unnest(v_services) s
    on conflict do nothing;
  else
    delete from public.contact_services where contact_id = v_saved.id;
  end if;

  -- Tags: the complete set when given; untouched when p_tags is null. The contact row is
  -- already locked by the insert/update above, which the 50-tag trigger relies on.
  if p_tags is not null then
    delete from public.contact_tags
     where contact_id = v_saved.id and tag_id <> all (v_tags);
    insert into public.contact_tags (contact_id, tag_id)
    select v_saved.id, t from unnest(v_tags) t
    on conflict do nothing;
  end if;

  return to_jsonb(v_saved) || jsonb_build_object(
    'services', (select coalesce(jsonb_agg(service_id), '[]'::jsonb)
                   from public.contact_services where contact_id = v_saved.id),
    'tags', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name)
                                       order by lower(g.name)), '[]'::jsonb)
               from public.contact_tags ct
               join public.tags g on g.id = ct.tag_id
              where ct.contact_id = v_saved.id),
    'organisation', case when v_org_id is null then null
                         else jsonb_build_object('name', (select name from public.organisations where id = v_org_id)) end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Organisation industry: comparison key and facet
-- ---------------------------------------------------------------------------
-- The industry filter matches ignoring case and outer spaces. PostgREST cannot apply
-- lower(btrim()) to an embedded column, so the key is a generated column the filter
-- compares with plain equality. Existing values are not rewritten.
alter table public.organisations
  add column if not exists industry_key text
  generated always as (nullif(lower(btrim(industry)), '')) stored;

create index if not exists organisations_industry_key_idx
  on public.organisations (industry_key) where industry_key is not null;

-- New writes only (NOT VALID): existing rows are reviewed before any clean-up.
alter table public.organisations drop constraint if exists organisations_industry_length;
alter table public.organisations
  add constraint organisations_industry_length
  check (industry is null or char_length(industry) <= 120) not valid;

/*
 * Distinct industries for the filter's options: one entry per comparison key, shown in
 * its most common spelling, sorted, at most 200. p_q narrows by substring (no LIKE, so
 * `%` and `_` are literal).
 */
create or replace function public.organisation_industries(
  p_q     text default null,
  p_limit integer default 200
)
returns text[]
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(array_agg(s.display order by s.key), '{}')
    from (
      select o.industry_key as key,
             mode() within group (order by btrim(o.industry)) as display
        from public.organisations o
       where o.industry_key is not null
         and (nullif(btrim(p_q), '') is null or strpos(o.industry_key, lower(btrim(p_q))) > 0)
       group by o.industry_key
       order by o.industry_key
       limit greatest(1, least(coalesce(p_limit, 200), 200))
    ) s;
$$;

-- ---------------------------------------------------------------------------
-- 7. Function privileges
-- ---------------------------------------------------------------------------
revoke all on function public.normalize_tag_name(text) from public, anon;
revoke all on function public.enforce_contact_tag_limit() from public, anon;
revoke all on function public.create_tag(text) from public, anon;
revoke all on function public.apply_contact_tags(uuid[], uuid[], text) from public, anon;
revoke all on function public.save_contact(jsonb, uuid[], integer, uuid[]) from public, anon;
revoke all on function public.organisation_industries(text, integer) from public, anon;
grant execute on function public.normalize_tag_name(text) to authenticated, service_role;
grant execute on function public.create_tag(text) to authenticated, service_role;
grant execute on function public.apply_contact_tags(uuid[], uuid[], text) to authenticated, service_role;
grant execute on function public.save_contact(jsonb, uuid[], integer, uuid[]) to authenticated, service_role;
grant execute on function public.organisation_industries(text, integer) to authenticated, service_role;
