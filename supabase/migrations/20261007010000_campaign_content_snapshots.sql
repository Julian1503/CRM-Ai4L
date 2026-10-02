-- Campaign content snapshots: the email bridge from the Content Studio (plan §8.3–§8.5).
--
-- 1. Versioned template contracts. campaign_templates gains contract_id/version; every
--    existing template is 'legacy-v1' (the seven fixed fields), so current campaigns
--    behave exactly as before. The contract definitions live in code
--    (src/lib/marketing/templateContracts.ts); the database pins which one a template uses
--    and refuses to change it once a campaign depends on it.
-- 2. campaign_content_snapshots: immutable copy of what a Studio email says — fields,
--    CTA mode and URL, published images, rendered HTML/text — with a content hash the
--    database computes itself. Editing the source afterwards never changes a campaign
--    (§6 rule 3). The same table records HTML exports (purpose 'export'), which are
--    registered as exports and never as deliveries.
-- 3. Approval binds to the snapshot hash as well as the revision; dispatch re-checks it.
-- 4. Each run records the snapshot, hash, automation and CTA mode it sent (evidence).
-- 5. A run never mixes two versions of Studio content (§8.5): a snapshot campaign's content,
--    template and automation cannot change at all (rule 6), so a partially sent Studio
--    campaign keeps its one version and new content is a new campaign. Hand-written
--    campaigns keep their audited behaviour (a failed campaign may be corrected and retried
--    for the remaining recipients; verify_20261003000000 section 6).
-- 6. A snapshot campaign's merge_fields mirror its snapshot and cannot be edited alone:
--    new content means a new snapshot.

-- ---------------------------------------------------------------------------
-- 1. Template contracts
-- ---------------------------------------------------------------------------
alter table public.campaign_templates
    add column if not exists contract_id text not null default 'legacy-v1',
    add column if not exists contract_version integer not null default 1;

alter table public.campaign_templates
    drop constraint if exists campaign_templates_contract_format;
alter table public.campaign_templates
    add constraint campaign_templates_contract_format
    check (contract_id ~ '^[a-z0-9][a-z0-9-]{2,60}$' and contract_version between 1 and 1000);

create or replace function public.freeze_used_template_contract()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if (new.contract_id is distinct from old.contract_id or new.contract_version is distinct from old.contract_version)
     and exists (select 1 from public.campaigns where template_id = old.id) then
    raise exception 'This template is used by campaigns. Register a new template for a new contract version.'
      using errcode = 'CRM06', hint = 'template_in_use';
  end if;
  return new;
end;
$$;

drop trigger if exists campaign_templates_freeze_contract on public.campaign_templates;
create trigger campaign_templates_freeze_contract
    before update of contract_id, contract_version on public.campaign_templates
    for each row execute function public.freeze_used_template_contract();

-- ---------------------------------------------------------------------------
-- 2. Snapshots
-- ---------------------------------------------------------------------------
create table if not exists public.campaign_content_snapshots (
    id                 uuid primary key default gen_random_uuid(),
    purpose            text not null check (purpose in ('campaign', 'export')),
    source_revision_id uuid not null references public.content_variant_revisions (id) on delete restrict,
    template_id        uuid references public.campaign_templates (id) on delete restrict,
    -- The automation the hash covers; the campaign must send through this one.
    provider_automation_id text,
    contract_id        text not null,
    contract_version   integer not null,
    cta_mode           text not null check (cta_mode in ('booking', 'external_url', 'none')),
    cta_url            text,
    subject            text,
    -- Validated slot values: exactly what goes to the provider's contact fields.
    fields             jsonb not null,
    -- [{ assetId, publishedAssetId, url, checksum, alt, order }]
    assets             jsonb not null default '[]'::jsonb,
    rendered_html      text,
    rendered_text      text,
    content_hash       text not null,
    idempotency_key    text not null unique,
    created_by         uuid references auth.users (id) on delete set null,
    created_at         timestamptz not null default timezone('utc'::text, now()),
    constraint campaign_snapshots_fields_object check (jsonb_typeof(fields) = 'object'),
    constraint campaign_snapshots_assets_array check (jsonb_typeof(assets) = 'array'),
    constraint campaign_snapshots_cta_url check (
      (cta_mode = 'external_url' and cta_url ~ '^https://[^\s]+$')
      or (cta_mode <> 'external_url' and cta_url is null)
    ),
    constraint campaign_snapshots_campaign_has_template check (purpose = 'export' or template_id is not null),
    -- Reserved, system-owned fields never travel in content (§8.4).
    constraint campaign_snapshots_no_reserved_fields check (
      not (fields ?| array['BookingUrl', 'PrefsUrl', 'Newsletter', 'Courses'])
    ),
    constraint campaign_snapshots_html_size check (rendered_html is null or octet_length(rendered_html) <= 200000)
);

comment on table public.campaign_content_snapshots is
  'Immutable email content derived from a Content Studio revision: campaign drafts and HTML exports.';

drop trigger if exists campaign_content_snapshots_immutable on public.campaign_content_snapshots;
create trigger campaign_content_snapshots_immutable
    before update or delete on public.campaign_content_snapshots
    for each row execute function public.refuse_content_mutation();

alter table public.campaign_content_snapshots
    add column if not exists provider_automation_id text;

create index if not exists campaign_snapshots_revision_idx on public.campaign_content_snapshots (source_revision_id);
create index if not exists campaign_snapshots_template_idx on public.campaign_content_snapshots (template_id);

-- Evidence: append-only for every role.
revoke delete, truncate on public.campaign_content_snapshots from service_role;

alter table public.campaigns
    add column if not exists content_snapshot_id uuid references public.campaign_content_snapshots (id) on delete restrict,
    add column if not exists source_idempotency_key text,
    add column if not exists approved_content_hash text;

create index if not exists campaigns_content_snapshot_idx
    on public.campaigns (content_snapshot_id) where content_snapshot_id is not null;
create unique index if not exists campaigns_source_idempotency_key_idx
    on public.campaigns (source_idempotency_key) where source_idempotency_key is not null;

alter table public.campaign_runs
    add column if not exists content_snapshot_id uuid references public.campaign_content_snapshots (id) on delete restrict,
    add column if not exists content_hash text,
    add column if not exists provider_automation_id text,
    add column if not exists cta_mode text;

create index if not exists campaign_runs_content_snapshot_idx
    on public.campaign_runs (content_snapshot_id) where content_snapshot_id is not null;

alter table public.campaign_content_snapshots enable row level security;
revoke all on public.campaign_content_snapshots from anon, authenticated;
grant select on public.campaign_content_snapshots to authenticated;
grant all on public.campaign_content_snapshots to service_role;
drop policy if exists "Allow read access to authenticated users" on public.campaign_content_snapshots;
create policy "Allow read access to authenticated users"
  on public.campaign_content_snapshots for select to authenticated using (true);
drop policy if exists "Approved CRM members only" on public.campaign_content_snapshots;
create policy "Approved CRM members only"
  on public.campaign_content_snapshots as restrictive for all to authenticated
  using (public.is_crm_member()) with check (public.is_crm_member());

-- ---------------------------------------------------------------------------
-- 3. Hash
-- ---------------------------------------------------------------------------
-- Covers everything that must void an approval when it changes (§6 rule 4): contract,
-- template and its automation, CTA mode and URL, subject, every field, every image
-- (published copy, checksum, alt, order) and the rendered HTML/text.
create or replace function public.campaign_snapshot_hash(
  p_contract_id text, p_contract_version integer, p_template_id uuid, p_automation_id text,
  p_cta_mode text, p_cta_url text, p_subject text, p_fields jsonb, p_assets jsonb,
  p_rendered_html text, p_rendered_text text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(convert_to(jsonb_build_object(
    'contract', p_contract_id, 'contractVersion', p_contract_version, 'template', p_template_id,
    'automation', p_automation_id, 'ctaMode', p_cta_mode, 'ctaUrl', p_cta_url, 'subject', p_subject,
    'fields', coalesce(p_fields, '{}'::jsonb), 'assets', coalesce(p_assets, '[]'::jsonb),
    'html', encode(pg_catalog.sha256(convert_to(coalesce(p_rendered_html, ''), 'UTF8')), 'hex'),
    'text', encode(pg_catalog.sha256(convert_to(coalesce(p_rendered_text, ''), 'UTF8')), 'hex')
  )::text, 'UTF8')), 'hex');
$$;

-- Every image must be a published 'email' copy of the asset it names, at the URL recorded.
create or replace function public.campaign_snapshot_assets(p_assets jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bad integer;
begin
  if p_assets is null or jsonb_typeof(p_assets) <> 'array' then
    return '[]'::jsonb;
  end if;
  if jsonb_array_length(p_assets) > 10 then
    raise exception 'At most 10 images in an email.' using errcode = 'CRM07', hint = 'too_many_assets';
  end if;
  select count(*) into v_bad
    from jsonb_array_elements(p_assets) e
    left join public.content_published_assets p on p.id = (e ->> 'publishedAssetId')::uuid
   where p.id is null or p.purpose <> 'email'
      or p.asset_id <> (e ->> 'assetId')::uuid or p.public_url <> (e ->> 'url')
      or p.checksum <> (e ->> 'checksum');
  if v_bad > 0 then
    raise exception 'Every email image must be a published email copy.' using errcode = 'CRM07', hint = 'asset_not_published';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'assetId', e ->> 'assetId', 'publishedAssetId', e ->> 'publishedAssetId', 'url', e ->> 'url',
             'checksum', e ->> 'checksum', 'alt', left(coalesce(e ->> 'alt', ''), 500), 'order', ord - 1)
           order by ord), '[]'::jsonb)
      from jsonb_array_elements(p_assets) with ordinality as t(e, ord)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Creating a snapshot (and, for purpose 'campaign', its draft campaign)
-- ---------------------------------------------------------------------------
/*
 * One transaction, idempotent on p_idempotency_key. For a campaign, the consent stream
 * and automation come ONLY from the template, and the contract from the template too —
 * never from the caller. The draft status is enforced by the campaigns triggers. A post
 * approval is not required and is not carried over: approving a post never authorises
 * an email (§4 step 8). Field values are validated against the contract in the API
 * (templateContracts.ts); here only structural and reserved-field rules are enforced.
 */
create or replace function public.create_content_email_snapshot(
  p_purpose text,
  p_idempotency_key text,
  p_source_revision_id uuid,
  p_template_id uuid,
  p_cta_mode text,
  p_cta_url text,
  p_subject text,
  p_fields jsonb,
  p_assets jsonb,
  p_rendered_html text,
  p_rendered_text text,
  p_campaign_name text default null,
  p_segment_id uuid default null,
  p_notes text default null,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot public.campaign_content_snapshots;
  v_template public.campaign_templates;
  v_campaign public.campaigns;
  v_assets   jsonb;
  v_actor    uuid := coalesce(auth.uid(), p_actor);
begin
  -- The API renders and validates the email before calling this; a member calling it
  -- directly could store HTML the renderer never produced, so only the server may.
  perform public.content_require_service();
  if v_actor is null then
    raise exception 'The acting member is required.' using errcode = '22023';
  end if;
  if p_purpose not in ('campaign', 'export') then
    raise exception 'purpose must be campaign or export' using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('snapshot:' || p_idempotency_key, 0));
  select * into v_snapshot from public.campaign_content_snapshots where idempotency_key = p_idempotency_key;
  if found then
    select * into v_campaign from public.campaigns where content_snapshot_id = v_snapshot.id;
    return jsonb_build_object('snapshotId', v_snapshot.id, 'campaignId', v_campaign.id, 'created', false,
                              'contentHash', v_snapshot.content_hash);
  end if;

  if not exists (
    select 1 from public.content_variant_revisions r
      join public.content_variants v on v.id = r.variant_id
      join public.content_items i on i.id = v.item_id
     where r.id = p_source_revision_id and v.archived_at is null and i.archived_at is null
  ) then
    raise exception 'Source revision not found.' using errcode = 'P0002';
  end if;

  if p_template_id is not null then
    select * into v_template from public.campaign_templates where id = p_template_id for share;
    if not found or v_template.archived_at is not null then
      raise exception 'Choose an active template.' using errcode = 'CRM07', hint = 'template_unavailable';
    end if;
    if v_template.contract_id = 'legacy-v1' then
      raise exception 'Studio emails need a Studio template contract.' using errcode = 'CRM07', hint = 'legacy_template';
    end if;
  elsif p_purpose = 'campaign' then
    raise exception 'A campaign needs a template.' using errcode = 'CRM07', hint = 'template_required';
  end if;

  if p_purpose = 'campaign' and nullif(btrim(p_campaign_name), '') is null then
    raise exception 'A campaign needs a name.' using errcode = '22023';
  end if;

  v_assets := public.campaign_snapshot_assets(p_assets);

  insert into public.campaign_content_snapshots (
    purpose, source_revision_id, template_id, provider_automation_id, contract_id, contract_version, cta_mode,
    cta_url, subject, fields, assets, rendered_html, rendered_text, content_hash, idempotency_key, created_by
  )
  values (
    p_purpose, p_source_revision_id, p_template_id, v_template.provider_automation_id,
    coalesce(v_template.contract_id, 'export-v1'), coalesce(v_template.contract_version, 1),
    p_cta_mode, nullif(btrim(p_cta_url), ''), nullif(btrim(p_subject), ''),
    coalesce(p_fields, '{}'::jsonb), v_assets, p_rendered_html, p_rendered_text,
    public.campaign_snapshot_hash(
      coalesce(v_template.contract_id, 'export-v1'), coalesce(v_template.contract_version, 1), p_template_id,
      v_template.provider_automation_id, p_cta_mode, nullif(btrim(p_cta_url), ''), nullif(btrim(p_subject), ''),
      coalesce(p_fields, '{}'::jsonb), v_assets, p_rendered_html, p_rendered_text),
    p_idempotency_key, v_actor
  )
  returning * into v_snapshot;

  if p_purpose = 'campaign' then
    insert into public.campaigns (
      name, segment_id, template_id, provider_automation_id, subject, notes, consent_stream,
      merge_fields, content_snapshot_id, source_idempotency_key
    )
    values (
      left(btrim(p_campaign_name), 200), p_segment_id, v_template.id, v_template.provider_automation_id,
      v_snapshot.subject, p_notes, v_template.consent_stream, v_snapshot.fields, v_snapshot.id, p_idempotency_key
    )
    returning * into v_campaign;
  end if;

  perform public.content_audit(v_actor,
    case when p_purpose = 'campaign' then 'email.draft_created' else 'email.exported' end,
    'content_variant_revision', p_source_revision_id,
    jsonb_build_object('snapshotId', v_snapshot.id, 'campaignId', v_campaign.id, 'contentHash', v_snapshot.content_hash));

  return jsonb_build_object('snapshotId', v_snapshot.id, 'campaignId', v_campaign.id, 'created', true,
                            'contentHash', v_snapshot.content_hash);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Revision, approval and run rules
-- ---------------------------------------------------------------------------
create or replace function public.enforce_campaign_revision()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_content_changed boolean;
  v_audience_changed boolean;
begin
  v_audience_changed :=
       new.segment_id is distinct from old.segment_id
    or new.consent_stream is distinct from old.consent_stream;

  v_content_changed := v_audience_changed
    or new.merge_fields is distinct from old.merge_fields
    or new.subject is distinct from old.subject
    or new.provider_automation_id is distinct from old.provider_automation_id
    or new.template_id is distinct from old.template_id
    or new.content_snapshot_id is distinct from old.content_snapshot_id;

  -- A Studio campaign's copy is its snapshot. Changing the copy alone would send words
  -- nobody approved under the snapshot's hash; new content needs a new snapshot.
  if new.content_snapshot_id is not null
     and new.content_snapshot_id is not distinct from old.content_snapshot_id
     and (new.merge_fields is distinct from old.merge_fields or new.subject is distinct from old.subject) then
    raise exception 'This campaign''s content comes from the Content Studio. Create a new email from the Studio to change it.'
      using errcode = 'CRM07', hint = 'snapshot_content_locked';
  end if;
  if new.content_snapshot_id is not null
     and new.content_snapshot_id is not distinct from old.content_snapshot_id
     and (new.template_id is distinct from old.template_id
          or new.provider_automation_id is distinct from old.provider_automation_id) then
    raise exception 'The template and automation of a Content Studio email come from its snapshot.'
      using errcode = 'CRM07', hint = 'snapshot_content_locked';
  end if;

  if v_content_changed then
    if old.status not in ('draft', 'failed') and new.status <> 'draft' then
      raise exception 'Return this campaign to draft before changing its content.'
        using errcode = 'CRM03';
    end if;

    new.revision := old.revision + 1;

    if old.status = 'failed' then
      new.status := 'draft';
      -- A different audience cannot reuse the old run's recipient ledger.
      if v_audience_changed then
        new.send_run := old.send_run + 1;
      end if;
    end if;
  end if;

  if new.status = 'draft' and old.status <> 'draft' then
    new.approved_revision := null;
    new.approved_by := null;
    new.approved_at := null;
    new.approved_content_hash := null;
  end if;

  -- Approval binds to the revision, and for a Studio campaign to its snapshot's hash.
  if new.status = 'approved' and old.status in ('in_review', 'draft') then
    new.approved_revision := new.revision;
    new.approved_content_hash := (
      select content_hash from public.campaign_content_snapshots where id = new.content_snapshot_id
    );
  end if;

  if new.status = 'sending' and new.approved_revision is distinct from new.revision then
    raise exception 'This campaign changed after it was approved. It must be approved again.'
      using errcode = 'CRM04';
  end if;

  if new.status = 'sending' and old.status <> 'sending' and not exists (
       select 1 from public.campaign_runs r
        where r.campaign_id = new.id and r.run = new.send_run and r.audience_status = 'prepared'
     ) then
    raise exception 'This campaign''s audience has not been fully prepared for sending.'
      using errcode = 'CRM05';
  end if;

  if new.status = 'approved' and old.status = 'failed'
     and new.approved_revision is distinct from new.revision then
    raise exception 'A retry must send the revision that was approved.' using errcode = 'CRM04';
  end if;

  return new;
end;
$$;

-- Each run records the content it sends. Set by the database from the campaign so the
-- evidence cannot disagree with what dispatch checks.
create or replace function public.stamp_campaign_run_content()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_campaign public.campaigns;
begin
  if tg_op = 'UPDATE' and exists (
       select 1 from public.campaign_sends s
        where s.campaign_id = old.campaign_id and s.run = old.run and s.status in ('sent', 'uncertain', 'processing')
     ) then
    new.content_snapshot_id := old.content_snapshot_id;
    new.content_hash := old.content_hash;
    new.provider_automation_id := old.provider_automation_id;
    new.cta_mode := old.cta_mode;
    return new;
  end if;
  select * into v_campaign from public.campaigns where id = new.campaign_id;
  new.content_snapshot_id := v_campaign.content_snapshot_id;
  new.content_hash := (select content_hash from public.campaign_content_snapshots where id = v_campaign.content_snapshot_id);
  new.provider_automation_id := v_campaign.provider_automation_id;
  new.cta_mode := coalesce(
    (select cta_mode from public.campaign_content_snapshots where id = v_campaign.content_snapshot_id),
    'booking');
  return new;
end;
$$;

drop trigger if exists campaign_runs_stamp_content on public.campaign_runs;
create trigger campaign_runs_stamp_content
    before insert or update on public.campaign_runs
    for each row execute function public.stamp_campaign_run_content();

create or replace function public.begin_campaign_dispatch(p_send_id uuid, p_token uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row      public.campaign_sends;
  v_campaign public.campaigns;
  v_contact  public.contacts;
  v_reason   text;
begin
  select * into v_row from public.campaign_sends
   where id = p_send_id
   for update;

  if not found or v_row.status <> 'processing' or v_row.claim_token is distinct from p_token
     or v_row.lease_expires_at < now() then
    return 'lost';
  end if;

  select * into v_campaign from public.campaigns where id = v_row.campaign_id;

  if v_campaign.status <> 'sending' or v_campaign.send_run <> v_row.run
     or v_campaign.approved_revision is distinct from v_campaign.revision
     -- A Studio campaign sends only the snapshot that was approved.
     or v_campaign.approved_content_hash is distinct from (
          select content_hash from public.campaign_content_snapshots where id = v_campaign.content_snapshot_id
        )
     or (v_campaign.content_snapshot_id is not null and not exists (
          select 1 from public.campaign_content_snapshots s
           where s.id = v_campaign.content_snapshot_id
             and s.template_id is not distinct from v_campaign.template_id
             and s.provider_automation_id is not distinct from v_campaign.provider_automation_id
        )) then
    update public.campaign_sends
       set status = 'pending', claim_token = null, lease_expires_at = null
     where id = p_send_id;
    return 'lost';
  end if;

  select * into v_contact from public.contacts where id = v_row.contact_id;
  v_reason := public.campaign_ineligibility(v_contact, v_campaign.consent_stream);

  if v_reason is not null then
    update public.campaign_sends
       set status = 'skipped', error = v_reason, claim_token = null,
           lease_expires_at = null, attempted_at = now()
     where id = p_send_id;
    return 'skipped';
  end if;

  update public.campaign_sends
     set provider_attempted_at = now(), revision = v_campaign.revision
   where id = p_send_id;

  return 'go';
end;
$$;

-- Existing approved Studio campaigns cannot exist yet; legacy approvals keep a null hash,
-- which matches their null snapshot.

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------
revoke all on function public.campaign_snapshot_hash(text, integer, uuid, text, text, text, text, jsonb, jsonb, text, text)
  from public, anon;
grant execute on function public.campaign_snapshot_hash(text, integer, uuid, text, text, text, text, jsonb, jsonb, text, text)
  to authenticated, service_role;
revoke all on function public.campaign_snapshot_assets(jsonb) from public, anon, authenticated;
grant execute on function public.campaign_snapshot_assets(jsonb) to service_role;
drop function if exists public.create_content_email_snapshot(text, text, uuid, uuid, text, text, text, jsonb, jsonb, text, text, text, uuid, text);
revoke all on function public.create_content_email_snapshot(text, text, uuid, uuid, text, text, text, jsonb, jsonb, text, text, text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_content_email_snapshot(text, text, uuid, uuid, text, text, text, jsonb, jsonb, text, text, text, uuid, text, uuid)
  to service_role;
revoke all on function public.freeze_used_template_contract() from public, anon;
revoke all on function public.stamp_campaign_run_content() from public, anon;
