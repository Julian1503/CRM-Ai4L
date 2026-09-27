-- Recurring newsletters.
--
-- A schedule says "every N, write a newsletter for this segment on this template", and
-- a daily cron turns each due schedule into an ordinary campaign: drafted, written by
-- the copy generator, and left in review. Nothing about the approval gate changes -- a
-- scheduled campaign still needs a signed-in human to approve it and a second press to
-- send it, and the status trigger still refuses anything else.
--
-- Newsletter only, by decision: course and training emails stay hand-made. That is
-- enforced here as well as in the application, because the template a schedule points
-- at is what decides whose consent its campaigns spend.

-- ---------------------------------------------------------------------------
-- 1. Schedules
-- ---------------------------------------------------------------------------
do $$
begin
  create type public.newsletter_frequency as enum ('weekly', 'fortnightly', 'monthly');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.newsletter_schedules (
    id uuid primary key default gen_random_uuid(),
    name text not null,

    -- `restrict` for the same reason campaigns restrict: the schedule's history is only
    -- explicable against the template its campaigns were written for. Archive instead.
    template_id uuid not null references public.campaign_templates(id) on delete restrict,
    segment_id uuid not null references public.segments(id) on delete restrict,

    frequency public.newsletter_frequency not null,
    -- When the next campaign is due. Advanced by the runner *before* it generates, so
    -- two overlapping runs cannot both claim the same occurrence.
    next_run_at timestamptz not null,
    -- The wall-clock zone the frequency is counted in, so "monthly on the 1st" stays on
    -- the 1st across daylight saving.
    timezone text not null default 'Australia/Sydney',

    -- The brief. All optional except the goal: without one, the model has nothing to
    -- aim at and every issue reads like the last.
    goal text not null,
    tone text,
    cta text,
    must_include text,
    avoid text,

    is_active boolean not null default true,
    archived_at timestamptz,
    created_by uuid,
    created_at timestamptz not null default timezone('utc'::text, now()),
    updated_at timestamptz not null default timezone('utc'::text, now())
);

create unique index if not exists newsletter_schedules_name_ci_idx
    on public.newsletter_schedules (lower(btrim(name)));

-- The runner's only query: due, active, not archived.
create index if not exists newsletter_schedules_due_idx
    on public.newsletter_schedules (next_run_at)
    where is_active and archived_at is null;

do $$
begin
  alter table public.newsletter_schedules
    add constraint newsletter_schedules_goal_present check (btrim(goal) <> '');
exception
  when duplicate_object then null;
end $$;

-- A schedule may only point at a newsletter template.
create or replace function public.enforce_newsletter_schedule_template()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_stream public.consent_stream;
begin
  select consent_stream into v_stream
  from public.campaign_templates
  where id = new.template_id;

  if v_stream is distinct from 'newsletter' then
    raise exception 'A newsletter schedule must use a newsletter template (template % is %)',
      new.template_id, coalesce(v_stream::text, 'missing');
  end if;

  return new;
end;
$$;

drop trigger if exists newsletter_schedules_template_stream on public.newsletter_schedules;
create trigger newsletter_schedules_template_stream
    before insert or update of template_id on public.newsletter_schedules
    for each row execute function public.enforce_newsletter_schedule_template();

-- ---------------------------------------------------------------------------
-- 2. Topics -- the queue each run takes its subject from
-- ---------------------------------------------------------------------------
create table if not exists public.newsletter_topics (
    id uuid primary key default gen_random_uuid(),
    schedule_id uuid not null references public.newsletter_schedules(id) on delete restrict,
    title text not null,
    details text,
    -- Lower goes first. Gaps are fine; the runner orders, it does not count.
    position integer not null default 0,
    -- Set when a run takes the topic, with the campaign it became. A used topic is
    -- history and is kept; an unused one may be deleted.
    used_at timestamptz,
    campaign_id uuid references public.campaigns(id) on delete restrict,
    created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists newsletter_topics_queue_idx
    on public.newsletter_topics (schedule_id, position, created_at)
    where used_at is null;

do $$
begin
  alter table public.newsletter_topics
    add constraint newsletter_topics_title_present check (btrim(title) <> '');
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Campaigns remember which occurrence they are
-- ---------------------------------------------------------------------------
alter table public.campaigns
    add column if not exists schedule_id uuid references public.newsletter_schedules(id) on delete restrict;
alter table public.campaigns
    add column if not exists scheduled_for date;

-- The idempotency guarantee: one campaign per schedule per occurrence, however many
-- times the cron fires. A second insert fails here rather than drafting a duplicate.
create unique index if not exists campaigns_schedule_occurrence_idx
    on public.campaigns (schedule_id, scheduled_for)
    where schedule_id is not null;

comment on column public.campaigns.schedule_id is
  'The newsletter schedule that drafted this campaign, if any. Null for hand-made campaigns.';

-- ---------------------------------------------------------------------------
-- 4. Policies -- same shape as campaign_templates
-- ---------------------------------------------------------------------------
alter table public.newsletter_schedules enable row level security;
alter table public.newsletter_topics enable row level security;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['newsletter_schedules', 'newsletter_topics'] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_table
        and policyname = 'Allow read access to authenticated users'
    ) then
      execute format(
        'create policy "Allow read access to authenticated users" on public.%I for select to authenticated using (true)',
        v_table
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_table
        and policyname = 'Allow insert access to authenticated users'
    ) then
      execute format(
        'create policy "Allow insert access to authenticated users" on public.%I for insert to authenticated with check (true)',
        v_table
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_table
        and policyname = 'Allow update access to authenticated users'
    ) then
      execute format(
        'create policy "Allow update access to authenticated users" on public.%I for update to authenticated using (true) with check (true)',
        v_table
      );
    end if;
  end loop;

  -- Only an unused topic may be removed; a used one is the record of what an issue
  -- was about. Schedules have no delete at all -- they are archived.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'newsletter_topics'
      and policyname = 'Allow delete of unused topics to authenticated users'
  ) then
    create policy "Allow delete of unused topics to authenticated users"
      on public.newsletter_topics for delete to authenticated using (used_at is null);
  end if;
end $$;

comment on table public.newsletter_schedules is
  'Recurring newsletters. A daily cron drafts one campaign per due schedule and leaves it '
  'in review; approval and sending stay manual.';
