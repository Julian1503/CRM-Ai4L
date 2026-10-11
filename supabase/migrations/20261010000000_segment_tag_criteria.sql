-- Saved groups by tag (client features plan §8, "Grupos"): segments can select on CRM
-- tags — contacts having ANY of the chosen tags, and/or NONE of the excluded tags.
--
-- segment_contacts() gains one column, `tag_ids` (the contact's tag ids, flattened like
-- `service_ids`), so the criteria stay plain PostgREST array tests applied by the
-- application (`tag_ids=ov.{...}`, `tag_ids=not.ov.{...}`), inside the same
-- `is_included OR (criteria)` group as every other criterion.
--
-- Nothing else changes: the same rows (active contacts minus the segment's exclusions,
-- inclusions flagged), the same columns in the same order, the consent gate still applied
-- by the caller beside the criteria, archived/removed contacts still out (`deleted_at is
-- null` is unchanged, and archiving/removal keep their own triggers on contacts).
--
-- A tag removed from the catalogue (only possible from SQL; contact_tags cascades) never
-- breaks a saved segment: its id simply matches nobody. "Any of [removed]" selects no one
-- (narrower, never wider) and "none of [removed]" excludes no one.
--
-- The return type changes, so the function is dropped and recreated (the migration runs
-- as one transaction); nothing in the database depends on it (callers are the
-- application's RPC calls).

drop function if exists public.segment_contacts(uuid);

create function public.segment_contacts(p_segment_id uuid default null)
returns table (
    id uuid,
    first_name text,
    last_name text,
    email text,
    mobile_number text,
    work_phone text,
    organisation_id uuid,
    job_type_id uuid,
    state text,
    status public.contact_status,
    department text,
    "position" text,
    source text,
    created_at timestamptz,
    subscribed_to_newsletter boolean,
    subscribed_to_programs boolean,
    service_ids uuid[],
    is_included boolean,
    tag_ids uuid[]
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    c.id,
    c.first_name,
    c.last_name,
    c.email,
    c.mobile_number,
    c.work_phone,
    c.organisation_id,
    c.job_type_id,
    c.state,
    c.status,
    c.department,
    c."position",
    c.source,
    c.created_at,
    c.subscribed_to_newsletter,
    c.subscribed_to_programs,
    coalesce(
      (select array_agg(cs.service_id) from public.contact_services cs where cs.contact_id = c.id),
      '{}'::uuid[]
    ) as service_ids,
    coalesce(o.mode = 'include', false) as is_included,
    coalesce(
      (select array_agg(ct.tag_id order by ct.tag_id) from public.contact_tags ct where ct.contact_id = c.id),
      '{}'::uuid[]
    ) as tag_ids
  from public.contacts c
  left join public.segment_overrides o
    on o.segment_id = p_segment_id and o.contact_id = c.id
  where c.deleted_at is null
    and o.mode is distinct from 'exclude';
$$;

comment on function public.segment_contacts(uuid) is
  'Active contacts a segment can draw from: everyone but its exclusions, with its '
  'inclusions flagged and their service and tag ids flattened. Criteria and the consent '
  'gate are applied by the caller.';

-- Same access as every other public function since 20261002000100: members (through
-- RLS, security invoker) and the service role; never anon.
revoke execute on function public.segment_contacts(uuid) from public, anon;
grant execute on function public.segment_contacts(uuid) to authenticated, service_role;
