-- Segment control: manual include/exclude, and one place that resolves who is in.
--
-- Until now a segment was only a saved filter, resolved in the application by chaining
-- PostgREST filters over `active_contacts`. Manual overrides do not fit that shape: an
-- exclusion list would have to travel inside the URL as `id=not.in.(...)`, and a URL has
-- a length limit a busy segment would reach.
--
-- So resolution moves here. `segment_contacts()` returns the active contacts a segment
-- can draw from -- everyone except its exclusions -- and flags its inclusions. The
-- application applies the saved criteria on top as `is_included OR (criteria)`, and the
-- consent gate as a plain AND beside it, so a manual inclusion widens the filter but can
-- never widen consent.
--
-- And a segment used by a campaign that is approved or sending cannot change: the send
-- resolves its audience when it runs, so an edit after approval would send to people
-- nobody approved.

-- ---------------------------------------------------------------------------
-- 1. Overrides
-- ---------------------------------------------------------------------------
create table if not exists public.segment_overrides (
    segment_id uuid not null references public.segments(id) on delete cascade,
    contact_id uuid not null references public.contacts(id) on delete cascade,
    mode text not null,
    reason text,
    created_by uuid,
    created_at timestamptz not null default timezone('utc'::text, now()),
    -- One row per person per segment: included or excluded, never both.
    primary key (segment_id, contact_id)
);

do $$
begin
  alter table public.segment_overrides
    add constraint segment_overrides_mode_check check (mode in ('include', 'exclude'));
exception
  when duplicate_object then null;
end $$;

create index if not exists segment_overrides_contact_idx
    on public.segment_overrides (contact_id);

alter table public.segment_overrides enable row level security;

do $$
declare
  v_command text;
  v_clause  text;
begin
  foreach v_command in array array['select', 'insert', 'update', 'delete'] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'segment_overrides'
        and policyname = format('Allow %s access to authenticated users', v_command)
    ) then
      v_clause := case v_command
        when 'insert' then 'with check (true)'
        when 'update' then 'using (true) with check (true)'
        else 'using (true)'
      end;

      execute format(
        'create policy "Allow %s access to authenticated users" on public.segment_overrides for %s to authenticated %s',
        v_command, v_command, v_clause
      );
    end if;
  end loop;
end $$;

comment on table public.segment_overrides is
  'Manual segment membership. include adds a contact the criteria miss; exclude removes '
  'one they match. Neither bypasses consent or archiving -- see segment_contacts().';

-- ---------------------------------------------------------------------------
-- 2. The rows a segment draws from
-- ---------------------------------------------------------------------------
-- Only the columns segment resolution filters on or shows. `service_ids` is the
-- contact's services flattened so a service filter is a plain array test
-- (`service_ids=cs.{id}`) instead of a join PostgREST cannot express over a function.
--
-- A null segment id means "no overrides" -- the preview of a segment not yet saved.
--
-- security invoker: it reads through the caller's RLS like any other query.
--
-- Reads `contacts` with the same `deleted_at is null` that defines `active_contacts`,
-- rather than the view itself: the view was created with `select *` before `source`
-- existed, and a view's column list is fixed when it is created.
create or replace function public.segment_contacts(p_segment_id uuid default null)
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
    is_included boolean
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
    coalesce(o.mode = 'include', false) as is_included
  from public.contacts c
  left join public.segment_overrides o
    on o.segment_id = p_segment_id and o.contact_id = c.id
  where c.deleted_at is null
    and o.mode is distinct from 'exclude';
$$;

comment on function public.segment_contacts(uuid) is
  'Active contacts a segment can draw from: everyone but its exclusions, with its '
  'inclusions flagged. Criteria and the consent gate are applied by the caller.';

-- ---------------------------------------------------------------------------
-- 3. A segment in use by an approved or sending campaign cannot change
-- ---------------------------------------------------------------------------
create or replace function public.enforce_segment_unlocked()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_segment_id uuid;
  v_campaign   text;
begin
  if tg_table_name = 'segments' then
    v_segment_id := old.id;
  elsif tg_op = 'DELETE' then
    v_segment_id := old.segment_id;
  else
    v_segment_id := new.segment_id;
  end if;

  select name into v_campaign
  from public.campaigns
  where segment_id = v_segment_id
    and status in ('approved', 'sending')
  limit 1;

  if found then
    raise exception 'Segment is locked by campaign "%", which is approved or sending. Move it back to draft first.',
      v_campaign;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists segments_unlocked on public.segments;
create trigger segments_unlocked
    before update of name, description, definition on public.segments
    for each row execute function public.enforce_segment_unlocked();

drop trigger if exists segment_overrides_unlocked on public.segment_overrides;
create trigger segment_overrides_unlocked
    before insert or update or delete on public.segment_overrides
    for each row execute function public.enforce_segment_unlocked();
