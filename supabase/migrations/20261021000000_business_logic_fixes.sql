-- Business-logic audit fixes (2026-10-21). Each section names the finding it closes.
--
--   B02  a failed campaign that already reached people cannot change its audience
--   B03  archiving remembers the contact's status; restoring brings it back
--   B04  an email change unsubscribes the previous address at the provider
--   B05  an archived Content Studio item cannot be published
--   B06  a regeneration drops images that were archived since
--   B08  a confirmation email waiting for configuration does not use up its attempts;
--        the payment page can send its own booking's email
--   B09  a booking minted for an attempt that never reached the provider is expired
--   B10  an import only writes contacts it actually changes
--   B13  uncertain recipients can be settled one by one
--
-- Function bodies are the latest definitions with the changes marked "audit B..".


-- ---------------------------------------------------------------------------
-- B02. Changing the audience of a failed campaign started a new run that re-sent to
-- recipients already sent or uncertain in the previous one.
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
        -- audit B02: a new run materialises the whole new audience, so anyone the
        -- campaign already reached (sent, or uncertain: they may have it) would be
        -- emailed again. Only a campaign nobody has received may change audience.
        if exists (
          select 1 from public.campaign_sends s
           where s.campaign_id = old.id and s.status in ('sent', 'uncertain')
        ) then
          raise exception 'This campaign already reached some recipients, so its audience can no longer change: a new run would email them again. Retry the failed recipients, or create a new campaign for the other audience.'
            using errcode = 'CRM03', hint = 'audience_locked_after_delivery';
        end if;
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


-- ---------------------------------------------------------------------------
-- B03. Archive then restore (or opt out then re-subscribe) turned a customer into a
-- prospect; the next save then unlinked all their services.
-- ---------------------------------------------------------------------------
alter table public.contacts
    add column if not exists status_before_archive public.contact_status;

comment on column public.contacts.status_before_archive is
  'The status a contact had when it was archived; restored with it. Null while live.';

-- Contacts already archived keep null: their earlier status was never recorded.

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

    -- audit B03: remember what the contact was, so a restore can bring it back.
    if old.deleted_at is null and new.deleted_at is not null then
      new.status_before_archive := case when old.status <> 'archived'::public.contact_status
                                        then old.status end;
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
      -- audit B03: a restore returns the status the contact had (a customer stays a
      -- customer, keeping their services); prospect only when nothing was recorded.
      new.status := coalesce(
        case when tg_op = 'UPDATE' then old.status_before_archive end,
        'prospect'::public.contact_status);
    end if;
    new.archive_reason := null;
    new.status_before_archive := null;
  end if;

  new.is_customer := (new.status = 'customer'::public.contact_status);
  return new;
end;
$$;

-- active_contacts carries every column of contacts.
create or replace view public.active_contacts
with (security_invoker = on) as
select * from public.contacts where deleted_at is null;
revoke all on public.active_contacts from anon;


-- ---------------------------------------------------------------------------
-- B04. The outbox pushed only a contact's current address, so after an email change
-- the old address stayed subscribed at the provider and later withdrawals never
-- reached it.
-- ---------------------------------------------------------------------------
alter table public.consent_sync_outbox
    add column if not exists previous_email text;

comment on column public.consent_sync_outbox.previous_email is
  'The address the contact had before this change; the worker unsubscribes it at the provider.';

create or replace function public.enqueue_consent_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A contact with no consent is not on the provider list; nothing to push yet.
    if not (new.subscribed_to_newsletter or new.subscribed_to_programs) then
      return null;
    end if;
  elsif new.consent_version = old.consent_version then
    return null;
  end if;

  -- audit B04: the address the provider knew this contact by, when it changed.
  insert into public.consent_sync_outbox (contact_id, consent_version, source, previous_email)
  values (new.id, new.consent_version, nullif(current_setting('app.consent_source', true), ''),
          case when tg_op = 'UPDATE' and new.email is distinct from old.email
               then nullif(lower(btrim(old.email)), '') end)
  on conflict (contact_id, consent_version) do nothing;

  return null;
end;
$$;

drop function if exists public.claim_consent_sync(integer, uuid, integer);
create or replace function public.claim_consent_sync(
  p_limit         integer,
  p_contact_id    uuid default null,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id     uuid,
  claim_token   uuid,
  contact_id    uuid,
  state_version bigint,
  email         text,
  first_name    text,
  last_name     text,
  newsletter    boolean,
  programs      boolean,
  previous_email         text,
  previous_email_in_use  boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'claim_consent_sync: p_limit must be between 1 and 500';
  end if;

  -- Pushing current state again is idempotent, so an expired lease is simply retried.
  update public.consent_sync_outbox
     set status = 'pending', claim_token = null, lease_expires_at = null
   where status = 'processing' and lease_expires_at < now();

  -- Older pending entries of a contact are covered by its newest one.
  update public.consent_sync_outbox o
     set status = 'superseded', processed_at = now()
   where o.status = 'pending'
     -- audit B04: an entry that retires an old address is never covered by a newer
     -- one, which only knows the current address.
     and o.previous_email is null
     and exists (
       select 1 from public.consent_sync_outbox n
        where n.contact_id = o.contact_id
          and n.status in ('pending', 'processing')
          and n.consent_version > o.consent_version
     );

  return query
  with picked as (
    select o.id
      from public.consent_sync_outbox o
     where o.status = 'pending'
       and o.next_attempt_at <= now()
       and (p_contact_id is null or o.contact_id = p_contact_id)
       -- One contact in flight at a time, so pushes cannot land out of order.
       and not exists (
         select 1 from public.consent_sync_outbox p
          where p.contact_id = o.contact_id and p.status = 'processing'
       )
       -- audit B04: entries that retire an old address are no longer superseded, so a
       -- contact can have several pending; only its oldest is taken, never two at once.
       and not exists (
         select 1 from public.consent_sync_outbox e
          where e.contact_id = o.contact_id and e.status = 'pending'
            and e.consent_version < o.consent_version
       )
     order by o.next_attempt_at, o.created_at
     limit p_limit
     for update skip locked
  ), claimed as (
    update public.consent_sync_outbox o
       set status = 'processing',
           claim_token = v_token,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           attempts = o.attempts + 1
      from picked
     where o.id = picked.id
    returning o.id, o.contact_id, o.previous_email
  )
  select claimed.id, v_token, c.id, c.consent_version, c.email, c.first_name, c.last_name,
         c.subscribed_to_newsletter, c.subscribed_to_programs,
         claimed.previous_email,
         -- Another live contact with consent now owns that address: leave it subscribed.
         claimed.previous_email is not null and exists (
           select 1 from public.contacts x
            where lower(btrim(x.email)) = claimed.previous_email
              and x.id <> c.id and x.deleted_at is null
              and (x.subscribed_to_newsletter or x.subscribed_to_programs))
    from claimed
    join public.contacts c on c.id = claimed.contact_id;
end;
$$;

create or replace function public.complete_consent_sync(
  p_outbox_id     uuid,
  p_token         uuid,
  p_state_version bigint,
  p_ok            boolean,
  p_error         text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.consent_sync_outbox;
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  select * into v_row from public.consent_sync_outbox
   where id = p_outbox_id and claim_token = p_token and status = 'processing'
   for update;

  if not found then
    return false;
  end if;

  if p_ok then
    update public.consent_sync_outbox
       set status = 'done', processed_at = now(), claim_token = null,
           lease_expires_at = null, last_error = null
     where id = p_outbox_id;

    update public.consent_sync_outbox
       set status = 'superseded', processed_at = now()
     where contact_id = v_row.contact_id
       and status = 'pending'
       and previous_email is null  -- audit B04
       and consent_version <= p_state_version;
  else
    update public.consent_sync_outbox
       set status = case when v_row.attempts >= 8 then 'failed' else 'pending' end,
           next_attempt_at = now() + least(interval '6 hours', make_interval(mins => power(2, v_row.attempts)::integer)),
           claim_token = null,
           lease_expires_at = null,
           last_error = left(coalesce(p_error, 'unknown error'), 500)
     where id = p_outbox_id;
  end if;

  return true;
end;
$$;

revoke all on function public.claim_consent_sync(integer, uuid, integer) from public, anon;
grant execute on function public.claim_consent_sync(integer, uuid, integer) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- B05. Archiving a Content Studio item did not stop its queued publication, and a new
-- publication could still be requested for it (request_social_publication relies on
-- content_revision_is_approved, so it is covered by the same change).
-- B06. Regenerating a variant whose image had been archived failed at completion,
-- after the model call, and the job ended 'uncertain'.
-- ---------------------------------------------------------------------------
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
      -- audit B05: archiving the whole post withdraws its approval too.
      join public.content_items i on i.id = v.item_id and i.archived_at is null
     where r.id = p_revision_id
       and v.archived_at is null
       and (select decision from public.content_reviews cr
             where cr.revision_id = r.id order by cr.created_at desc, cr.id desc limit 1) = 'approved'
  );
end;
$$;

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
    -- audit B05: the operator archived the post after asking for it to be published.
    elsif exists (select 1 from public.content_items where id = v_job.item_id and archived_at is not null) then
      v_reason := 'item_archived';
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
       set status = case when v_reason in ('cancelled', 'item_archived') then 'cancelled' else 'failed' end,
           error_code = 'dispatch_refused', error_message = v_reason,
           claim_token = null, lease_expires_at = null, finished_at = now()
     where id = p_job_id;
    if v_job.publication_id is not null then
      update public.social_publications
         set status = case when v_reason in ('cancelled', 'item_archived') then 'cancelled' else 'failed' end,
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
                   -- A regeneration keeps the images the operator had chosen -- those still
                   -- usable (audit B06): one archived since would make the whole result
                   -- unsavable after the model call had already been paid for.
                   v_content || jsonb_build_object('assets', coalesce(
                     (select jsonb_agg(e order by t.ord)
                        from public.content_variant_revisions r
                        cross join lateral jsonb_array_elements(r.assets) with ordinality as t(e, ord)
                        join public.content_assets a on a.id = (t.e ->> 'assetId')::uuid
                       where r.id = v_job.base_revision_id
                         and a.ingest_status = 'ready' and a.archived_at is null),
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


-- ---------------------------------------------------------------------------
-- B08. With email not configured, every run spent an attempt and the confirmation was
-- 'failed' after eight, though docs/WEBHOOKS.md promises it stays queued. The inline
-- send on the payment page also took the oldest queued email, not this booking's.
-- ---------------------------------------------------------------------------
create or replace function public.complete_notification(
  p_id     uuid,
  p_token  uuid,
  p_status text,
  p_error  text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  -- audit B08: 'deferred' = nothing was attempted (email or Stripe not configured).
  if p_status not in ('sent', 'skipped', 'retry', 'deferred') then
    raise exception 'complete_notification: invalid status %', p_status;
  end if;

  select attempts into v_attempts from public.notification_outbox
   where id = p_id and claim_token = p_token and status = 'processing'
   for update;
  if not found then return false; end if;

  update public.notification_outbox
     set status = case
                    when p_status = 'deferred' then 'pending'
                    when p_status = 'retry' and v_attempts >= 8 then 'failed'
                    when p_status = 'retry' then 'pending'
                    else p_status end,
         -- A deferral gives back the attempt the claim took.
         attempts = case when p_status = 'deferred' then greatest(0, attempts - 1) else attempts end,
         sent_at = case when p_status = 'sent' then now() else sent_at end,
         next_attempt_at = case when p_status = 'deferred' then now() + interval '1 hour'
                                else now() + least(interval '6 hours', make_interval(mins => power(2, v_attempts)::integer)) end,
         last_error = left(p_error, 500),
         claim_token = null,
         lease_expires_at = null
   where id = p_id;
  return true;
end;
$$;

create or replace function public.claim_booking_notifications(p_booking_id uuid, p_lease_seconds integer default 120)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
begin

  return query
  with picked as (
    select id from public.notification_outbox
     -- audit B08: the payment page sends its own booking's email, not the oldest one.
     where status = 'pending' and next_attempt_at <= now() and booking_id = p_booking_id
     order by next_attempt_at
     limit 1
     for update skip locked
  )
  update public.notification_outbox n
     set status = 'processing', claim_token = v_token, attempts = n.attempts + 1,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    from picked
   where n.id = picked.id
  returning n.*;
end;
$$;

revoke all on function public.claim_booking_notifications(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_booking_notifications(uuid, integer) to service_role;


-- ---------------------------------------------------------------------------
-- B09. A booking is minted for a recipient before the provider is called. When that
-- attempt then stops short (rate limited, skipped, refused, lost), nobody ever received
-- the link: it is expired instead of standing as a 'pending' booking. Never deleted.
-- ---------------------------------------------------------------------------
create or replace function public.expire_unsent_campaign_booking(p_booking_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_crm_member() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  update public.bookings
     set status = 'expired', expires_at = now(), updated_at = now()
   where id = p_booking_id
     and status = 'pending'
     and consumed_at is null
     and stripe_session_id is null;

  return found;
end;
$$;

revoke all on function public.expire_unsent_campaign_booking(uuid) from public, anon;
grant execute on function public.expire_unsent_campaign_booking(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- B10. An identical re-import showed "unchanged" in the preview but rewrote every
-- matched contact, moving its revision; the preview counted any non-blank cell as a
-- change, even one equal to what the contact held.
-- ---------------------------------------------------------------------------
create or replace function public.preview_import_contacts(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total    integer := coalesce(jsonb_array_length(payload), 0);
  v_usable   integer;
  v_distinct integer;
  v_has_tags boolean;
  v_over     text;
  v_result   jsonb;
begin
  v_distinct := public._stage_import_rows(payload);
  v_usable := public._count_usable_import_rows(payload);
  v_has_tags := exists (select 1 from _import_row_tags);

  if v_has_tags then
    v_over := public._import_tag_limit_violation();
    if v_over is not null then
      raise exception 'A contact can have at most 50 tags; % would have more.', v_over
        using errcode = 'CRM07', hint = 'tag_limit';
    end if;
  end if;

  with matched as (
    select i.*, c.id as contact_id, c.status as current_status,
           c.subscribed_to_newsletter as current_newsletter,
           c.subscribed_to_programs as current_programs,
           c.first_name as current_first_name, c.last_name as current_last_name,
           to_jsonb(c) as current_row,
           (c.id is not null) as exists_live,
           exists (select 1 from public.contacts a
                    where a.email = i.email and a.deleted_at is not null and a.removed_at is null)
             and c.id is null as archived_collision,
           -- A tag in the row that the contact (if any) does not have yet.
           exists (select 1 from _import_row_tags t
                    where t.email = i.email
                      and (c.id is null or not exists (
                            select 1 from public.contact_tags ct
                              join public.tags g on g.id = ct.tag_id
                             where ct.contact_id = c.id and lower(btrim(g.name)) = t.tag_key))) as has_new_tags
      from _import_rows i
      left join public.contacts c on c.email = i.email and c.deleted_at is null
  ), compared as (
    select m.*,
      (m.is_customer is true and m.current_status <> 'customer')
        or (m.is_customer is false and m.current_status = 'customer')
        or (m.subscribed_to_newsletter is false and m.current_newsletter)
        or (m.subscribed_to_programs is false and m.current_programs)
        or (m.first_name is distinct from m.current_first_name)
        or (m.last_name is distinct from m.current_last_name)
        -- audit B10: a value equal to what the contact holds is not a change, exactly as
        -- import_contacts() now decides (it skips such rows).
        or (m.preferred_name is not null and m.preferred_name is distinct from m.current_row ->> 'preferred_name')
        or (m.mobile_number is not null and m.mobile_number is distinct from m.current_row ->> 'mobile_number')
        or (m.work_phone is not null and m.work_phone is distinct from m.current_row ->> 'work_phone')
        or (m.address is not null and m.address is distinct from m.current_row ->> 'address')
        or (m.suburb is not null and m.suburb is distinct from m.current_row ->> 'suburb')
        or (m.state is not null and m.state is distinct from m.current_row ->> 'state')
        or (m.postcode is not null and m.postcode is distinct from m.current_row ->> 'postcode')
        or (m.country is not null and m.country is distinct from m.current_row ->> 'country')
        or (m.department is not null and m.department is distinct from m.current_row ->> 'department')
        or (m."position" is not null and m."position" is distinct from m.current_row ->> 'position')
        or (m.organisation_name is not null and not exists (
              select 1 from public.organisations o
               where o.id = (m.current_row ->> 'organisation_id')::uuid
                 and lower(btrim(o.name)) = lower(m.organisation_name)))
        or (m.job_type_name is not null and not exists (
              select 1 from public.job_types jt
               where jt.id = (m.current_row ->> 'job_type_id')::uuid
                 and lower(btrim(jt.name)) = lower(m.job_type_name)))
        as fields_changed
    from matched m
  ), classified as (
    select c.*,
      case
        when c.archived_collision then 'held_back'
        when not c.exists_live then 'new'
        when c.fields_changed or c.has_new_tags then 'changed'
        else 'unchanged'
      end as outcome
    from compared c
  )
  select jsonb_build_object(
    'total', v_total,
    'rejected', v_total - v_usable,
    'duplicates', v_usable - v_distinct,
    'new', count(*) filter (where outcome = 'new'),
    'changed', count(*) filter (where outcome = 'changed'),
    'unchanged', count(*) filter (where outcome = 'unchanged'),
    'held_back', count(*) filter (where outcome = 'held_back'),
    'becoming_customers', count(*) filter (where exists_live and is_customer is true and current_status <> 'customer'),
    'leaving_customers', count(*) filter (where exists_live and is_customer is false and current_status = 'customer'),
    'withdrawing_newsletter', count(*) filter (where exists_live and subscribed_to_newsletter is false and current_newsletter),
    'withdrawing_programs', count(*) filter (where exists_live and subscribed_to_programs is false and current_programs),
    'customer_column_present', bool_or(is_customer is not null),
    'samples', coalesce((
      select jsonb_agg(sample) from (
        select jsonb_build_object(
          'email', email,
          'outcome', outcome,
          'status', case
            when not exists_live then (case when is_customer then 'customer' else 'prospect' end)
            when is_customer is true then 'customer'
            when is_customer is false and current_status = 'customer' then 'prospect'
            else current_status::text end,
          'previous_status', case when exists_live then current_status::text end,
          'newsletter', case when exists_live then (current_newsletter and coalesce(subscribed_to_newsletter, true))
                             else coalesce(subscribed_to_newsletter, true) end,
          'previous_newsletter', case when exists_live then current_newsletter end
        ) as sample
        from classified
        where outcome in ('new', 'changed', 'held_back')
        order by outcome, email
        limit 20
      ) s
    ), '[]'::jsonb),
    'token', public._import_match_token()
  ) || case when not v_has_tags then '{}'::jsonb else jsonb_build_object(
    'tags_only_changed', count(*) filter (where outcome = 'changed' and not fields_changed),
    'tags_assigned', count(*) filter (where outcome in ('new', 'changed') and has_new_tags),
    'tags_created', coalesce((
      select jsonb_agg(n.name order by n.tag_key)
        from (
          select distinct on (t.tag_key) t.tag_key, t.name
            from _import_row_tags t
            join _import_rows i on i.email = t.email
           -- Held-back rows are not imported, so their tags would not be created.
           where not (exists (select 1 from public.contacts a
                               where a.email = i.email and a.deleted_at is not null and a.removed_at is null)
                      and not exists (select 1 from public.contacts l
                                       where l.email = i.email and l.deleted_at is null))
             and not exists (select 1 from public.tags g where lower(btrim(g.name)) = t.tag_key)
           order by t.tag_key, t.email, t.ord
        ) n
    ), '[]'::jsonb)
  ) end
  into v_result
  from classified;

  return v_result;
end;
$$;

create or replace function public.import_contacts(payload jsonb, p_preview_token text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inserted      int := 0;
  v_updated       int := 0;
  v_total         int := coalesce(jsonb_array_length(payload), 0);
  v_usable        int := 0;
  v_distinct      int := 0;
  v_collisions    int := 0;
  v_has_tags      boolean := false;
  v_tags_created  int := 0;
  v_tags_assigned int := 0;
  v_updated_ids   uuid[] := '{}';
  v_inserted_ids  uuid[] := '{}';
  v_tagged_ids    uuid[] := '{}';
  v_result        jsonb;
begin
  v_distinct := public._stage_import_rows(payload);
  v_usable := public._count_usable_import_rows(payload);

  if v_distinct = 0 then
    return jsonb_build_object(
      'inserted', 0, 'updated', 0, 'skipped', v_total,
      'archived_collisions', 0, 'duplicates', 0, 'total', v_total
    );
  end if;

  -- Revalidate against the preview the operator approved (P3).
  if p_preview_token is not null and p_preview_token <> public._import_match_token() then
    raise exception 'Some of these contacts changed after the preview. Preview the import again.'
      using errcode = 'CRM08';
  end if;

  perform set_config('app.consent_source', 'import', true);

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

  -- Held-back rows keep no tags either.
  delete from _import_row_tags t
   where not exists (select 1 from _import_rows i where i.email = t.email);
  v_has_tags := exists (select 1 from _import_row_tags);

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
      subscribed_to_newsletter, subscribed_to_programs, source
    )
    select
      i.email, i.first_name, i.last_name, i.preferred_name, i.mobile_number, i.work_phone,
      i.address, i.suburb, i.state, i.postcode, i.country, i.department, i."position",
      o.id, jt.id,
      -- Defaults apply to NEW contacts only; ON CONFLICT below reads the raw value.
      coalesce(i.is_customer, false),
      case when coalesce(i.is_customer, false) then 'customer'::public.contact_status
           else 'prospect'::public.contact_status end,
      coalesce(i.subscribed_to_newsletter, true) and coalesce(removed.subscribed_to_newsletter, true),
      coalesce(i.subscribed_to_programs, true)   and coalesce(removed.subscribed_to_programs, true),
      'import'
    from _import_rows i
    left join public.organisations o
      on lower(btrim(o.name)) = lower(i.organisation_name)
    left join public.job_types jt
      on lower(btrim(jt.name)) = lower(i.job_type_name)
    left join lateral (
      select c.subscribed_to_newsletter, c.subscribed_to_programs
      from public.contacts c
      where c.email = i.email
        and c.removed_at is not null
        and not exists (
          select 1 from public.contacts live
          where live.email = i.email and live.deleted_at is null
        )
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
      -- `excluded` holds the defaulted insert value, so the spreadsheet's own answer is
      -- read from the staged row: null keeps the contact's status (H9).
      is_customer = coalesce(
        (select s.is_customer from _import_rows s where s.email = excluded.email),
        public.contacts.is_customer),
      status = case (select s.is_customer from _import_rows s where s.email = excluded.email)
        when true then 'customer'::public.contact_status
        when false then case when public.contacts.status = 'customer'
                             then 'prospect'::public.contact_status
                             else public.contacts.status end
        else public.contacts.status
      end,
      subscribed_to_newsletter = public.contacts.subscribed_to_newsletter
                                 and excluded.subscribed_to_newsletter,
      subscribed_to_programs   = public.contacts.subscribed_to_programs
                                 and excluded.subscribed_to_programs
    -- audit B10: only a contact the file actually changes is written. Every update
    -- moves contacts.revision, so rewriting unchanged rows refused the next save of
    -- anyone who had that contact open. Rows that match nothing are still locked by
    -- ON CONFLICT DO UPDATE, which the tag limit below relies on.
    where (public.contacts.first_name, public.contacts.last_name, public.contacts.preferred_name,
           public.contacts.mobile_number, public.contacts.work_phone, public.contacts.address,
           public.contacts.suburb, public.contacts.state, public.contacts.postcode,
           public.contacts.country, public.contacts.department, public.contacts."position",
           public.contacts.organisation_id, public.contacts.job_type_id, public.contacts.is_customer,
           public.contacts.status, public.contacts.subscribed_to_newsletter,
           public.contacts.subscribed_to_programs)
      is distinct from
          (coalesce(excluded.first_name, public.contacts.first_name),
           coalesce(excluded.last_name, public.contacts.last_name),
           coalesce(excluded.preferred_name, public.contacts.preferred_name),
           coalesce(excluded.mobile_number, public.contacts.mobile_number),
           coalesce(excluded.work_phone, public.contacts.work_phone),
           coalesce(excluded.address, public.contacts.address),
           coalesce(excluded.suburb, public.contacts.suburb),
           coalesce(excluded.state, public.contacts.state),
           coalesce(excluded.postcode, public.contacts.postcode),
           coalesce(excluded.country, public.contacts.country),
           coalesce(excluded.department, public.contacts.department),
           coalesce(excluded."position", public.contacts."position"),
           coalesce(excluded.organisation_id, public.contacts.organisation_id),
           coalesce(excluded.job_type_id, public.contacts.job_type_id),
           coalesce((select s.is_customer from _import_rows s where s.email = excluded.email),
                    public.contacts.is_customer),
           case (select s.is_customer from _import_rows s where s.email = excluded.email)
             when true then 'customer'::public.contact_status
             when false then case when public.contacts.status = 'customer'
                                  then 'prospect'::public.contact_status
                                  else public.contacts.status end
             else public.contacts.status
           end,
           public.contacts.subscribed_to_newsletter and excluded.subscribed_to_newsletter,
           public.contacts.subscribed_to_programs and excluded.subscribed_to_programs)
    returning id, (xmax = 0) as was_inserted
  )
  select
    coalesce(array_agg(id) filter (where was_inserted), '{}'),
    coalesce(array_agg(id) filter (where not was_inserted), '{}')
  into v_inserted_ids, v_updated_ids
  from upserted;
  v_inserted := cardinality(v_inserted_ids);

  perform set_config('app.consent_source', '', true);

  -- Tags: add only. Every staged contact now exists and is locked by the upsert above,
  -- which the 50-tag trigger on contact_tags relies on.
  if v_has_tags then
    with created as (
      insert into public.tags (name)
      select distinct on (tag_key) name
        from _import_row_tags
       order by tag_key, email, ord
      on conflict ((lower(btrim(name)))) do nothing
      returning 1
    )
    select count(*) into v_tags_created from created;

    with assigned as (
      insert into public.contact_tags (contact_id, tag_id)
      select c.id, g.id
        from _import_row_tags t
        join public.contacts c on c.email = t.email and c.deleted_at is null
        join public.tags g on lower(btrim(g.name)) = t.tag_key
      on conflict do nothing
      returning contact_id
    )
    select count(distinct contact_id), coalesce(array_agg(distinct contact_id), '{}')
      into v_tags_assigned, v_tagged_ids
      from assigned;

    -- A contact whose only change is a new tag was not written above; its revision
    -- moves here, as apply_contact_tags does (a no-op SET still fires contacts_revision).
    update public.contacts set revision = revision
     where id = any (v_tagged_ids)
       and not (id = any (v_updated_ids))
       and not (id = any (v_inserted_ids));
  end if;

  -- 'updated' keeps its meaning: existing contacts the file matched (the upsert no longer
  -- returns the ones it left as they were, so they are counted here).
  select count(*) into v_updated
    from _import_rows i
    join public.contacts c on c.email = i.email and c.deleted_at is null
   where not (c.id = any (v_inserted_ids));

  v_result := jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated,
    'skipped',  v_total - v_usable,
    'duplicates', v_usable - v_distinct,
    'archived_collisions', v_collisions,
    'total',    v_total
  );

  if v_has_tags then
    v_result := v_result || jsonb_build_object(
      'tags_assigned', v_tags_assigned,
      'tags_created', v_tags_created
    );
  end if;

  return v_result;
end;
$$;


-- ---------------------------------------------------------------------------
-- B13. Uncertain recipients could only be settled all at once, forcing a wrong record
-- when some had received the email and some had not.
-- ---------------------------------------------------------------------------
drop function if exists public.resolve_uncertain_campaign_sends(uuid, integer, text);
create or replace function public.resolve_uncertain_campaign_sends(
  p_campaign_id uuid,
  p_run         integer,
  p_resolution  text,
  p_send_ids    uuid[] default null
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_resolution not in ('sent', 'retry') then
    raise exception 'resolve_uncertain_campaign_sends: resolution must be sent or retry';
  end if;

  update public.campaign_sends
     set status = case when p_resolution = 'sent' then 'sent' else 'pending' end,
         error = case when p_resolution = 'sent' then null
                      else 'Re-queued by an operator after checking the provider.' end,
         provider_attempted_at = case when p_resolution = 'sent' then provider_attempted_at else null end,
         claim_token = null,
         lease_expires_at = null
   where campaign_id = p_campaign_id
     and run = p_run
     and status = 'uncertain'
     -- audit B13: null settles every uncertain recipient of the run; a list settles
     -- only those, so mixed outcomes can each be recorded truthfully.
     and (p_send_ids is null or id = any (p_send_ids));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.resolve_uncertain_campaign_sends(uuid, integer, text, uuid[]) from public, anon;
grant execute on function public.resolve_uncertain_campaign_sends(uuid, integer, text, uuid[]) to authenticated, service_role;
