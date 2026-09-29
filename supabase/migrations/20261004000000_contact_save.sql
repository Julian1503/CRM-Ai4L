-- Atomic, validated contact saves (audit H8).
--
-- The contact drawer used to save in four independent browser requests: look up or
-- create the organisation, update the contact, delete every service link, insert the new
-- links. A failure between the delete and the insert lost the contact's services; an
-- invalid service id did the same; and two operators editing one contact silently
-- overwrote each other. save_contact() does all of it in one transaction, validates
-- every reference first, and refuses to write over a revision the caller did not see.

alter table public.contacts
    add column if not exists revision integer not null default 1;

comment on column public.contacts.revision is
  'Moves on every change to the row. Editors send the revision they loaded; a mismatch is an edit conflict.';

create or replace function public.bump_contact_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision := old.revision + 1;
  return new;
end;
$$;

drop trigger if exists contacts_revision on public.contacts;
create trigger contacts_revision
    before update on public.contacts
    for each row execute function public.bump_contact_revision();

-- A new contacts column: active_contacts must carry every column of contacts.
create or replace view public.active_contacts
with (security_invoker = on) as
select * from public.contacts where deleted_at is null;
revoke all on public.active_contacts from anon;

/*
 * Creates (p_contact->>'id' absent) or updates one contact, with its organisation and
 * its services, atomically.
 *
 *   p_contact            snake_case contact fields plus `organisation_name`
 *   p_services           the complete set of service ids (applied only to customers)
 *   p_expected_revision  the revision the editor loaded; null only for creation
 *
 * Errors: CRM07 validation (nothing written), CRM06 edit conflict, P0002 not found,
 * 23505 duplicate active email.
 */
create or replace function public.save_contact(
  p_contact           jsonb,
  p_services          uuid[] default '{}',
  p_expected_revision integer default null
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

  return to_jsonb(v_saved) || jsonb_build_object(
    'services', (select coalesce(jsonb_agg(service_id), '[]'::jsonb)
                   from public.contact_services where contact_id = v_saved.id),
    'organisation', case when v_org_id is null then null
                         else jsonb_build_object('name', (select name from public.organisations where id = v_org_id)) end
  );
end;
$$;

revoke all on function public.save_contact(jsonb, uuid[], integer) from public, anon;
grant execute on function public.save_contact(jsonb, uuid[], integer) to authenticated, service_role;
