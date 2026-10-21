-- Verification for 20261021000000_business_logic_fixes.sql.
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK.
--
-- Run with:  npm run db:verify -- auditfixes
--
-- What this guards, one block per finding of the 2026-10-21 business-logic audit:
--   B02  a failed campaign that reached anyone cannot change audience (a new run would
--        email them again); one nobody received still can
--   B03  archive/restore and opt-out/re-subscribe keep the contact's status, so a
--        customer keeps their services on the next save
--   B04  an email change hands the old address to the outbox, which is never
--        superseded and never claimed twice for one contact
--   B05  an archived Content Studio item is neither publishable nor dispatched
--   B06  a regeneration drops images archived since, instead of failing
--   B08  a deferral keeps the confirmation email queued without spending attempts;
--        the payment page claims its own booking's email
--   B09  an unsent campaign booking is expired, a used one never
--   B10  an identical re-import writes nothing and moves no revision
--   B13  uncertain recipients can be settled one by one

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000a0d01', 'operator__auditverify@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000a0d01', 'operator', true);

-- Ids handed between blocks that run as different roles.
create temporary table _audit_ids (k text primary key, id uuid) on commit drop;
grant all on _audit_ids to authenticated, service_role;

-- B02 places its fixture with replication triggers off, which needs the owner role.
do $$
declare
  v_seg1     uuid;
  v_seg2     uuid;
  v_a        uuid;
  v_b        uuid;
  v_campaign uuid;
  v_failed   boolean := false;
begin
  raise notice 'B02. a failed campaign that reached people keeps its audience';
  insert into public.segments (name) values ('S1 __auditverify') returning id into v_seg1;
  insert into public.segments (name) values ('S2 __auditverify') returning id into v_seg2;
  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
  values ('A', 'Audit', 'a__auditverify@example.invalid', true) returning id into v_a;
  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
  values ('B', 'Audit', 'b__auditverify@example.invalid', true) returning id into v_b;
  insert into public.campaigns (name, segment_id, merge_fields) values ('C __auditverify', v_seg1, '{}')
  returning id into v_campaign;

  set local session_replication_role = replica;   -- the fixture is a send that already failed
  update public.campaigns set status = 'failed', send_run = 1 where id = v_campaign;
  insert into public.campaign_sends (campaign_id, contact_id, run, status) values
    (v_campaign, v_a, 1, 'sent'), (v_campaign, v_b, 1, 'failed');
  set local session_replication_role = origin;

  begin
    update public.campaigns set segment_id = v_seg2 where id = v_campaign;
  exception when sqlstate 'CRM03' then v_failed := true;
  end;
  assert v_failed, 'a failed campaign that reached someone changed its audience';

  update public.campaigns set merge_fields = '{"Headline":"fixed"}' where id = v_campaign;
  assert (select status = 'draft' and send_run = 1 from public.campaigns where id = v_campaign),
         'a copy-only edit of a failed campaign must stay on its run';

  set local session_replication_role = replica;
  update public.campaign_sends set status = 'failed' where campaign_id = v_campaign;
  update public.campaigns set status = 'failed' where id = v_campaign;
  set local session_replication_role = origin;
  update public.campaigns set segment_id = v_seg2 where id = v_campaign;
  assert (select send_run from public.campaigns where id = v_campaign) = 2,
         'a failed campaign nobody received must still be able to change audience';
end $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;


do $$
declare
  v_service uuid;
  v_id      uuid;
  v_rev     integer;
begin
  raise notice 'B03. restoring a contact brings its status back';
  insert into public.services (name) values ('Service __auditverify') returning id into v_service;
  v_id := (public.save_contact(
    '{"email":"cust__auditverify@example.invalid","first_name":"C","last_name":"Audit","status":"customer","subscribed_to_newsletter":true,"subscribed_to_programs":false}'::jsonb,
    array[v_service], null) ->> 'id')::uuid;

  update public.contacts set deleted_at = now(), status = 'archived' where id = v_id;
  update public.contacts set deleted_at = null where id = v_id;
  assert (select status = 'customer' and is_customer and status_before_archive is null
            from public.contacts where id = v_id), 'a restored customer is no longer a customer';

  select revision into v_rev from public.contacts where id = v_id;
  perform public.save_contact(jsonb_build_object(
    'id', v_id, 'email', 'cust__auditverify@example.invalid', 'first_name', 'C', 'last_name', 'Audit',
    'status', (select status from public.contacts where id = v_id), 'mobile_number', '0400',
    'subscribed_to_newsletter', true, 'subscribed_to_programs', false), array[v_service], v_rev);
  assert (select count(*) from public.contact_services where contact_id = v_id) = 1,
         'the save after a restore unlinked the customer''s services';

  perform public.apply_contact_consent(v_id, false, false, 'preference_center', null);
  assert (select status = 'archived' from public.contacts where id = v_id), 'opting out did not archive';
  perform public.apply_contact_consent(v_id, true, null, 'preference_center', null);
  assert (select status = 'customer' and deleted_at is null from public.contacts where id = v_id),
         're-subscribing did not bring the customer back as a customer';
end $$;

do $$
declare
  v_id     uuid;
  v_claim  record;
  v_count  integer;
begin
  raise notice 'B04. an email change retires the old address';
  v_id := (public.save_contact(
    '{"email":"old__auditverify@example.invalid","first_name":"E","last_name":"Audit","status":"prospect","subscribed_to_newsletter":true,"subscribed_to_programs":false}'::jsonb,
    '{}', null) ->> 'id')::uuid;
  update public.consent_sync_outbox set status = 'done' where contact_id = v_id;

  update public.contacts set email = 'new__auditverify@example.invalid' where id = v_id;
  perform public.apply_contact_consent(v_id, false, null, 'preference_center', null);

  select count(*) into v_count from public.claim_consent_sync(50, v_id);
  assert v_count = 1, format('one contact must never be claimed twice at once, got %s', v_count);
  select * into v_claim from public.consent_sync_outbox where contact_id = v_id and status = 'processing';
  assert v_claim.previous_email = 'old__auditverify@example.invalid',
         'the oldest entry, carrying the old address, must be taken first';
  assert (select count(*) from public.consent_sync_outbox where contact_id = v_id and status = 'superseded'
            and previous_email is not null) = 0,
         'an entry that retires an old address was superseded';
end $$;

-- B05/B06 need a member (create/review) and the worker (claim/dispatch).
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000a0d01"}', true);
set local role authenticated;

do $$
declare
  v_brand   uuid;
  v_item    uuid;
  v_variant uuid;
  v_gone    uuid;
  v_keep    uuid;
  v_rev     uuid;
begin
  raise notice 'B05/B06 fixture';
  select id into v_brand from public.content_brand_profiles limit 1;
  set local role service_role;
  insert into public.content_items (brand_id, title, channels) values (v_brand, 'Post __auditverify', '{facebook}')
  returning id into v_item;
  insert into public.content_variants (item_id, channel) values (v_item, 'facebook') returning id into v_variant;
  insert into public.content_assets (brand_id, origin, ingest_status, storage_path, mime_type, byte_size, width, height, checksum)
  values (v_brand, 'upload', 'ready', 'library/auditverify-a/o.jpg', 'image/jpeg', 10, 10, 10, repeat('a', 64))
  returning id into v_gone;
  insert into public.content_assets (brand_id, origin, ingest_status, storage_path, mime_type, byte_size, width, height, checksum)
  values (v_brand, 'upload', 'ready', 'library/auditverify-b/o.jpg', 'image/jpeg', 10, 10, 10, repeat('b', 64))
  returning id into v_keep;
  set local role authenticated;

  v_rev := (public.create_content_revision(v_variant, null, jsonb_build_object(
    'body', 'Hi', 'assets', jsonb_build_array(
      jsonb_build_object('assetId', v_gone, 'alt', 'x'), jsonb_build_object('assetId', v_keep, 'alt', 'y'))),
    'key-auditverify-rev')).id;
  perform public.review_content_revision(v_rev, 'approved', null);
  update public.content_assets set archived_at = now() where id = v_gone;
  perform public.enqueue_content_job('generate_text', 'key-auditverify-job', v_item, v_variant, v_rev, null,
    '{"channels":["facebook"]}'::jsonb);

  insert into _audit_ids values ('item', v_item), ('variant', v_variant), ('keep', v_keep), ('brand', v_brand);
end $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_job    record;
  v_assets jsonb;
begin
  raise notice 'B06. a regeneration keeps only usable images';
  select * into v_job from public.claim_content_jobs('auditverify', array['generate_text'], 5, 120);
  assert public.begin_content_dispatch(v_job.job_id, v_job.claim_token) = 'go', 'generation was not dispatched';
  assert public.complete_content_job(v_job.job_id, v_job.claim_token,
           '{"variants":[{"channel":"facebook","body":"New copy"}]}'::jsonb),
         'the regeneration result was refused';
  select r.assets into v_assets
    from public.content_variants v join public.content_variant_revisions r on r.id = v.current_revision_id
   where v.id = (select id from _audit_ids where k = 'variant');
  assert jsonb_array_length(v_assets) = 1
     and v_assets -> 0 ->> 'assetId' = (select id from _audit_ids where k = 'keep')::text,
         format('expected only the usable image, got %s', v_assets);
end $$;

do $$
declare
  v_account uuid;
  v_copy    uuid;
begin
  insert into public.social_accounts (brand_id, platform, provider, external_id, display_name, author_kind)
  values ((select id from _audit_ids where k = 'brand'), 'facebook', 'mock', 'auditverify-1', 'Audit', 'page')
  returning id into v_account;
  insert into public.content_published_assets (asset_id, purpose, storage_path, public_url, checksum, mime_type, byte_size, width, height)
  values ((select id from _audit_ids where k = 'keep'), 'social', 'p/auditverify/' || repeat('b', 64) || '.jpg',
          'https://cdn.example.invalid/p/auditverify.jpg', repeat('b', 64), 'image/jpeg', 10, 10, 10)
  returning id into v_copy;
  insert into _audit_ids values ('account', v_account), ('copy', v_copy);
end $$;

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000a0d01"}', true);
set local role authenticated;

do $$
declare
  v_rev    uuid := (select current_revision_id from public.content_variants
                     where id = (select id from _audit_ids where k = 'variant'));
  v_failed boolean := false;
begin
  raise notice 'B05. an archived item is not published';
  perform public.review_content_revision(v_rev, 'approved', null);
  perform public.request_social_publication(v_rev, (select id from _audit_ids where k = 'account'),
    array[(select id from _audit_ids where k = 'copy')], 'key-auditverify-pub-1');
  update public.content_items set archived_at = now() where id = (select id from _audit_ids where k = 'item');

  begin
    perform public.request_social_publication(v_rev, (select id from _audit_ids where k = 'account'),
      array[(select id from _audit_ids where k = 'copy')], 'key-auditverify-pub-2');
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a publication was requested for an archived item';
end $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_job record;
begin
  select * into v_job from public.claim_content_jobs('auditverify', array['publish_social'], 5, 120);
  assert public.begin_content_dispatch(v_job.job_id, v_job.claim_token) = 'refused',
         'a queued publication of an archived item was dispatched';
  assert (select status = 'cancelled' and error_message = 'item_archived'
            from public.social_publications where job_id = v_job.job_id),
         'the refused publication is not cancelled with its reason';
end $$;

do $$
declare
  v_contact uuid;
  v_booking uuid;
  v_used    uuid;
  v_note    record;
  i         integer;
begin
  raise notice 'B08. a deferred confirmation stays queued';
  insert into public.contacts (first_name, last_name, email) values ('N', 'Audit', 'n__auditverify@example.invalid')
  returning id into v_contact;
  insert into public.bookings (token_hash, contact_id, status, expires_at)
  values (repeat('9', 64), v_contact, 'pending', now() + interval '20 days') returning id into v_booking;
  insert into public.notification_outbox (kind, dedupe_key, booking_id, stripe_session_id)
  values ('booking_paid_confirmation', 'auditverify-1', v_booking, 'cs_auditverify');

  for i in 1..10 loop
    update public.notification_outbox set next_attempt_at = now() - interval '1 second' where dedupe_key = 'auditverify-1';
    select * into v_note from public.claim_booking_notifications(v_booking);
    assert v_note.id is not null, 'the booking''s own email was not claimed';
    perform public.complete_notification(v_note.id, v_note.claim_token, 'deferred', 'email is not configured');
  end loop;
  assert (select status = 'pending' and attempts = 0 from public.notification_outbox where dedupe_key = 'auditverify-1'),
         'deferrals used up the email''s attempts';

  raise notice 'B09. an unsent booking is expired; a used one never';
  assert public.expire_unsent_campaign_booking(v_booking), 'the unsent booking was not expired';
  assert (select status = 'expired' and expires_at <= now() from public.bookings where id = v_booking),
         'the expired booking is still usable';
  insert into public.bookings (token_hash, contact_id, status, expires_at, consumed_at)
  values (repeat('8', 64), v_contact, 'pending', now() + interval '20 days', now()) returning id into v_used;
  assert not public.expire_unsent_campaign_booking(v_used), 'a link already used was expired';
end $$;

do $$
declare
  v_payload jsonb := '[{"email":"imp__auditverify@example.invalid","first_name":"I","last_name":"Audit","mobile_number":"0400","organisation_name":"Org __auditverify","tag_names":["VIP __auditverify"]}]';
  v_preview jsonb;
  v_result  jsonb;
  v_rev     integer;
begin
  raise notice 'B10. an identical re-import writes nothing';
  perform public.import_contacts(v_payload);
  select revision into v_rev from public.contacts where email = 'imp__auditverify@example.invalid';
  v_preview := public.preview_import_contacts(v_payload);
  assert (v_preview ->> 'changed')::int = 0 and (v_preview ->> 'unchanged')::int = 1,
         format('an identical row previewed as a change: %s', v_preview);
  v_result := public.import_contacts(v_payload, v_preview ->> 'token');
  assert (v_result ->> 'updated')::int = 1, format('a matched contact must still count as updated: %s', v_result);
  assert (select revision from public.contacts where email = 'imp__auditverify@example.invalid') = v_rev,
         'an identical re-import moved the revision';

  v_result := public.import_contacts(
    '[{"email":"imp__auditverify@example.invalid","first_name":"I","last_name":"Audit","tag_names":["New __auditverify"]}]');
  assert (select revision from public.contacts where email = 'imp__auditverify@example.invalid') = v_rev + 1,
         'a tag-only change must move the revision';
end $$;

do $$
declare
  v_seg      uuid;
  v_campaign uuid;
  v_c1       uuid;
  v_c2       uuid;
  v_s1       uuid;
  v_s2       uuid;
begin
  raise notice 'B13. uncertain recipients one by one';
  insert into public.segments (name) values ('S13 __auditverify') returning id into v_seg;
  insert into public.campaigns (name, segment_id, merge_fields) values ('C13 __auditverify', v_seg, '{}')
  returning id into v_campaign;
  insert into public.contacts (first_name, last_name, email) values ('U1', 'Audit', 'u1__auditverify@example.invalid')
  returning id into v_c1;
  insert into public.contacts (first_name, last_name, email) values ('U2', 'Audit', 'u2__auditverify@example.invalid')
  returning id into v_c2;
  insert into public.campaign_sends (campaign_id, contact_id, run, status, provider_attempted_at)
  values (v_campaign, v_c1, 1, 'uncertain', now()) returning id into v_s1;
  insert into public.campaign_sends (campaign_id, contact_id, run, status, provider_attempted_at)
  values (v_campaign, v_c2, 1, 'uncertain', now()) returning id into v_s2;

  assert public.resolve_uncertain_campaign_sends(v_campaign, 1, 'sent', array[v_s1]) = 1, 'one recipient was not settled';
  assert (select status from public.campaign_sends where id = v_s1) = 'sent', 'the named recipient is not sent';
  assert (select status from public.campaign_sends where id = v_s2) = 'uncertain', 'another recipient was settled too';
  assert public.resolve_uncertain_campaign_sends(v_campaign, 1, 'retry') = 1, 'without a list the rest are settled';
end $$;

rollback;
