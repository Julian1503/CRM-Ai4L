-- Content Studio: editorial content, assets, durable jobs and social publishing.
--
-- Plan: docs/CONTENT_STUDIO_SOCIAL_EMAIL_IMPLEMENTATION_PLAN.md (§6, §7, §9, §10).
-- Contracts: docs/CONTENT_STUDIO_CONTRACTS.md.
--
-- Decisions (phase 0): a single brand (AI4L) modelled as a brand profile, no tenancy.
-- `organisations` stays the contacts' companies and is NOT a tenant key (§6 rule 9).
--
-- Integrity rules enforced here rather than trusted to callers:
--   1. A revision is immutable. Editing creates a new revision; the variant points at
--      its current one. Approval belongs to a revision, so an edit voids it (§6 r1-2).
--   2. Only the current revision of a variant can be reviewed or published, and a
--      queued publication whose revision is no longer current/approved is refused at
--      dispatch (begin_content_dispatch), never sent (§9).
--   3. A generation result computed from an old revision never overwrites a newer one:
--      it becomes a new variant (§6 r6).
--   4. Jobs, revision creation and publication requests are idempotent (§6 r5).
--   5. A job lease that expires BEFORE begin-dispatch returns to the queue; AFTER it,
--      the job is 'uncertain' until a person reconciles it. A stale worker cannot
--      complete, checkpoint or dispatch (§9 "Ejecución durable").
--   6. Nothing here is physically deleted (project rule): archive/remove columns only.
--   7. Social tokens live in social_account_secrets, invisible to every browser role.
--
-- Every table carries the restrictive "Approved CRM members only" policy that
-- supabase/tests/verify_20261002000000.sql requires of every public table.

-- ---------------------------------------------------------------------------
-- 1. Brand profile
-- ---------------------------------------------------------------------------
create table if not exists public.content_brand_profiles (
    id              uuid primary key default gen_random_uuid(),
    slug            text not null unique,
    name            text not null,
    tone            text not null default '',
    audience        text not null default '',
    region          text not null default '',
    -- Facts the generator may state as true: [{ "id", "text", "source" }].
    approved_facts  jsonb not null default '[]'::jsonb,
    -- Per-channel CTA and structure guidance: { "<channel>": { "cta": "...", "structure": "..." } }.
    channel_rules   jsonb not null default '{}'::jsonb,
    hashtag_seeds   text[] not null default '{}',
    image_direction text not null default '',
    -- Destinations an external_url CTA may point at (https origins).
    allowed_link_origins text[] not null default '{}',
    created_at      timestamptz not null default timezone('utc'::text, now()),
    updated_at      timestamptz not null default timezone('utc'::text, now()),
    archived_at     timestamptz,
    constraint content_brand_profiles_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
    constraint content_brand_profiles_name_length check (char_length(btrim(name)) between 1 and 120),
    constraint content_brand_profiles_facts_array check (jsonb_typeof(approved_facts) = 'array'),
    constraint content_brand_profiles_rules_object check (jsonb_typeof(channel_rules) = 'object')
);

comment on table public.content_brand_profiles is
  'Brand voice, approved facts and CTA rules the content generator is grounded in. AI4L only for now.';

insert into public.content_brand_profiles (slug, name, tone, audience, region)
values ('ai4l', 'AI4L', 'Clear, practical and warm. No hype.', 'Businesses and professionals adopting AI', '')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Items, variants, revisions, reviews
-- ---------------------------------------------------------------------------
create table if not exists public.content_items (
    id          uuid primary key default gen_random_uuid(),
    brand_id    uuid not null references public.content_brand_profiles (id) on delete restrict,
    title       text not null,
    -- { topic, audience, objective, notes, referenceUrl, sourceFacts: [] } — see types.ts ContentBrief.
    brief       jsonb not null default '{}'::jsonb,
    channels    text[] not null,
    created_by  uuid references auth.users (id) on delete set null,
    created_at  timestamptz not null default timezone('utc'::text, now()),
    updated_at  timestamptz not null default timezone('utc'::text, now()),
    archived_at timestamptz,
    removed_at  timestamptz,
    removed_by  uuid references auth.users (id) on delete set null,
    constraint content_items_title_length check (char_length(btrim(title)) between 1 and 200),
    constraint content_items_brief_object check (jsonb_typeof(brief) = 'object'),
    constraint content_items_channels_valid check (
      cardinality(channels) between 1 and 4
      and channels <@ array['facebook', 'instagram', 'linkedin', 'email']::text[]
    ),
    constraint content_items_removed_requires_archived check (removed_at is null or archived_at is not null)
);

create index if not exists content_items_active_idx
    on public.content_items (created_at desc) where archived_at is null;

create table if not exists public.content_variants (
    id                  uuid primary key default gen_random_uuid(),
    item_id             uuid not null references public.content_items (id) on delete restrict,
    channel             text not null check (channel in ('facebook', 'instagram', 'linkedin', 'email')),
    style               text not null default 'default',
    current_revision_id uuid,
    -- Set when this variant was created because a result arrived for a revision that
    -- had already been superseded (integrity rule 3).
    conflict_of_revision_id uuid,
    created_at          timestamptz not null default timezone('utc'::text, now()),
    archived_at         timestamptz,
    constraint content_variants_style_length check (char_length(style) between 1 and 40)
);

create index if not exists content_variants_item_idx on public.content_variants (item_id, channel);
create index if not exists content_variants_current_revision_idx on public.content_variants (current_revision_id);

create table if not exists public.content_variant_revisions (
    id                 uuid primary key default gen_random_uuid(),
    variant_id         uuid not null references public.content_variants (id) on delete restrict,
    revision_number    integer not null,
    parent_revision_id uuid references public.content_variant_revisions (id) on delete restrict,
    origin             text not null check (origin in ('generated', 'regenerated', 'edited', 'duplicated')),
    body               text not null default '',
    hashtags           text[] not null default '{}',
    call_to_action     text,
    link_url           text,
    -- Channel-specific structured slots (email: subject, preheader, headline, ...).
    fields             jsonb not null default '{}'::jsonb,
    -- Ordered asset selection with per-revision alt text: [{ "assetId", "alt", "order" }].
    assets             jsonb not null default '[]'::jsonb,
    facts              jsonb not null default '[]'::jsonb,
    sources            jsonb not null default '[]'::jsonb,
    violations         jsonb not null default '[]'::jsonb,
    prompt_version     text,
    job_id             uuid,
    idempotency_key    text unique,
    checksum           text not null,
    created_by         uuid references auth.users (id) on delete set null,
    created_at         timestamptz not null default timezone('utc'::text, now()),
    unique (variant_id, revision_number),
    constraint content_revisions_body_length check (char_length(body) <= 10000),
    constraint content_revisions_fields_object check (jsonb_typeof(fields) = 'object'),
    constraint content_revisions_assets_array check (jsonb_typeof(assets) = 'array' and jsonb_array_length(assets) <= 10),
    constraint content_revisions_link_https check (link_url is null or link_url ~ '^https://[^\s]+$')
);

alter table public.content_variants
    drop constraint if exists content_variants_current_revision_fk;
alter table public.content_variants
    add constraint content_variants_current_revision_fk
    foreign key (current_revision_id) references public.content_variant_revisions (id) on delete restrict;

create table if not exists public.content_reviews (
    id          uuid primary key default gen_random_uuid(),
    revision_id uuid not null references public.content_variant_revisions (id) on delete restrict,
    decision    text not null check (decision in ('approved', 'rejected')),
    reason      text,
    actor_id    uuid references auth.users (id) on delete set null,
    -- clock_timestamp, not the transaction start: reviews of one variant serialise on the
    -- variant lock, and the later decision must also sort later.
    created_at  timestamptz not null default clock_timestamp(),
    constraint content_reviews_reason_length check (reason is null or char_length(reason) <= 1000),
    constraint content_reviews_rejection_reason check (decision = 'approved' or nullif(btrim(reason), '') is not null)
);

alter table public.content_reviews alter column created_at set default clock_timestamp();
drop index if exists public.content_reviews_revision_idx;
create index if not exists content_reviews_revision_idx on public.content_reviews (revision_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- 3. Assets (Storage metadata only — bytes live in Storage, never in a table)
-- ---------------------------------------------------------------------------
create table if not exists public.content_assets (
    id                uuid primary key default gen_random_uuid(),
    brand_id          uuid not null references public.content_brand_profiles (id) on delete restrict,
    item_id           uuid references public.content_items (id) on delete restrict,
    origin            text not null check (origin in ('upload', 'generated')),
    ingest_status     text not null default 'pending' check (ingest_status in ('pending', 'ready', 'rejected')),
    rejection_reason  text,
    quarantine_path   text,
    storage_path      text,
    mime_type         text,
    byte_size         integer,
    width             integer,
    height            integer,
    checksum          text,
    -- { "social": { path, mimeType, byteSize, width, height, checksum }, "email": { ... } }
    renditions        jsonb not null default '{}'::jsonb,
    alt_text          text not null default '',
    original_filename text,
    generation_prompt text,
    job_id            uuid,
    created_by        uuid references auth.users (id) on delete set null,
    created_at        timestamptz not null default timezone('utc'::text, now()),
    archived_at       timestamptz,
    removed_at        timestamptz,
    removed_by        uuid references auth.users (id) on delete set null,
    constraint content_assets_ready_complete check (
      ingest_status <> 'ready'
      or (storage_path is not null and mime_type is not null and byte_size is not null
          and width is not null and height is not null and checksum is not null)
    ),
    constraint content_assets_alt_length check (char_length(alt_text) <= 500),
    constraint content_assets_removed_requires_archived check (removed_at is null or archived_at is not null)
);

create index if not exists content_assets_library_idx
    on public.content_assets (created_at desc) where archived_at is null;
create index if not exists content_assets_item_idx on public.content_assets (item_id);
create index if not exists content_assets_pending_idx on public.content_assets (created_at) where ingest_status = 'pending';

-- An immutable, publicly readable copy made when an asset is used by a publication or
-- an email. The path never changes and is never reused, so an email sent last year
-- still renders (§7 steps 5-6).
create table if not exists public.content_published_assets (
    id           uuid primary key default gen_random_uuid(),
    asset_id     uuid not null references public.content_assets (id) on delete restrict,
    purpose      text not null check (purpose in ('social', 'email')),
    storage_path text not null unique,
    public_url   text not null,
    checksum     text not null,
    mime_type    text not null,
    byte_size    integer not null,
    width        integer not null,
    height       integer not null,
    created_by   uuid references auth.users (id) on delete set null,
    created_at   timestamptz not null default timezone('utc'::text, now()),
    unique (asset_id, purpose, checksum),
    constraint content_published_assets_https check (public_url ~ '^https?://')
);

-- ---------------------------------------------------------------------------
-- 4. Social accounts, secrets, OAuth state, publications
-- ---------------------------------------------------------------------------
create table if not exists public.social_accounts (
    id               uuid primary key default gen_random_uuid(),
    brand_id         uuid not null references public.content_brand_profiles (id) on delete restrict,
    platform         text not null check (platform in ('facebook', 'instagram', 'linkedin')),
    provider         text not null check (provider in ('meta', 'linkedin', 'mock')),
    external_id      text not null,
    display_name     text not null,
    -- Explicit destination kind; a personal profile is never a silent fallback (§9).
    author_kind      text not null check (author_kind in ('page', 'instagram_business', 'organization', 'member')),
    scopes           text[] not null default '{}',
    status           text not null default 'connected'
                     check (status in ('connected', 'needs_reauth', 'disconnected')),
    last_error       text,
    health_checked_at timestamptz,
    connected_by     uuid references auth.users (id) on delete set null,
    created_at       timestamptz not null default timezone('utc'::text, now()),
    updated_at       timestamptz not null default timezone('utc'::text, now()),
    unique (platform, external_id)
);

create table if not exists public.social_account_secrets (
    account_id     uuid primary key references public.social_accounts (id) on delete restrict,
    -- AES-256-GCM envelope produced by src/lib/crypto/secretBox.ts; never plaintext.
    access_token   text not null,
    refresh_token  text,
    key_version    integer not null,
    expires_at     timestamptz,
    updated_at     timestamptz not null default timezone('utc'::text, now())
);

comment on table public.social_account_secrets is
  'Encrypted social tokens. No browser role can read or write this table; the server uses the service role.';

create table if not exists public.social_oauth_states (
    state_hash  text primary key,
    provider    text not null check (provider in ('meta', 'linkedin', 'mock')),
    actor_id    uuid not null references auth.users (id) on delete cascade,
    brand_id    uuid not null references public.content_brand_profiles (id) on delete restrict,
    -- Requested LinkedIn author mode etc.; never a secret.
    options     jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default timezone('utc'::text, now()),
    expires_at  timestamptz not null,
    consumed_at timestamptz
);

create table if not exists public.social_publications (
    id                  uuid primary key default gen_random_uuid(),
    revision_id         uuid not null references public.content_variant_revisions (id) on delete restrict,
    variant_id          uuid not null references public.content_variants (id) on delete restrict,
    account_id          uuid not null references public.social_accounts (id) on delete restrict,
    job_id              uuid,
    status              text not null default 'queued'
                        check (status in ('queued', 'dispatching', 'published', 'failed', 'uncertain', 'cancelled')),
    idempotency_key     text not null unique,
    -- Published-asset ids, in order, pinned when the publication was requested.
    published_asset_ids uuid[] not null default '{}',
    checkpoint          jsonb not null default '{}'::jsonb,
    external_id         text,
    permalink           text,
    error_code          text,
    error_message       text,
    requested_by        uuid references auth.users (id) on delete set null,
    created_at          timestamptz not null default timezone('utc'::text, now()),
    dispatch_started_at timestamptz,
    finished_at         timestamptz,
    resolved_by         uuid references auth.users (id) on delete set null,
    resolution_note     text
);

-- One live attempt per revision and account: a double click or a timeout retry lands
-- on the same row instead of a second public post.
create index if not exists social_publications_variant_idx on public.social_publications (variant_id, created_at desc);
create index if not exists social_publications_account_idx on public.social_publications (account_id);
create index if not exists social_publications_job_idx on public.social_publications (job_id);
create index if not exists social_publications_open_idx on public.social_publications (status) where status in ('queued', 'dispatching', 'uncertain');

create unique index if not exists social_publications_one_live_idx
    on public.social_publications (revision_id, account_id)
    where status in ('queued', 'dispatching', 'published', 'uncertain');

-- ---------------------------------------------------------------------------
-- 5. Durable jobs
-- ---------------------------------------------------------------------------
create table if not exists public.content_jobs (
    id                  uuid primary key default gen_random_uuid(),
    kind                text not null
                        check (kind in ('generate_text', 'generate_image', 'ingest_asset', 'publish_social')),
    status              text not null default 'queued'
                        check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain')),
    idempotency_key     text not null unique,
    item_id             uuid references public.content_items (id) on delete restrict,
    variant_id          uuid references public.content_variants (id) on delete restrict,
    -- The revision a regeneration started from (integrity rule 3).
    base_revision_id    uuid references public.content_variant_revisions (id) on delete restrict,
    asset_id            uuid references public.content_assets (id) on delete restrict,
    publication_id      uuid references public.social_publications (id) on delete restrict,
    -- Snapshot of the request. Never contains a secret (§5 contract).
    input               jsonb not null default '{}'::jsonb,
    attempts            integer not null default 0,
    max_attempts        integer not null default 3 check (max_attempts between 1 and 10),
    next_attempt_at     timestamptz not null default now(),
    claim_token         uuid,
    worker_id           text,
    lease_expires_at    timestamptz,
    heartbeat_at        timestamptz,
    checkpoint          jsonb not null default '{}'::jsonb,
    dispatch_started_at timestamptz,
    cancel_requested_at timestamptz,
    result              jsonb,
    error_code          text,
    error_message       text,
    provider_request_id text,
    usage               jsonb,
    created_by          uuid references auth.users (id) on delete set null,
    created_at          timestamptz not null default timezone('utc'::text, now()),
    started_at          timestamptz,
    finished_at         timestamptz,
    resolved_by         uuid references auth.users (id) on delete set null,
    resolution_note     text,
    constraint content_jobs_input_object check (jsonb_typeof(input) = 'object'),
    constraint content_jobs_running_has_lease check (
      status <> 'running' or (claim_token is not null and lease_expires_at is not null)
    )
);

create index if not exists content_jobs_due_idx
    on public.content_jobs (next_attempt_at) where status = 'queued';
create index if not exists content_jobs_running_idx
    on public.content_jobs (lease_expires_at) where status = 'running';
create index if not exists content_jobs_item_idx on public.content_jobs (item_id, created_at desc);
create index if not exists content_jobs_publication_idx on public.content_jobs (publication_id) where publication_id is not null;
create index if not exists content_jobs_asset_idx on public.content_jobs (asset_id, created_at desc) where asset_id is not null;
create index if not exists content_jobs_variant_idx on public.content_jobs (variant_id) where variant_id is not null;
create index if not exists content_jobs_base_revision_idx on public.content_jobs (base_revision_id) where base_revision_id is not null;
create index if not exists content_jobs_finished_idx on public.content_jobs (status, finished_at) where status in ('failed', 'uncertain');

alter table public.content_variant_revisions
    drop constraint if exists content_revisions_job_fk;
alter table public.content_variant_revisions
    add constraint content_revisions_job_fk foreign key (job_id) references public.content_jobs (id) on delete restrict;
alter table public.content_assets
    drop constraint if exists content_assets_job_fk;
alter table public.content_assets
    add constraint content_assets_job_fk foreign key (job_id) references public.content_jobs (id) on delete restrict;
alter table public.social_publications
    drop constraint if exists social_publications_job_fk;
alter table public.social_publications
    add constraint social_publications_job_fk foreign key (job_id) references public.content_jobs (id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 6. Audit trail
-- ---------------------------------------------------------------------------
create table if not exists public.content_audit_events (
    id           uuid primary key default gen_random_uuid(),
    actor_id     uuid references auth.users (id) on delete set null,
    action       text not null,
    subject_type text not null,
    subject_id   uuid,
    details      jsonb not null default '{}'::jsonb,
    created_at   timestamptz not null default timezone('utc'::text, now()),
    constraint content_audit_action_format check (action ~ '^[a-z_.]{3,60}$')
);

create index if not exists content_audit_subject_idx
    on public.content_audit_events (subject_type, subject_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 7. Immutability and removal triggers
-- ---------------------------------------------------------------------------
create or replace function public.refuse_content_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Deleting an auth user sets its actor columns to null (on delete set null); that is
  -- the one change allowed, so user removal is not blocked by evidence tables.
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'created_by' - 'actor_id') = (to_jsonb(old) - 'created_by' - 'actor_id')
     and coalesce(to_jsonb(new) ->> 'created_by', to_jsonb(new) ->> 'actor_id') is null then
    return new;
  end if;
  raise exception '% rows are immutable.', tg_table_name using errcode = 'CRM06';
end;
$$;

drop trigger if exists content_revisions_immutable on public.content_variant_revisions;
create trigger content_revisions_immutable
    before update or delete on public.content_variant_revisions
    for each row execute function public.refuse_content_mutation();

drop trigger if exists content_reviews_immutable on public.content_reviews;
create trigger content_reviews_immutable
    before update or delete on public.content_reviews
    for each row execute function public.refuse_content_mutation();

drop trigger if exists content_published_assets_immutable on public.content_published_assets;
create trigger content_published_assets_immutable
    before update or delete on public.content_published_assets
    for each row execute function public.refuse_content_mutation();

drop trigger if exists content_audit_immutable on public.content_audit_events;
create trigger content_audit_immutable
    before update or delete on public.content_audit_events
    for each row execute function public.refuse_content_mutation();

drop trigger if exists content_items_removal_final on public.content_items;
create trigger content_items_removal_final
    before update of removed_at, archived_at on public.content_items
    for each row execute function public.enforce_removal_is_final();

drop trigger if exists content_assets_removal_final on public.content_assets;
create trigger content_assets_removal_final
    before update of removed_at, archived_at on public.content_assets
    for each row execute function public.enforce_removal_is_final();

-- ---------------------------------------------------------------------------
-- 8. Access
-- ---------------------------------------------------------------------------
-- Browser roles read the editorial tables and write only the columns the application
-- edits directly. Everything with an integrity rule goes through the functions below.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'content_brand_profiles', 'content_items', 'content_variants', 'content_variant_revisions',
    'content_reviews', 'content_assets', 'content_published_assets', 'content_jobs',
    'social_accounts', 'social_account_secrets', 'social_oauth_states', 'social_publications',
    'content_audit_events'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from anon, authenticated', v_table);
    execute format('grant all on public.%I to service_role', v_table);
    execute format('drop policy if exists "Allow read access to authenticated users" on public.%I', v_table);
    execute format('drop policy if exists "Allow insert access to authenticated users" on public.%I', v_table);
    execute format('drop policy if exists "Allow update access to authenticated users" on public.%I', v_table);
    execute format('drop policy if exists "Approved CRM members only" on public.%I', v_table);
    execute format(
      'create policy "Approved CRM members only" on public.%I as restrictive for all to authenticated '
      'using (public.is_crm_member()) with check (public.is_crm_member())', v_table);
  end loop;

  -- Readable by members. Secrets and OAuth state are not in this list: no browser role
  -- reads them, and without a permissive policy RLS denies every row.
  foreach v_table in array array[
    'content_brand_profiles', 'content_items', 'content_variants', 'content_variant_revisions',
    'content_reviews', 'content_assets', 'content_published_assets', 'content_jobs',
    'social_accounts', 'social_publications', 'content_audit_events'
  ] loop
    execute format('grant select on public.%I to authenticated', v_table);
    execute format(
      'create policy "Allow read access to authenticated users" on public.%I for select to authenticated using (true)',
      v_table);
  end loop;
end;
$$;

-- Evidence tables are append-only for every role (project rule: no physical deletes).
revoke delete, truncate on public.content_variant_revisions, public.content_reviews,
  public.content_published_assets, public.content_audit_events from service_role;

-- Jobs are readable without their claim token: the token is the lease credential.
revoke select on public.content_jobs from authenticated;
grant select (
  id, kind, status, idempotency_key, item_id, variant_id, base_revision_id, asset_id, publication_id,
  input, attempts, max_attempts, next_attempt_at, worker_id, lease_expires_at, heartbeat_at, checkpoint,
  dispatch_started_at, cancel_requested_at, result, error_code, error_message, provider_request_id,
  usage, created_by, created_at, started_at, finished_at, resolved_by, resolution_note
) on public.content_jobs to authenticated;

-- Direct writes the application makes with the member's own session.
grant insert on public.content_items to authenticated;
grant update (title, brief, channels, updated_at, archived_at, removed_at, removed_by) on public.content_items to authenticated;
grant update (alt_text, archived_at, removed_at, removed_by) on public.content_assets to authenticated;
grant update (archived_at) on public.content_variants to authenticated;

create policy "Allow insert access to authenticated users"
  on public.content_items for insert to authenticated with check (created_by = auth.uid());
create policy "Allow update access to authenticated users"
  on public.content_items for update to authenticated using (true) with check (true);
create policy "Allow update access to authenticated users"
  on public.content_assets for update to authenticated using (true) with check (true);
create policy "Allow update access to authenticated users"
  on public.content_variants for update to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 9. Storage buckets (§7)
-- ---------------------------------------------------------------------------
-- content-quarantine: raw uploads, private. Written only through signed upload URLs the
--                     server issues for a path it chose.
-- content-library:    normalised originals and renditions, private. Previews use
--                     signed URLs created by the server.
-- content-public:     immutable published copies for emails and social providers.
--                     Public read by URL; no listing policy exists, so nothing can be
--                     enumerated, and no browser role may write.
-- No storage.objects policy is granted to anon/authenticated: every write goes through
-- the service role after the API has checked membership and chosen the path.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present; content buckets are created at runtime (ensureContentBuckets).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values
    ('content-quarantine', 'content-quarantine', false, 15728640,
     array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    ('content-library', 'content-library', false, 15728640,
     array['image/jpeg', 'image/png', 'image/webp']),
    ('content-public', 'content-public', true, 15728640,
     array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Helpers
-- ---------------------------------------------------------------------------
create or replace function public.content_require_member()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.content_require_service()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the content worker bridge may call this function.' using errcode = '42501';
  end if;
end;
$$;

-- Canonical content checksum. jsonb text output is key-ordered, so equal content always
-- hashes equally regardless of the order the caller built it in.
create or replace function public.content_revision_checksum(
  p_body text, p_hashtags text[], p_cta text, p_link text, p_fields jsonb, p_assets jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(convert_to(jsonb_build_object(
    'body', coalesce(p_body, ''),
    'hashtags', to_jsonb(coalesce(p_hashtags, '{}'::text[])),
    'cta', p_cta,
    'link', p_link,
    'fields', coalesce(p_fields, '{}'::jsonb),
    'assets', coalesce(p_assets, '[]'::jsonb)
  )::text, 'UTF8')), 'hex');
$$;

create or replace function public.content_audit(
  p_actor uuid, p_action text, p_subject_type text, p_subject_id uuid, p_details jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.content_audit_events (actor_id, action, subject_type, subject_id, details)
  values (p_actor, p_action, p_subject_type, p_subject_id, coalesce(p_details, '{}'::jsonb));
$$;

-- Every asset reference must be a ready, non-archived library asset. Returns the
-- normalised array ordered by "order".
create or replace function public.content_normalise_asset_refs(p_assets jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result jsonb;
  v_bad    integer;
begin
  if p_assets is null or jsonb_typeof(p_assets) <> 'array' then
    return '[]'::jsonb;
  end if;
  if jsonb_array_length(p_assets) > 10 then
    raise exception 'A revision can use at most 10 images.' using errcode = 'CRM07', hint = 'too_many_assets';
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_assets) e
    left join public.content_assets a on a.id = (e ->> 'assetId')::uuid
   where a.id is null or a.ingest_status <> 'ready' or a.archived_at is not null;
  if v_bad > 0 then
    raise exception 'Every image must be a ready library image.' using errcode = 'CRM07', hint = 'asset_not_ready';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'assetId', e ->> 'assetId',
           'alt', left(coalesce(e ->> 'alt', ''), 500),
           'order', ord - 1
         ) order by ord), '[]'::jsonb)
    into v_result
    from (
      select e, row_number() over (order by coalesce((e ->> 'order')::int, 0), i) as ord
        from jsonb_array_elements(p_assets) with ordinality as t(e, i)
    ) s;

  if (select count(distinct x ->> 'assetId') from jsonb_array_elements(v_result) x) <> jsonb_array_length(v_result) then
    raise exception 'An image can appear once per revision.' using errcode = 'CRM07', hint = 'duplicate_asset';
  end if;
  return v_result;
end;
$$;

-- Inserts a revision and makes it current. Internal: callers have already checked
-- membership or service role and the expected-revision rule.
create or replace function public.content_insert_revision(
  p_variant_id uuid, p_parent uuid, p_origin text, p_content jsonb,
  p_job_id uuid, p_idempotency_key text, p_actor uuid
)
returns public.content_variant_revisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row      public.content_variant_revisions;
  v_hashtags text[];
  v_assets   jsonb := public.content_normalise_asset_refs(p_content -> 'assets');
  v_fields   jsonb := coalesce(p_content -> 'fields', '{}'::jsonb);
begin
  select coalesce(array_agg(left(btrim(h, ' #'), 60)) filter (where nullif(btrim(h, ' #'), '') is not null), '{}')
    into v_hashtags
    from jsonb_array_elements_text(coalesce(p_content -> 'hashtags', '[]'::jsonb)) h;
  if cardinality(v_hashtags) > 30 then
    raise exception 'At most 30 hashtags.' using errcode = 'CRM07', hint = 'too_many_hashtags';
  end if;
  if jsonb_typeof(v_fields) <> 'object' then
    raise exception 'fields must be an object.' using errcode = 'CRM07', hint = 'invalid_fields';
  end if;

  insert into public.content_variant_revisions (
    variant_id, revision_number, parent_revision_id, origin, body, hashtags, call_to_action,
    link_url, fields, assets, facts, sources, violations, prompt_version, job_id,
    idempotency_key, checksum, created_by
  )
  select p_variant_id,
         coalesce((select max(revision_number) from public.content_variant_revisions where variant_id = p_variant_id), 0) + 1,
         p_parent, p_origin,
         coalesce(p_content ->> 'body', ''), v_hashtags,
         nullif(btrim(p_content ->> 'callToAction'), ''),
         nullif(btrim(p_content ->> 'linkUrl'), ''),
         v_fields, v_assets,
         coalesce(p_content -> 'facts', '[]'::jsonb),
         coalesce(p_content -> 'sources', '[]'::jsonb),
         coalesce(p_content -> 'violations', '[]'::jsonb),
         p_content ->> 'promptVersion',
         p_job_id, p_idempotency_key,
         public.content_revision_checksum(
           coalesce(p_content ->> 'body', ''), v_hashtags, nullif(btrim(p_content ->> 'callToAction'), ''),
           nullif(btrim(p_content ->> 'linkUrl'), ''), v_fields, v_assets),
         p_actor
  returning * into v_row;

  update public.content_variants set current_revision_id = v_row.id where id = p_variant_id;
  return v_row;
end;
$$;

/*
 * Audit rows the API writes for direct edits (items, assets, variant archive). The actor
 * is always the caller and the action must be one the application records, so a member
 * cannot forge evidence such as a publication or an approval.
 */
create or replace function public.record_content_audit(
  p_action text, p_subject_type text, p_subject_id uuid, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.content_require_member();
  if p_action not in (
    'item.created', 'item.updated', 'item.archived', 'item.restored',
    'asset.upload_created', 'asset.updated', 'asset.archived', 'asset.restored', 'asset.published',
    'variant.archived', 'variant.restored'
  ) or p_subject_type not in ('content_item', 'content_variant', 'content_asset', 'content_published_asset') then
    raise exception 'This audit action is recorded by the database itself.' using errcode = '22023';
  end if;
  perform public.content_audit(auth.uid(), p_action, p_subject_type, p_subject_id, coalesce(p_details, '{}'::jsonb));
end;
$$;

/*
 * Replaces the editable fields of a brand profile. Administrators only (docs/ACCESS_CONTROL.md):
 * the profile grounds every generation, and its allowed link origins decide which links the
 * engine marks as blocked. Shapes are checked here so a direct PostgREST call cannot store
 * what the API would refuse. Omitted keys keep their value. Returns the updated row.
 */
create or replace function public.update_content_brand_profile(p_slug text, p_profile jsonb)
returns public.content_brand_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    public.content_brand_profiles;
  v_origin text;
begin
  if not public.is_crm_admin() then
    raise exception 'Only an administrator can change the brand profile.' using errcode = '42501';
  end if;
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    raise exception 'profile must be an object' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_profile -> 'approvedFacts', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_profile -> 'approvedFacts', '[]'::jsonb)) > 100
     or exists (
       select 1 from jsonb_array_elements(coalesce(p_profile -> 'approvedFacts', '[]'::jsonb)) f
        where jsonb_typeof(f) <> 'object' or nullif(btrim(f ->> 'text'), '') is null
           or char_length(f ->> 'text') > 500 or nullif(btrim(f ->> 'id'), '') is null
     ) then
    raise exception 'Each approved fact needs an id and a text of at most 500 characters (100 facts at most).'
      using errcode = 'CRM07', hint = 'invalid_facts';
  end if;
  if jsonb_typeof(coalesce(p_profile -> 'channelRules', '{}'::jsonb)) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(coalesce(p_profile -> 'channelRules', '{}'::jsonb)) k
        where k not in ('facebook', 'instagram', 'linkedin', 'email')
     ) then
    raise exception 'Channel rules may only name facebook, instagram, linkedin or email.'
      using errcode = 'CRM07', hint = 'invalid_channel_rules';
  end if;
  if jsonb_typeof(coalesce(p_profile -> 'allowedLinkOrigins', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_profile -> 'hashtagSeeds', '[]'::jsonb)) <> 'array' then
    raise exception 'allowedLinkOrigins and hashtagSeeds must be lists.' using errcode = '22023';
  end if;
  for v_origin in select jsonb_array_elements_text(coalesce(p_profile -> 'allowedLinkOrigins', '[]'::jsonb)) loop
    if lower(v_origin) !~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$' then
      raise exception 'Allowed link origins must look like https://example.com (no path).'
        using errcode = 'CRM07', hint = 'invalid_origin';
    end if;
  end loop;

  update public.content_brand_profiles
     set name = coalesce(nullif(btrim(p_profile ->> 'name'), ''), name),
         tone = left(coalesce(p_profile ->> 'tone', tone), 2000),
         audience = left(coalesce(p_profile ->> 'audience', audience), 2000),
         region = left(coalesce(p_profile ->> 'region', region), 200),
         approved_facts = coalesce(p_profile -> 'approvedFacts', approved_facts),
         channel_rules = coalesce(p_profile -> 'channelRules', channel_rules),
         hashtag_seeds = case when p_profile ? 'hashtagSeeds' then coalesce(
             (select array_agg(left(btrim(h, ' #'), 60) order by ord)
                from jsonb_array_elements_text(p_profile -> 'hashtagSeeds') with ordinality as t(h, ord)
               where nullif(btrim(h, ' #'), '') is not null), '{}'::text[])
           else hashtag_seeds end,
         image_direction = left(coalesce(p_profile ->> 'imageDirection', image_direction), 2000),
         allowed_link_origins = case when p_profile ? 'allowedLinkOrigins' then coalesce(
             (select array_agg(distinct lower(o)) from jsonb_array_elements_text(p_profile -> 'allowedLinkOrigins') o),
             '{}'::text[])
           else allowed_link_origins end,
         updated_at = now()
   where slug = p_slug and archived_at is null
  returning * into v_row;
  if not found then
    raise exception 'Brand profile not found.' using errcode = 'P0002';
  end if;

  perform public.content_audit(auth.uid(), 'brand.updated', 'content_brand_profile', v_row.id,
    jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_profile) k)));
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Member functions (editorial workflow)
-- ---------------------------------------------------------------------------

/*
 * Saves an edit (or duplicate) as a new revision. p_expected_revision_id is the
 * revision the editor started from: if another edit or a generation landed since, the
 * save is refused with CRM06 and the editor must reload — nothing is overwritten.
 * Idempotent on p_idempotency_key (a retried save returns the same revision).
 */
create or replace function public.create_content_revision(
  p_variant_id uuid,
  p_expected_revision_id uuid,
  p_content jsonb,
  p_idempotency_key text
)
returns public.content_variant_revisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_variant  public.content_variants;
  v_existing public.content_variant_revisions;
  v_row      public.content_variant_revisions;
begin
  perform public.content_require_member();
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;

  select * into v_existing from public.content_variant_revisions where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.variant_id <> p_variant_id then
      raise exception 'Idempotency key reused for another variant.' using errcode = 'CRM06';
    end if;
    return v_existing;
  end if;

  select * into v_variant from public.content_variants where id = p_variant_id for update;
  if not found or v_variant.archived_at is not null then
    raise exception 'Variant not found.' using errcode = 'P0002';
  end if;
  -- A concurrent retry of the same save may have committed while we waited for the lock.
  select * into v_existing from public.content_variant_revisions where idempotency_key = p_idempotency_key;
  if found and v_existing.variant_id = p_variant_id then
    return v_existing;
  end if;
  if v_variant.current_revision_id is distinct from p_expected_revision_id then
    raise exception 'This variant changed since you opened it. Reload before saving.'
      using errcode = 'CRM06', hint = 'stale_revision';
  end if;

  v_row := public.content_insert_revision(
    p_variant_id, p_expected_revision_id, 'edited', p_content, null, p_idempotency_key, auth.uid());
  perform public.content_audit(auth.uid(), 'revision.edited', 'content_variant', p_variant_id,
    jsonb_build_object('revisionId', v_row.id, 'revisionNumber', v_row.revision_number));
  return v_row;
end;
$$;

/*
 * Copies a variant's current revision into a new variant of the same item and channel.
 */
create or replace function public.duplicate_content_variant(p_variant_id uuid, p_idempotency_key text)
returns public.content_variants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source  public.content_variants;
  v_rev     public.content_variant_revisions;
  v_new     public.content_variants;
  v_existing public.content_variant_revisions;
begin
  perform public.content_require_member();
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('content:' || p_idempotency_key, 0));

  select * into v_source from public.content_variants where id = p_variant_id;
  if not found or v_source.current_revision_id is null or v_source.archived_at is not null then
    raise exception 'Variant not found.' using errcode = 'P0002';
  end if;

  -- The key is shared with create_content_revision; only a duplicate of this very
  -- source counts as the same request.
  select * into v_existing from public.content_variant_revisions where idempotency_key = p_idempotency_key;
  if found then
    select * into v_new from public.content_variants where id = v_existing.variant_id;
    if v_existing.origin <> 'duplicated' or v_new.item_id <> v_source.item_id
       or v_existing.parent_revision_id is distinct from v_source.current_revision_id then
      raise exception 'Idempotency key reused for another request.' using errcode = 'CRM06';
    end if;
    return v_new;
  end if;
  select * into v_rev from public.content_variant_revisions where id = v_source.current_revision_id;

  insert into public.content_variants (item_id, channel, style)
  values (v_source.item_id, v_source.channel, v_source.style)
  returning * into v_new;

  perform public.content_insert_revision(v_new.id, v_rev.id, 'duplicated', jsonb_build_object(
    'body', v_rev.body, 'hashtags', to_jsonb(v_rev.hashtags), 'callToAction', v_rev.call_to_action,
    'linkUrl', v_rev.link_url, 'fields', v_rev.fields, 'assets', v_rev.assets, 'facts', v_rev.facts,
    'sources', v_rev.sources, 'promptVersion', v_rev.prompt_version
  ), null, p_idempotency_key, auth.uid());
  perform public.content_audit(auth.uid(), 'variant.duplicated', 'content_variant', v_new.id,
    jsonb_build_object('fromVariantId', p_variant_id, 'fromRevisionId', v_rev.id));
  select * into v_new from public.content_variants where id = v_new.id;
  return v_new;
end;
$$;

/*
 * Approves or rejects the CURRENT revision of its variant. Reviewing an older revision
 * is refused: its approval would authorise content nobody is looking at.
 */
create or replace function public.review_content_revision(
  p_revision_id uuid,
  p_decision text,
  p_reason text default null
)
returns public.content_reviews
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rev     public.content_variant_revisions;
  v_variant public.content_variants;
  v_row     public.content_reviews;
begin
  perform public.content_require_member();
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected.' using errcode = '22023';
  end if;

  select * into v_rev from public.content_variant_revisions where id = p_revision_id;
  if not found then
    raise exception 'Revision not found.' using errcode = 'P0002';
  end if;
  select * into v_variant from public.content_variants where id = v_rev.variant_id for update;
  if v_variant.archived_at is not null
     or exists (select 1 from public.content_items where id = v_variant.item_id and archived_at is not null) then
    raise exception 'Restore this content before reviewing it.' using errcode = 'CRM07', hint = 'archived';
  end if;
  if v_variant.current_revision_id is distinct from p_revision_id then
    raise exception 'Only the current revision can be reviewed.' using errcode = 'CRM06', hint = 'stale_revision';
  end if;
  -- The engine marks content it must not publish unedited (e.g. a link outside the brand's
  -- allowed origins, typically injected through a reference page) with a 'blocked:' entry.
  -- A person edits it — which creates a new revision without that entry — before approval.
  if p_decision = 'approved' and exists (
       select 1 from jsonb_array_elements_text(v_rev.violations) v where v like 'blocked:%'
     ) then
    raise exception 'Edit this text before approving it: %',
      (select string_agg(substr(v, 9), '; ') from jsonb_array_elements_text(v_rev.violations) v where v like 'blocked:%')
      using errcode = 'CRM07', hint = 'blocked_content';
  end if;

  insert into public.content_reviews (revision_id, decision, reason, actor_id, created_at)
  values (p_revision_id, p_decision, nullif(btrim(p_reason), ''), auth.uid(), clock_timestamp())
  returning * into v_row;

  perform public.content_audit(auth.uid(), 'revision.' || p_decision, 'content_variant_revision', p_revision_id,
    jsonb_build_object('variantId', v_variant.id, 'reason', v_row.reason));
  return v_row;
end;
$$;

-- True when the revision is its variant's current one and its latest review approves it.
create or replace function public.content_revision_is_approved(p_revision_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.content_require_member();
  return exists (
    select 1
      from public.content_variant_revisions r
      join public.content_variants v on v.id = r.variant_id and v.current_revision_id = r.id
     where r.id = p_revision_id
       and v.archived_at is null
       and (select decision from public.content_reviews cr
             where cr.revision_id = r.id order by cr.created_at desc, cr.id desc limit 1) = 'approved'
  );
end;
$$;

/*
 * Queues a job on behalf of the calling member. Idempotent on p_idempotency_key: a
 * double click or a retried request returns the job that already exists.
 * publish_social jobs are created only by request_social_publication.
 */
create or replace function public.enqueue_content_job(
  p_kind text,
  p_idempotency_key text,
  p_item_id uuid default null,
  p_variant_id uuid default null,
  p_base_revision_id uuid default null,
  p_asset_id uuid default null,
  p_input jsonb default '{}'::jsonb
)
returns public.content_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.content_jobs;
begin
  perform public.content_require_member();
  if p_kind not in ('generate_text', 'generate_image', 'ingest_asset') then
    raise exception 'Unsupported job kind %.', p_kind using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;
  if p_kind = 'ingest_asset' and not exists (
    select 1 from public.content_assets where id = p_asset_id and ingest_status = 'pending' and archived_at is null
  ) then
    raise exception 'Only a pending upload can be processed.' using errcode = 'CRM07', hint = 'asset_not_pending';
  end if;
  if p_kind in ('generate_text', 'generate_image') and p_item_id is null then
    raise exception '% needs an item.', p_kind using errcode = '22023';
  end if;
  if p_variant_id is not null and not exists (
    select 1 from public.content_variants where id = p_variant_id and item_id = p_item_id
  ) then
    raise exception 'The variant does not belong to the item.' using errcode = '22023';
  end if;
  if exists (select 1 from public.content_items where id = p_item_id and archived_at is not null)
     or exists (select 1 from public.content_variants where id = p_variant_id and archived_at is not null) then
    raise exception 'Restore this content before generating for it.' using errcode = 'CRM07', hint = 'archived';
  end if;

  insert into public.content_jobs (
    kind, idempotency_key, item_id, variant_id, base_revision_id, asset_id, input, created_by,
    max_attempts
  )
  values (
    p_kind, p_idempotency_key, p_item_id, p_variant_id, p_base_revision_id, p_asset_id,
    coalesce(p_input, '{}'::jsonb), auth.uid(),
    case when p_kind = 'ingest_asset' then 5 else 3 end
  )
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  if not found then
    select * into v_row from public.content_jobs where idempotency_key = p_idempotency_key;
    if v_row.kind <> p_kind then
      raise exception 'Idempotency key reused for another job.' using errcode = 'CRM06';
    end if;
    v_row.claim_token := null;  -- the lease credential never leaves the worker bridge
    return v_row;
  end if;

  perform public.content_audit(auth.uid(), 'job.queued', 'content_job', v_row.id,
    jsonb_build_object('kind', p_kind, 'itemId', p_item_id));
  return v_row;
end;
$$;

/*
 * Cancelling stops further stages. A queued job is cancelled at once; a running job is
 * flagged and the worker stops at its next heartbeat. It never undoes an external
 * effect that already happened (§10).
 */
create or replace function public.cancel_content_job(p_job_id uuid)
returns public.content_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.content_jobs;
begin
  perform public.content_require_member();
  select * into v_row from public.content_jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job not found.' using errcode = 'P0002';
  end if;

  if v_row.status = 'queued' then
    update public.content_jobs
       set status = 'cancelled', cancel_requested_at = now(), finished_at = now()
     where id = p_job_id returning * into v_row;
    if v_row.publication_id is not null then
      update public.social_publications set status = 'cancelled', finished_at = now()
       where id = v_row.publication_id and status = 'queued';
    end if;
  elsif v_row.status = 'running' then
    update public.content_jobs set cancel_requested_at = coalesce(cancel_requested_at, now())
     where id = p_job_id returning * into v_row;
  else
    v_row.claim_token := null;
    return v_row;
  end if;

  perform public.content_audit(auth.uid(), 'job.cancel_requested', 'content_job', p_job_id,
    jsonb_build_object('status', v_row.status));
  v_row.claim_token := null;  -- the lease credential never leaves the worker bridge
  return v_row;
end;
$$;

/*
 * Requests a public post of an approved revision to one connected account. The caller
 * must already have created the immutable published copies (content_published_assets)
 * for the revision's images, in order, and passes their ids. Creates the publication
 * and its job in one transaction. Idempotent on p_idempotency_key, and at most one
 * live publication exists per revision and account.
 */
create or replace function public.request_social_publication(
  p_revision_id uuid,
  p_account_id uuid,
  p_published_asset_ids uuid[],
  p_idempotency_key text
)
returns public.social_publications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rev     public.content_variant_revisions;
  v_variant public.content_variants;
  v_account public.social_accounts;
  v_pub     public.social_publications;
  v_job     public.content_jobs;
  v_expected integer;
  v_matching integer;
begin
  perform public.content_require_member();
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('content:' || p_idempotency_key, 0));
  select * into v_pub from public.social_publications where idempotency_key = p_idempotency_key;
  if found then
    return v_pub;
  end if;

  select * into v_rev from public.content_variant_revisions where id = p_revision_id;
  if not found then
    raise exception 'Revision not found.' using errcode = 'P0002';
  end if;
  select * into v_variant from public.content_variants where id = v_rev.variant_id for share;
  select * into v_account from public.social_accounts where id = p_account_id;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;

  if not public.content_revision_is_approved(p_revision_id) then
    raise exception 'Only the approved current revision can be published.'
      using errcode = 'CRM06', hint = 'not_approved';
  end if;
  if v_account.status <> 'connected' then
    raise exception 'The account needs to be reconnected.' using errcode = 'CRM07', hint = 'account_not_connected';
  end if;
  if v_account.platform <> v_variant.channel then
    raise exception 'This variant is for %, not %.', v_variant.channel, v_account.platform
      using errcode = 'CRM07', hint = 'channel_mismatch';
  end if;

  -- The pinned published copies must be exactly the revision's images, in order.
  v_expected := jsonb_array_length(v_rev.assets);
  if coalesce(cardinality(p_published_asset_ids), 0) <> v_expected then
    raise exception 'Published images do not match the revision.' using errcode = 'CRM07', hint = 'asset_mismatch';
  end if;
  select count(*) into v_matching
    from jsonb_array_elements(v_rev.assets) with ordinality as a(ref, ord)
    join public.content_published_assets p on p.id = p_published_asset_ids[a.ord::integer]
   where p.asset_id = (a.ref ->> 'assetId')::uuid and p.purpose = 'social';
  if v_matching <> v_expected then
    raise exception 'Published images do not match the revision.' using errcode = 'CRM07', hint = 'asset_mismatch';
  end if;

  begin
    insert into public.social_publications (
      revision_id, variant_id, account_id, status, idempotency_key, published_asset_ids, requested_by
    )
    values (p_revision_id, v_variant.id, p_account_id, 'queued', p_idempotency_key,
            coalesce(p_published_asset_ids, '{}'), auth.uid())
    returning * into v_pub;
  exception when unique_violation then
    raise exception 'This revision already has a live publication on that account.'
      using errcode = 'CRM06', hint = 'already_published';
  end;

  insert into public.content_jobs (kind, idempotency_key, item_id, variant_id, base_revision_id,
                                   publication_id, input, created_by, max_attempts)
  values ('publish_social', 'publish:' || v_pub.id, v_variant.item_id, v_variant.id, p_revision_id,
          v_pub.id, jsonb_build_object('publicationId', v_pub.id), auth.uid(), 3)
  returning * into v_job;

  update public.social_publications set job_id = v_job.id where id = v_pub.id returning * into v_pub;

  perform public.content_audit(auth.uid(), 'publication.requested', 'social_publication', v_pub.id,
    jsonb_build_object('revisionId', p_revision_id, 'accountId', p_account_id, 'jobId', v_job.id));
  return v_pub;
end;
$$;

/*
 * A person settles an uncertain job after checking the provider (§9 step 6). For a
 * publication, 'succeeded' may record the external id and permalink they found.
 */
create or replace function public.resolve_uncertain_content_job(
  p_job_id uuid,
  p_resolution text,
  p_note text,
  p_external_id text default null,
  p_permalink text default null
)
returns public.content_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.content_jobs;
begin
  perform public.content_require_member();
  if p_resolution not in ('succeeded', 'failed') then
    raise exception 'Resolution must be succeeded or failed.' using errcode = '22023';
  end if;
  if nullif(btrim(p_note), '') is null then
    raise exception 'Explain how this was checked.' using errcode = '22023';
  end if;
  if p_resolution = 'succeeded' and not exists (
    select 1 from public.content_jobs where id = p_job_id and kind = 'publish_social'
  ) then
    raise exception 'Only a publication can be confirmed; generate again instead.' using errcode = '22023';
  end if;
  if p_permalink is not null and p_permalink !~ '^https://' then
    raise exception 'The permalink must be an https URL.' using errcode = '22023';
  end if;

  update public.content_jobs
     set status = p_resolution, resolved_by = auth.uid(), resolution_note = left(p_note, 1000),
         finished_at = coalesce(finished_at, now())
   where id = p_job_id and status = 'uncertain'
  returning * into v_row;
  if not found then
    raise exception 'Only an uncertain job can be resolved.' using errcode = 'CRM06';
  end if;

  if v_row.publication_id is not null then
    update public.social_publications
       set status = case when p_resolution = 'succeeded' then 'published' else 'failed' end,
           external_id = coalesce(p_external_id, external_id),
           permalink = coalesce(p_permalink, permalink),
           resolved_by = auth.uid(), resolution_note = left(p_note, 1000), finished_at = now()
     where id = v_row.publication_id and status = 'uncertain';
  end if;

  perform public.content_audit(auth.uid(), 'job.resolved', 'content_job', p_job_id,
    jsonb_build_object('resolution', p_resolution, 'note', p_note));
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Worker functions (service role only, reached through the CRM worker bridge)
-- ---------------------------------------------------------------------------

/*
 * Settles leases that expired. Before begin-dispatch a job is safely retryable; after
 * it the external effect may have happened, so it becomes 'uncertain' (never retried
 * automatically). Also finalises queued jobs whose cancellation was requested.
 * Returns the number of rows changed.
 */
create or replace function public.recover_content_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_n     integer;
begin
  perform public.content_require_service();

  -- Jobs first, then the publications derived from them: the same lock order as every
  -- other worker function, so recovery cannot deadlock with a worker.
  with expired as (
    update public.content_jobs
       set status = 'uncertain', finished_at = now(), claim_token = null, lease_expires_at = null,
           error_code = 'lease_expired_after_dispatch',
           error_message = 'The worker stopped after the external call started. Check the provider before retrying.'
     where status = 'running' and lease_expires_at < now() and dispatch_started_at is not null
       and kind <> 'ingest_asset'
    returning publication_id
  ), publications as (
    update public.social_publications p set status = 'uncertain'
      from expired e where p.id = e.publication_id and p.status = 'dispatching'
    returning p.id
  )
  select count(*) into v_n from expired;

  -- Before dispatch (and ingestion, which has no external effect) the job is retryable.
  with requeued as (
    update public.content_jobs
       set status = case when cancel_requested_at is not null then 'cancelled'
                         when attempts >= max_attempts then 'failed'
                         else 'queued' end,
           next_attempt_at = now() + make_interval(secs => least(600, 15 * power(2, attempts)::integer)),
           finished_at = case when attempts >= max_attempts or cancel_requested_at is not null then now() end,
           error_code = coalesce(error_code, 'lease_expired'),
           dispatch_started_at = null,
           claim_token = null, lease_expires_at = null
     where status = 'running' and lease_expires_at < now()
       and (dispatch_started_at is null or kind = 'ingest_asset')
    returning id
  )
  select count(*) into v_count from requeued;

  update public.content_jobs
     set status = 'cancelled', finished_at = now()
   where status = 'queued' and cancel_requested_at is not null;

  with closed as (
    select id, publication_id, asset_id, kind, status from public.content_jobs
     where status in ('failed', 'cancelled') and finished_at >= now() - interval '1 day'
  )
  update public.social_publications p
     set status = case when c.status = 'cancelled' then 'cancelled' else 'failed' end, finished_at = now()
    from closed c
   where c.publication_id = p.id and p.status = 'queued';

  -- An upload whose ingestion gave up must not stay 'pending' forever.
  update public.content_assets a
     set ingest_status = 'rejected', rejection_reason = 'Processing did not finish. Upload the file again.'
    from public.content_jobs j
   where j.asset_id = a.id and j.kind = 'ingest_asset' and j.status in ('failed', 'cancelled')
     and a.ingest_status = 'pending';

  return v_count + v_n;
end;
$$;

create or replace function public.claim_content_jobs(
  p_worker_id     text,
  p_kinds         text[],
  p_limit         integer,
  p_lease_seconds integer default 120
)
returns table (
  job_id       uuid,
  kind         text,
  claim_token  uuid,
  attempt      integer,
  input        jsonb,
  checkpoint   jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_token uuid := gen_random_uuid();
begin
  perform public.content_require_service();
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'claim_content_jobs: p_limit must be between 1 and 20' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'claim_content_jobs: p_lease_seconds must be between 30 and 900' using errcode = '22023';
  end if;
  if nullif(btrim(p_worker_id), '') is null then
    raise exception 'claim_content_jobs: worker id required' using errcode = '22023';
  end if;

  perform public.recover_content_jobs();

  return query
  with picked as (
    select j.id
      from public.content_jobs j
     where j.status = 'queued'
       and j.next_attempt_at <= now()
       and j.cancel_requested_at is null
       and (p_kinds is null or j.kind = any (p_kinds))
     order by j.next_attempt_at, j.created_at
     limit p_limit
     for update skip locked
  )
  update public.content_jobs j
     set status = 'running',
         claim_token = v_token,
         worker_id = left(p_worker_id, 120),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         started_at = coalesce(j.started_at, now()),
         attempts = j.attempts + 1
    from picked
   where j.id = picked.id
  returning j.id, j.kind, v_token, j.attempts, j.input, j.checkpoint;
end;
$$;

/*
 * Extends the lease. Returns 'ok', 'cancel_requested' (stop before the next stage) or
 * 'lost' (another worker or the recovery owns the job now — stop immediately).
 */
create or replace function public.heartbeat_content_job(
  p_job_id uuid, p_token uuid, p_lease_seconds integer default 120
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.content_jobs;
begin
  perform public.content_require_service();
  update public.content_jobs
     set lease_expires_at = now() + make_interval(secs => greatest(30, least(900, p_lease_seconds))),
         heartbeat_at = now()
   where id = p_job_id and claim_token = p_token and status = 'running' and lease_expires_at >= now()
  returning * into v_row;
  if not found then
    return 'lost';
  end if;
  return case when v_row.cancel_requested_at is not null then 'cancel_requested' else 'ok' end;
end;
$$;

create or replace function public.checkpoint_content_job(p_job_id uuid, p_token uuid, p_checkpoint jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.content_jobs;
begin
  perform public.content_require_service();
  if p_checkpoint is null or jsonb_typeof(p_checkpoint) <> 'object' then
    raise exception 'checkpoint must be an object' using errcode = '22023';
  end if;
  update public.content_jobs
     set checkpoint = checkpoint || p_checkpoint
   where id = p_job_id and claim_token = p_token and status = 'running' and lease_expires_at >= now()
  returning * into v_row;
  if not found then
    return false;
  end if;
  if v_row.publication_id is not null then
    update public.social_publications set checkpoint = checkpoint || p_checkpoint where id = v_row.publication_id;
  end if;
  return true;
end;
$$;

/*
 * Records that the external effect is about to start, after re-validating everything
 * that authorises it. Returns:
 *   'go'       — call the provider now.
 *   'lost'     — the lease is gone; do nothing.
 *   'refused'  — authorisation no longer holds (edited/unapproved revision, account not
 *                connected, cancellation); the job and publication are closed and the
 *                provider must NOT be called.
 * Calling it twice with the same token is safe and returns 'go' again only while the
 * job is still running under that token.
 */
create or replace function public.begin_content_dispatch(p_job_id uuid, p_token uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.content_jobs;
  v_pub     public.social_publications;
  v_account public.social_accounts;
  v_reason  text;
begin
  perform public.content_require_service();
  select * into v_job from public.content_jobs
   where id = p_job_id and claim_token = p_token and status = 'running' and lease_expires_at >= now()
   for update;
  if not found then
    return 'lost';
  end if;

  if v_job.cancel_requested_at is not null then
    v_reason := 'cancelled';
  elsif v_job.kind = 'publish_social' then
    select * into v_pub from public.social_publications where id = v_job.publication_id for update;
    select * into v_account from public.social_accounts where id = v_pub.account_id;
    if v_pub.status not in ('queued', 'dispatching') then
      v_reason := 'publication_' || v_pub.status;
    elsif not public.content_revision_is_approved(v_pub.revision_id) then
      v_reason := 'revision_not_approved';
    elsif v_account.status <> 'connected' then
      v_reason := 'account_not_connected';
    end if;
  elsif v_job.kind = 'ingest_asset' then
    v_reason := null; -- no external effect; begin-dispatch is a no-op guard
  end if;

  if v_reason is not null then
    update public.content_jobs
       set status = case when v_reason = 'cancelled' then 'cancelled' else 'failed' end,
           error_code = 'dispatch_refused', error_message = v_reason,
           claim_token = null, lease_expires_at = null, finished_at = now()
     where id = p_job_id;
    if v_job.publication_id is not null then
      update public.social_publications
         set status = case when v_reason = 'cancelled' then 'cancelled' else 'failed' end,
             error_code = 'dispatch_refused', error_message = v_reason, finished_at = now()
       where id = v_job.publication_id and status in ('queued', 'dispatching');
    end if;
    return 'refused';
  end if;

  update public.content_jobs set dispatch_started_at = coalesce(dispatch_started_at, now()) where id = p_job_id;
  if v_job.publication_id is not null then
    update public.social_publications
       set status = 'dispatching', dispatch_started_at = coalesce(dispatch_started_at, now())
     where id = v_job.publication_id;
  end if;
  return 'go';
end;
$$;

-- Applies a generate_text result. Called only from complete_content_job.
create or replace function public.content_apply_generation(v_job public.content_jobs, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_elem     jsonb;
  v_variant  public.content_variants;
  v_rev      public.content_variant_revisions;
  v_first    boolean := true;
  v_created  jsonb := '[]'::jsonb;
  v_content  jsonb;
  v_conflict boolean := false;
begin
  if jsonb_typeof(p_result -> 'variants') <> 'array' or jsonb_array_length(p_result -> 'variants') = 0 then
    raise exception 'A generation result needs at least one variant; report failures with fail.'
      using errcode = '22023';
  end if;

  for v_elem in select value from jsonb_array_elements(p_result -> 'variants') loop
    if (v_elem ->> 'channel') is null or not ((v_elem ->> 'channel') = any (
         select jsonb_array_elements_text(coalesce(v_job.input -> 'channels', '[]'::jsonb)))) then
      raise exception 'Result channel % was not requested.', v_elem ->> 'channel' using errcode = '22023';
    end if;
    v_content := v_elem || jsonb_build_object(
      'promptVersion', coalesce(v_elem ->> 'promptVersion', p_result ->> 'promptVersion'),
      'assets', '[]'::jsonb);

    if v_first and v_job.variant_id is not null then
      select * into v_variant from public.content_variants where id = v_job.variant_id for update;
      if v_variant.current_revision_id is not distinct from v_job.base_revision_id
         and v_variant.channel = v_elem ->> 'channel'
         and v_variant.archived_at is null then
        v_rev := public.content_insert_revision(v_variant.id, v_job.base_revision_id, 'regenerated',
                   -- A regeneration keeps the images the operator had chosen.
                   v_content || jsonb_build_object('assets', coalesce(
                     (select assets from public.content_variant_revisions where id = v_job.base_revision_id),
                     '[]'::jsonb)),
                   v_job.id, null, v_job.created_by);
        v_created := v_created || jsonb_build_object('variantId', v_variant.id, 'revisionId', v_rev.id, 'conflict', false);
        v_first := false;
        continue;
      end if;
      v_conflict := true;
    end if;
    v_first := false;

    insert into public.content_variants (item_id, channel, style, conflict_of_revision_id)
    values (v_job.item_id, v_elem ->> 'channel', left(coalesce(nullif(v_elem ->> 'style', ''), 'default'), 40),
            case when v_conflict then v_job.base_revision_id end)
    returning * into v_variant;
    v_rev := public.content_insert_revision(v_variant.id, null,
               case when v_job.variant_id is null then 'generated' else 'regenerated' end,
               v_content, v_job.id, null, v_job.created_by);
    v_created := v_created || jsonb_build_object('variantId', v_variant.id, 'revisionId', v_rev.id, 'conflict', v_conflict);
    v_conflict := false;
  end loop;

  return v_created;
end;
$$;

-- Validates a file description the worker reports and that its path is inside the
-- prefix the CRM assigned for this job.
create or replace function public.content_assert_file(p_file jsonb, p_prefix text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_file is null
     or (p_file ->> 'path') is null
     or left(p_file ->> 'path', char_length(p_prefix)) <> p_prefix
     or (p_file ->> 'path') ~ '\.\.'
     or (p_file ->> 'mimeType') not in ('image/jpeg', 'image/png', 'image/webp')
     or coalesce((p_file ->> 'byteSize')::bigint, 0) not between 1 and 15728640
     or coalesce((p_file ->> 'width')::int, 0) not between 1 and 8192
     or coalesce((p_file ->> 'height')::int, 0) not between 1 and 8192
     or coalesce(p_file ->> 'checksum', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid file description for prefix %.', p_prefix using errcode = '22023';
  end if;
end;
$$;

create or replace function public.content_apply_asset_files(p_asset_id uuid, p_files jsonb, p_prefix text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  perform public.content_assert_file(p_files -> 'original', p_prefix);
  for v_key in select jsonb_object_keys(coalesce(p_files -> 'renditions', '{}'::jsonb)) loop
    if v_key not in ('social', 'email') then
      raise exception 'Unknown rendition %.', v_key using errcode = '22023';
    end if;
    perform public.content_assert_file(p_files -> 'renditions' -> v_key, p_prefix);
  end loop;

  update public.content_assets
     set ingest_status = 'ready',
         storage_path = p_files -> 'original' ->> 'path',
         mime_type = p_files -> 'original' ->> 'mimeType',
         byte_size = (p_files -> 'original' ->> 'byteSize')::int,
         width = (p_files -> 'original' ->> 'width')::int,
         height = (p_files -> 'original' ->> 'height')::int,
         checksum = p_files -> 'original' ->> 'checksum',
         renditions = coalesce(p_files -> 'renditions', '{}'::jsonb),
         rejection_reason = null
   where id = p_asset_id;
end;
$$;

/*
 * Stores the result and closes the job, atomically, only for the current lease holder.
 * Returns false for a stale worker (its result is discarded, never applied).
 */
create or replace function public.complete_content_job(p_job_id uuid, p_token uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.content_jobs;
  v_applied jsonb := '{}'::jsonb;
  v_elem    jsonb;
  v_asset   public.content_assets;
  v_assets  jsonb := '[]'::jsonb;
begin
  perform public.content_require_service();
  if p_result is null or jsonb_typeof(p_result) <> 'object' then
    raise exception 'result must be an object' using errcode = '22023';
  end if;

  select * into v_job from public.content_jobs
   where id = p_job_id and claim_token = p_token and status = 'running' and lease_expires_at >= now()
   for update;
  if not found then
    return false;
  end if;
  if v_job.kind in ('generate_text', 'generate_image', 'publish_social') and v_job.dispatch_started_at is null then
    raise exception '% must call begin-dispatch before completing.', v_job.kind using errcode = 'CRM06';
  end if;

  if v_job.kind = 'generate_text' then
    v_applied := jsonb_build_object('created', public.content_apply_generation(v_job, p_result));

  elsif v_job.kind = 'generate_image' then
    if jsonb_typeof(p_result -> 'assets') <> 'array' or jsonb_array_length(p_result -> 'assets') not between 1 and 4 then
      raise exception 'generate_image returns 1 to 4 assets' using errcode = '22023';
    end if;
    for v_elem in select value from jsonb_array_elements(p_result -> 'assets') loop
      insert into public.content_assets (brand_id, item_id, origin, ingest_status, generation_prompt, job_id,
                                         created_by, alt_text)
      select i.brand_id, v_job.item_id, 'generated', 'pending', left(coalesce(v_job.input ->> 'prompt', ''), 4000),
             v_job.id, v_job.created_by, left(coalesce(v_elem ->> 'alt', ''), 500)
        from public.content_items i where i.id = v_job.item_id
      returning * into v_asset;
      if v_asset.id is null then
        raise exception 'The item of this job no longer exists.' using errcode = 'P0002';
      end if;
      perform public.content_apply_asset_files(v_asset.id, v_elem -> 'files', 'generated/' || v_job.id || '/');
      v_assets := v_assets || to_jsonb(v_asset.id);
    end loop;
    v_applied := jsonb_build_object('assetIds', v_assets);

  elsif v_job.kind = 'ingest_asset' then
    if p_result ->> 'status' = 'rejected' then
      update public.content_assets
         set ingest_status = 'rejected', rejection_reason = left(coalesce(p_result ->> 'reason', 'rejected'), 500)
       where id = v_job.asset_id and ingest_status = 'pending';
    else
      if not exists (select 1 from public.content_assets where id = v_job.asset_id and ingest_status = 'pending') then
        raise exception 'The asset is no longer pending.' using errcode = 'CRM06';
      end if;
      perform public.content_apply_asset_files(v_job.asset_id, p_result -> 'files', 'library/' || v_job.asset_id || '/');
    end if;

  elsif v_job.kind = 'publish_social' then
    if nullif(p_result ->> 'externalId', '') is null then
      raise exception 'A publication result needs the external id; report an unnamed post as uncertain.'
        using errcode = '22023';
    end if;
    if (p_result ->> 'permalink') is not null and (p_result ->> 'permalink') !~ '^https://' then
      raise exception 'permalink must be https' using errcode = '22023';
    end if;
    update public.social_publications
       set status = 'published', external_id = p_result ->> 'externalId',
           permalink = p_result ->> 'permalink', finished_at = now(), error_code = null, error_message = null
     where id = v_job.publication_id;
    perform public.content_audit(null, 'publication.published', 'social_publication', v_job.publication_id,
      jsonb_build_object('externalId', p_result ->> 'externalId', 'permalink', p_result ->> 'permalink'));
  end if;

  update public.content_jobs
     set status = 'succeeded', result = p_result || jsonb_build_object('applied', v_applied),
         usage = p_result -> 'usage', provider_request_id = coalesce(p_result ->> 'providerRequestId', provider_request_id),
         claim_token = null, lease_expires_at = null, finished_at = now(),
         error_code = null, error_message = null
   where id = p_job_id;
  return true;
end;
$$;

/*
 * Records a failure. p_outcome:
 *   'retry'     — safe to try again (only honoured before begin-dispatch; after it the
 *                 job becomes 'uncertain', because the effect may have happened).
 *   'failed'    — definitive; the provider refused or the input is invalid.
 *   'uncertain' — the effect may have happened; a person must reconcile.
 */
create or replace function public.fail_content_job(
  p_job_id uuid, p_token uuid, p_outcome text, p_error_code text, p_message text,
  p_provider_request_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.content_jobs;
  v_outcome text := p_outcome;
begin
  perform public.content_require_service();
  if p_outcome not in ('retry', 'failed', 'uncertain') then
    raise exception 'outcome must be retry, failed or uncertain' using errcode = '22023';
  end if;

  select * into v_job from public.content_jobs
   where id = p_job_id and claim_token = p_token and status = 'running' and lease_expires_at >= now()
   for update;
  if not found then
    return false;
  end if;

  if v_outcome = 'retry' and v_job.dispatch_started_at is not null and v_job.kind = 'publish_social' then
    v_outcome := 'uncertain';
  end if;
  if v_outcome = 'retry' and (v_job.attempts >= v_job.max_attempts or v_job.cancel_requested_at is not null) then
    v_outcome := case when v_job.cancel_requested_at is not null then 'cancelled' else 'failed' end;
  end if;

  update public.content_jobs
     set status = case v_outcome when 'retry' then 'queued' else v_outcome end,
         next_attempt_at = case when v_outcome = 'retry'
                                then now() + make_interval(secs => least(600, 15 * power(2, v_job.attempts)::integer))
                                else next_attempt_at end,
         -- A generation retried after begin-dispatch starts a fresh provider call.
         dispatch_started_at = case when v_outcome = 'retry' then null else dispatch_started_at end,
         error_code = left(coalesce(p_error_code, 'unknown'), 80),
         error_message = left(coalesce(p_message, ''), 1000),
         provider_request_id = coalesce(p_provider_request_id, provider_request_id),
         claim_token = null, lease_expires_at = null,
         finished_at = case when v_outcome = 'retry' then null else now() end
   where id = p_job_id;

  if v_job.publication_id is not null and v_outcome <> 'retry' then
    update public.social_publications
       set status = v_outcome, error_code = left(coalesce(p_error_code, 'unknown'), 80),
           error_message = left(coalesce(p_message, ''), 1000),
           finished_at = case when v_outcome = 'uncertain' then null else now() end
     where id = v_job.publication_id and status in ('queued', 'dispatching');
  end if;
  if v_job.kind = 'ingest_asset' and v_outcome = 'failed' then
    update public.content_assets
       set ingest_status = 'rejected', rejection_reason = left(coalesce(p_message, p_error_code), 500)
     where id = v_job.asset_id and ingest_status = 'pending';
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Function privileges
-- ---------------------------------------------------------------------------
revoke all on function public.content_require_member() from public, anon;
revoke all on function public.content_require_service() from public, anon;
revoke all on function public.content_revision_checksum(text, text[], text, text, jsonb, jsonb) from public, anon;
revoke all on function public.content_audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.content_normalise_asset_refs(jsonb) from public, anon, authenticated;
revoke all on function public.content_insert_revision(uuid, uuid, text, jsonb, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.content_apply_generation(public.content_jobs, jsonb) from public, anon, authenticated;
revoke all on function public.content_assert_file(jsonb, text) from public, anon, authenticated;
revoke all on function public.content_apply_asset_files(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.refuse_content_mutation() from public, anon, authenticated;
grant execute on function public.content_require_member() to authenticated, service_role;
grant execute on function public.content_require_service() to authenticated, service_role;
grant execute on function public.content_revision_checksum(text, text[], text, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.content_audit(uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.content_normalise_asset_refs(jsonb) to service_role;
grant execute on function public.content_insert_revision(uuid, uuid, text, jsonb, uuid, text, uuid) to service_role;
grant execute on function public.content_apply_generation(public.content_jobs, jsonb) to service_role;
grant execute on function public.content_assert_file(jsonb, text) to service_role;
grant execute on function public.content_apply_asset_files(uuid, jsonb, text) to service_role;

-- Member-callable.
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.create_content_revision(uuid, uuid, jsonb, text)',
    'public.duplicate_content_variant(uuid, text)',
    'public.review_content_revision(uuid, text, text)',
    'public.content_revision_is_approved(uuid)',
    'public.enqueue_content_job(text, text, uuid, uuid, uuid, uuid, jsonb)',
    'public.cancel_content_job(uuid)',
    'public.request_social_publication(uuid, uuid, uuid[], text)',
    'public.resolve_uncertain_content_job(uuid, text, text, text, text)',
    'public.record_content_audit(text, text, uuid, jsonb)',
    'public.update_content_brand_profile(text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated, service_role', v_fn);
  end loop;

  -- Worker bridge only.
  foreach v_fn in array array[
    'public.recover_content_jobs()',
    'public.claim_content_jobs(text, text[], integer, integer)',
    'public.heartbeat_content_job(uuid, uuid, integer)',
    'public.checkpoint_content_job(uuid, uuid, jsonb)',
    'public.begin_content_dispatch(uuid, uuid)',
    'public.complete_content_job(uuid, uuid, jsonb)',
    'public.fail_content_job(uuid, uuid, text, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
