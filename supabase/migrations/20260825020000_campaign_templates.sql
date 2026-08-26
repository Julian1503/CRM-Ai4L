-- Campaign templates — the merge-field contract, per template instead of hard-coded.
--
-- Until now the marketing agent knew exactly one email format: the seven slots in
-- src/lib/marketing/mergeFields.ts. Those slots drive three things at once — the tool
-- schema handed to the copywriter model, the validator its output passes through, and
-- the composer layout — so a second email format was a code change in three places.
--
-- This table makes them data. It does NOT create anything on the provider's side: the
-- HTML still lives in an EmailOctopus automation authored in their UI (their API
-- cannot accept a body). A row here *describes* the slots an automation's template
-- already references, so the CRM can write copy for it.
--
-- Deliberately not seeded. A campaign with no template_id falls back to
-- BUILT_IN_TEMPLATE in the application, which is the same seven slots the existing
-- automation was built against — so every campaign written before this migration keeps
-- its contract without a data migration that could drift from the constant.

create table if not exists public.campaign_templates (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text,

    -- Which provider this template lives in, mirroring campaigns.provider.
    provider text not null default 'emailoctopus',

    -- The automation whose template merges these slots. Selecting the template in the
    -- campaign form fills the campaign's own provider_automation_id from here, which
    -- is what stops an operator pairing template A's copy with automation B.
    provider_automation_id text,

    -- [{tag, label, description, maxLength, role}] — validated by parseTemplateSlots
    -- before it is written, and again when it is read back. Stored as jsonb rather
    -- than a child table because it is always read and written whole, and because the
    -- model's tool schema wants it in exactly this shape.
    slots jsonb not null default '[]'::jsonb,

    -- Extra steering for the copywriter, on top of the shared voice and compliance
    -- rules. A case-study template asks for different copy than an invitation.
    brief text,

    archived_at timestamptz,
    created_at timestamptz not null default timezone('utc'::text, now()),
    updated_at timestamptz not null default timezone('utc'::text, now())
);
create unique index if not exists campaign_templates_name_ci_idx
    on public.campaign_templates (lower(btrim(name)));
-- A template with no slots would generate an empty email and report success, so the
-- shape is enforced here as well as in the application: the API is not the only thing
-- that can write this table.
do $$
begin
  alter table public.campaign_templates
    add constraint campaign_templates_slots_is_array
    check (jsonb_typeof(slots) = 'array' and jsonb_array_length(slots) > 0);
exception
  when duplicate_object then null;
end $$;
alter table public.campaign_templates enable row level security;
-- ---------------------------------------------------------------------------
-- Campaigns point at a template
-- ---------------------------------------------------------------------------
-- Nullable on purpose: null means the built-in template. `on delete restrict` because
-- a sent campaign's copy is only interpretable against the slots it was written for.
alter table public.campaigns
    add column if not exists template_id uuid references public.campaign_templates(id) on delete restrict;
create index if not exists campaigns_template_idx on public.campaigns (template_id);
-- ---------------------------------------------------------------------------
-- Policies — same shape as segments and campaigns
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'campaign_templates'
      and policyname = 'Allow read access to authenticated users'
  ) then
    create policy "Allow read access to authenticated users"
      on public.campaign_templates for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'campaign_templates'
      and policyname = 'Allow insert access to authenticated users'
  ) then
    create policy "Allow insert access to authenticated users"
      on public.campaign_templates for insert to authenticated with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'campaign_templates'
      and policyname = 'Allow update access to authenticated users'
  ) then
    create policy "Allow update access to authenticated users"
      on public.campaign_templates for update to authenticated using (true) with check (true);
  end if;
end $$;
-- Deletion is not granted, for the same reason segments cannot be deleted: a campaign
-- that has already sent still references its template. Archiving is `archived_at`.

comment on table public.campaign_templates is
  'Slot contracts for provider-authored email templates. A campaign with template_id '
  'null uses the built-in seven-slot template defined in src/lib/marketing/templates.ts.';
-- No updated_at trigger: segments, campaigns and bookings all leave that column to the
-- writer, and one table maintaining it automatically while the rest do not is worse
-- than none doing it. The API sets it on update.;
