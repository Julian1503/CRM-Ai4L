-- Verification for 20261007000000_content_studio.sql (Content Studio).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__contentverify`. now() is fixed for the whole transaction, so a lease only
-- "expires" where this script moves it into the past on purpose.
--
-- Run with:  npm run db:verify -- content
--
-- What this guards: members only; secrets and OAuth state invisible to browser roles;
-- revisions/reviews/audit immutable; an edit voids approval and a stale edit is refused;
-- only the current revision can be reviewed; the worker protocol honours leases (two
-- claims never share a job, a stale worker cannot complete, expiry before dispatch
-- requeues and after dispatch becomes uncertain); a late regeneration never overwrites
-- a newer edit; a publication is refused at dispatch once its revision changed, a
-- retried public call becomes uncertain, and one revision cannot be live twice on the
-- same account; asset files must stay inside the prefix the CRM assigned.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c0b01', 'operator__contentverify@example.invalid'),
  ('00000000-0000-4000-8000-0000000c0c01', 'unapproved__contentverify@example.invalid');

insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000c0b01', 'operator', true);

insert into public.social_accounts (id, brand_id, platform, provider, external_id, display_name, author_kind)
select '00000000-0000-4000-8000-0000000c0a01', id, 'facebook', 'mock', 'page__contentverify', 'Page', 'page'
  from public.content_brand_profiles where slug = 'ai4l';
insert into public.social_account_secrets (account_id, access_token, key_version)
values ('00000000-0000-4000-8000-0000000c0a01', 'v1:x:y:z', 1);

----------------------------------------------------------------------------
-- 1. Schema, privileges, Storage
----------------------------------------------------------------------------
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
    assert (select relrowsecurity from pg_class where oid = ('public.' || v_table)::regclass),
           format('%s has no RLS', v_table);
    assert exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table
                    and policyname = 'Approved CRM members only' and permissive = 'RESTRICTIVE'),
           format('%s lacks the restrictive membership policy', v_table);
    assert not has_table_privilege('anon', 'public.' || v_table, 'select'), format('anon can read %s', v_table);
    assert not has_table_privilege('authenticated', 'public.' || v_table, 'delete'),
           format('%s can be physically deleted', v_table);
  end loop;

  assert not has_table_privilege('authenticated', 'public.social_account_secrets', 'select'),
         'members can read social secrets';
  assert not has_table_privilege('authenticated', 'public.social_oauth_states', 'select'),
         'members can read OAuth state';
  assert not has_table_privilege('authenticated', 'public.content_variant_revisions', 'insert'),
         'members can insert revisions directly, bypassing the stale check';
  assert not has_table_privilege('authenticated', 'public.content_jobs', 'update'),
         'members can update jobs directly';

  assert not has_function_privilege('authenticated', 'public.claim_content_jobs(text, text[], integer, integer)', 'execute'),
         'members can claim worker jobs';
  assert not has_function_privilege('authenticated', 'public.complete_content_job(uuid, uuid, jsonb)', 'execute'),
         'members can complete worker jobs';
  assert not has_function_privilege('anon', 'public.enqueue_content_job(text, text, uuid, uuid, uuid, uuid, jsonb)', 'execute'),
         'anon can enqueue jobs';
  assert has_function_privilege('authenticated', 'public.review_content_revision(uuid, text, text)', 'execute'),
         'members cannot review';

  assert (select public from storage.buckets where id = 'content-public'), 'content-public is not public';
  assert not (select public from storage.buckets where id = 'content-library'), 'content-library is public';
  assert not (select public from storage.buckets where id = 'content-quarantine'), 'content-quarantine is public';
  assert not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                      and (qual ilike '%content-%' or with_check ilike '%content-%')),
         'a storage.objects policy exposes content buckets to browser roles';
end $$;

----------------------------------------------------------------------------
-- 2. Authenticated but never approved
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000c0c01","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_failed boolean := false;
begin
  assert (select count(*) from public.content_brand_profiles) = 0, 'an unapproved user read brand profiles';
  assert (select count(*) from public.social_accounts) = 0, 'an unapproved user read social accounts';

  begin
    perform public.enqueue_content_job('generate_text', 'unapproved-key-1', gen_random_uuid());
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'an unapproved user enqueued a job';
end $$;
reset role;

----------------------------------------------------------------------------
-- 3. Operator creates an item and queues a generation (idempotent)
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_item uuid;
  v_job1 public.content_jobs;
  v_job2 public.content_jobs;
begin
  raise notice '3.1 item + idempotent enqueue';
  insert into public.content_items (brand_id, title, brief, channels, created_by)
  select id, 'Launch __contentverify', '{"topic":"launch"}', array['facebook', 'linkedin'],
         '00000000-0000-4000-8000-0000000c0b01'
    from public.content_brand_profiles where slug = 'ai4l'
  returning id into v_item;

  v_job1 := public.enqueue_content_job('generate_text', 'gen__contentverify-1', v_item, null, null, null,
              '{"channels":["facebook","linkedin"],"stylesPerChannel":1}');
  v_job2 := public.enqueue_content_job('generate_text', 'gen__contentverify-1', v_item, null, null, null,
              '{"channels":["facebook","linkedin"],"stylesPerChannel":1}');
  assert v_job1.id = v_job2.id, 'a repeated enqueue created a second job';
  assert v_job1.status = 'queued', 'new job is not queued';
end $$;
reset role;

----------------------------------------------------------------------------
-- 4. Worker protocol: claim, stale worker, begin-dispatch, complete
----------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare
  v_job    uuid := (select id from public.content_jobs where idempotency_key = 'gen__contentverify-1');
  v_token  uuid;
  v_other  integer;
  v_failed boolean := false;
begin
  raise notice '4.1 one claim per job';
  select c.claim_token into v_token
    from public.claim_content_jobs('worker-a', array['generate_text'], 20, 120) c where c.job_id = v_job;
  assert v_token is not null, 'the queued job was not claimed';
  select count(*) into v_other
    from public.claim_content_jobs('worker-b', array['generate_text'], 20, 120) c where c.job_id = v_job;
  assert v_other = 0, 'a second worker claimed a running job';

  raise notice '4.2 heartbeat and stale token';
  assert public.heartbeat_content_job(v_job, v_token, 120) = 'ok', 'heartbeat of the owner failed';
  assert public.heartbeat_content_job(v_job, gen_random_uuid(), 120) = 'lost', 'a stranger heartbeat succeeded';
  assert not public.complete_content_job(v_job, gen_random_uuid(), '{"variants":[]}'), 'a stale worker completed';

  raise notice '4.3 generation must begin-dispatch before completing';
  begin
    perform public.complete_content_job(v_job, v_token,
      '{"variants":[{"channel":"facebook","style":"a","body":"x","hashtags":[]}]}');
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a generation completed without begin-dispatch';

  assert public.begin_content_dispatch(v_job, v_token) = 'go', 'begin-dispatch refused a valid generation';

  raise notice '4.4 unrequested channel refused';
  v_failed := false;
  begin
    perform public.complete_content_job(v_job, v_token,
      '{"variants":[{"channel":"instagram","style":"a","body":"x","hashtags":[]}]}');
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed, 'a result for an unrequested channel was stored';

  assert public.complete_content_job(v_job, v_token, jsonb_build_object(
    'promptVersion', 'p1', 'model', 'mock', 'failures', '[]'::jsonb,
    'variants', jsonb_build_array(
      jsonb_build_object('channel', 'facebook', 'style', 'a', 'body', 'Hello', 'hashtags', jsonb_build_array('#AI', 'news'),
                         'callToAction', 'Learn more', 'violations', '[]'::jsonb),
      jsonb_build_object('channel', 'linkedin', 'style', 'a', 'body', 'Hello LI', 'hashtags', '[]'::jsonb,
                         'callToAction', null, 'violations', '[]'::jsonb)))), 'the owner could not complete';
  assert (select status from public.content_jobs where id = v_job) = 'succeeded', 'job not succeeded';
  assert not public.complete_content_job(v_job, v_token, '{"variants":[]}'), 'a finished job completed twice';
  assert (select count(*) from public.content_variants v join public.content_items i on i.id = v.item_id
           where i.title = 'Launch __contentverify') = 2, 'generation did not create two variants';
  assert (select hashtags from public.content_variant_revisions r join public.content_variants v on v.id = r.variant_id
           where v.channel = 'facebook' and r.job_id = v_job) = array['AI', 'news'], 'hashtags were not normalised';
end $$;
reset role;

----------------------------------------------------------------------------
-- 5. Editorial rules: stale edit, review of current only, edit voids approval
----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_variant public.content_variants;
  v_r1      uuid;
  v_r2      public.content_variant_revisions;
  v_again   public.content_variant_revisions;
  v_r3      public.content_variant_revisions;
  v_failed  boolean := false;
  v_hint    text;
begin
  select v.* into v_variant from public.content_variants v join public.content_items i on i.id = v.item_id
   where i.title = 'Launch __contentverify' and v.channel = 'facebook';
  v_r1 := v_variant.current_revision_id;

  raise notice '5.1 stale edit refused';
  begin
    perform public.create_content_revision(v_variant.id, gen_random_uuid(), '{"body":"x"}', 'edit__contentverify-0');
  exception when sqlstate 'CRM06' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'stale_revision', 'an edit from a stale revision was accepted';

  raise notice '5.2 edit is idempotent and becomes current';
  v_r2 := public.create_content_revision(v_variant.id, v_r1, '{"body":"Edited","hashtags":["AI"]}', 'edit__contentverify-1');
  v_again := public.create_content_revision(v_variant.id, v_r1, '{"body":"Edited","hashtags":["AI"]}', 'edit__contentverify-1');
  assert v_r2.id = v_again.id, 'a retried save created a second revision';
  assert v_r2.revision_number = 2 and v_r2.parent_revision_id = v_r1, 'revision numbering or parent is wrong';
  assert v_r2.checksum = public.content_revision_checksum('Edited', array['AI'], null, null, '{}', '[]'),
         'checksum does not match the canonical content';

  raise notice '5.3 only the current revision can be reviewed';
  v_failed := false;
  begin
    perform public.review_content_revision(v_r1, 'approved');
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a superseded revision was approved';

  v_failed := false;
  begin
    perform public.review_content_revision(v_r2.id, 'rejected', '  ');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a rejection without a reason was accepted';

  perform public.review_content_revision(v_r2.id, 'approved');
  assert public.content_revision_is_approved(v_r2.id), 'approved revision is not approved';

  raise notice '5.4 an edit voids the approval';
  v_r3 := public.create_content_revision(v_variant.id, v_r2.id, '{"body":"Edited again"}', 'edit__contentverify-2');
  assert not public.content_revision_is_approved(v_r2.id), 'the superseded revision is still approved';
  assert not public.content_revision_is_approved(v_r3.id), 'a new revision inherited the approval';

  raise notice '5.5 revisions and reviews are immutable';
  v_failed := false;
  begin
    update public.content_variant_revisions set body = 'tampered' where id = v_r2.id;
  exception when insufficient_privilege or sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a revision was modified in place';
end $$;
reset role;

----------------------------------------------------------------------------
-- 6. A regeneration that lands after a newer edit becomes a new variant
----------------------------------------------------------------------------
do $$
declare
  v_variant public.content_variants;
  v_base    uuid;
  v_job     public.content_jobs;
  v_token   uuid;
  v_edit    public.content_variant_revisions;
begin
  select v.* into v_variant from public.content_variants v join public.content_items i on i.id = v.item_id
   where i.title = 'Launch __contentverify' and v.channel = 'linkedin';
  v_base := v_variant.current_revision_id;

  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  v_job := public.enqueue_content_job('generate_text', 'regen__contentverify-1', v_variant.item_id, v_variant.id, v_base,
             null, '{"channels":["linkedin"],"stylesPerChannel":1}');
  v_edit := public.create_content_revision(v_variant.id, v_base, '{"body":"Operator edit"}', 'edit__contentverify-li');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select c.claim_token into v_token from public.claim_content_jobs('worker-a', array['generate_text'], 20, 120) c
   where c.job_id = v_job.id;
  assert public.begin_content_dispatch(v_job.id, v_token) = 'go', 'regeneration refused';
  assert public.complete_content_job(v_job.id, v_token,
    '{"promptVersion":"p1","variants":[{"channel":"linkedin","style":"a","body":"Late result","hashtags":[]}]}'),
    'regeneration could not complete';

  assert (select current_revision_id from public.content_variants where id = v_variant.id) = v_edit.id,
         'a late regeneration overwrote the newer edit';
  assert exists (select 1 from public.content_variants where item_id = v_variant.item_id and channel = 'linkedin'
                  and conflict_of_revision_id = v_base), 'the late result was not kept as a conflict variant';
end $$;

----------------------------------------------------------------------------
-- 7. Lease expiry: before dispatch requeues, after dispatch is uncertain
----------------------------------------------------------------------------
do $$
declare
  v_item  uuid := (select id from public.content_items where title = 'Launch __contentverify');
  v_a     public.content_jobs;
  v_b     public.content_jobs;
  v_token uuid;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  v_a := public.enqueue_content_job('generate_image', 'img__contentverify-a', v_item, null, null, null, '{"prompt":"p","count":1}');
  v_b := public.enqueue_content_job('generate_image', 'img__contentverify-b', v_item, null, null, null, '{"prompt":"p","count":1}');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.claim_content_jobs('worker-a', array['generate_image'], 20, 120);
  select claim_token into v_token from public.content_jobs where id = v_b.id;
  assert public.begin_content_dispatch(v_b.id, v_token) = 'go', 'image job refused';

  update public.content_jobs set lease_expires_at = now() - interval '1 minute' where id in (v_a.id, v_b.id);
  perform public.recover_content_jobs();

  assert (select status from public.content_jobs where id = v_a.id) = 'queued',
         'a job that expired before dispatch was not requeued';
  assert (select status from public.content_jobs where id = v_b.id) = 'uncertain',
         'a job that expired after dispatch was not marked uncertain';
  assert public.heartbeat_content_job(v_b.id, v_token, 120) = 'lost', 'an expired worker kept its lease';
end $$;

----------------------------------------------------------------------------
-- 8. Publication: one live per revision/account, refused after an edit, uncertain on retry
----------------------------------------------------------------------------
do $$
declare
  v_variant public.content_variants;
  v_rev     uuid;
  v_pub     public.social_publications;
  v_pub2    public.social_publications;
  v_token   uuid;
  v_hint    text;
  v_failed  boolean := false;
begin
  select v.* into v_variant from public.content_variants v join public.content_items i on i.id = v.item_id
   where i.title = 'Launch __contentverify' and v.channel = 'facebook' and v.conflict_of_revision_id is null
   order by v.created_at limit 1;
  v_rev := v_variant.current_revision_id;

  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);

  raise notice '8.1 an unapproved revision cannot be published';
  begin
    perform public.request_social_publication(v_rev, '00000000-0000-4000-8000-0000000c0a01', '{}', 'pub__contentverify-0');
  exception when sqlstate 'CRM06' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'not_approved', 'an unapproved revision was queued for publication';

  perform public.review_content_revision(v_rev, 'approved');
  v_pub := public.request_social_publication(v_rev, '00000000-0000-4000-8000-0000000c0a01', '{}', 'pub__contentverify-1');
  v_pub2 := public.request_social_publication(v_rev, '00000000-0000-4000-8000-0000000c0a01', '{}', 'pub__contentverify-1');
  assert v_pub.id = v_pub2.id and v_pub.status = 'queued', 'publication request is not idempotent';

  v_failed := false;
  begin
    perform public.request_social_publication(v_rev, '00000000-0000-4000-8000-0000000c0a01', '{}', 'pub__contentverify-2');
  exception when sqlstate 'CRM06' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'already_published', 'one revision went live twice on the same account';

  raise notice '8.2 an edit after the request refuses the dispatch';
  perform public.create_content_revision(v_variant.id, v_rev, '{"body":"Changed after request"}', 'edit__contentverify-3');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select c.claim_token into v_token from public.claim_content_jobs('worker-a', array['publish_social'], 20, 120) c
   where c.job_id = v_pub.job_id;
  assert public.begin_content_dispatch(v_pub.job_id, v_token) = 'refused', 'a changed revision was dispatched';
  assert (select status from public.social_publications where id = v_pub.id) = 'failed', 'refused publication not closed';

  raise notice '8.3 a retried public call becomes uncertain';
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  v_rev := (select current_revision_id from public.content_variants where id = v_variant.id);
  perform public.review_content_revision(v_rev, 'approved');
  v_pub := public.request_social_publication(v_rev, '00000000-0000-4000-8000-0000000c0a01', '{}', 'pub__contentverify-3');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select c.claim_token into v_token from public.claim_content_jobs('worker-a', array['publish_social'], 20, 120) c
   where c.job_id = v_pub.job_id;
  assert public.begin_content_dispatch(v_pub.job_id, v_token) = 'go', 'valid publication refused';
  assert (select status from public.social_publications where id = v_pub.id) = 'dispatching', 'not dispatching';
  assert public.fail_content_job(v_pub.job_id, v_token, 'retry', 'transient', '502 from provider'), 'fail refused';
  assert (select status from public.content_jobs where id = v_pub.job_id) = 'uncertain',
         'a public call that may have happened was queued for retry';
  assert (select status from public.social_publications where id = v_pub.id) = 'uncertain', 'publication not uncertain';

  raise notice '8.4 a person resolves it';
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  perform public.resolve_uncertain_content_job(v_pub.job_id, 'succeeded', 'Found the post on the page',
                                               'fb_123', 'https://facebook.com/fb_123');
  assert (select status from public.social_publications where id = v_pub.id) = 'published', 'resolution not applied';
end $$;

----------------------------------------------------------------------------
-- 9. Asset files must stay inside the assigned prefix
----------------------------------------------------------------------------
do $$
declare
  v_asset  uuid;
  v_job    public.content_jobs;
  v_token  uuid;
  v_failed boolean := false;
  v_file   jsonb := '{"mimeType":"image/jpeg","byteSize":1000,"width":10,"height":10,"checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
begin
  insert into public.content_assets (brand_id, origin, quarantine_path, created_by)
  select id, 'upload', 'uploads/x/a.jpg', '00000000-0000-4000-8000-0000000c0b01'
    from public.content_brand_profiles where slug = 'ai4l'
  returning id into v_asset;

  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  v_job := public.enqueue_content_job('ingest_asset', 'ingest__contentverify-1', null, null, null, v_asset,
             jsonb_build_object('assetId', v_asset, 'quarantinePath', 'uploads/x/a.jpg'));

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select c.claim_token into v_token from public.claim_content_jobs('worker-a', array['ingest_asset'], 20, 120) c
   where c.job_id = v_job.id;

  begin
    perform public.complete_content_job(v_job.id, v_token, jsonb_build_object('status', 'ready', 'files',
      jsonb_build_object('original', v_file || jsonb_build_object('path', 'library/' || gen_random_uuid() || '/original.jpg'))));
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed, 'a file outside the assigned prefix was accepted';

  assert public.complete_content_job(v_job.id, v_token, jsonb_build_object('status', 'ready', 'files',
    jsonb_build_object('original', v_file || jsonb_build_object('path', 'library/' || v_asset || '/original.jpg'),
                       'renditions', jsonb_build_object('social',
                         v_file || jsonb_build_object('path', 'library/' || v_asset || '/social.jpg'))))),
    'a valid ingest result was refused';
  assert (select ingest_status from public.content_assets where id = v_asset) = 'ready', 'asset not ready';
end $$;

----------------------------------------------------------------------------
-- 10. Hardening: duplicate idempotency, archived content, abandoned ingestion
----------------------------------------------------------------------------
do $$
declare
  v_variant public.content_variants;
  v_dup     public.content_variants;
  v_again   public.content_variants;
  v_asset   uuid;
  v_job     public.content_jobs;
  v_failed  boolean := false;
  v_hint    text;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  select v.* into v_variant from public.content_variants v join public.content_items i on i.id = v.item_id
   where i.title = 'Launch __contentverify' and v.channel = 'linkedin' and v.conflict_of_revision_id is null;

  raise notice '10.1 duplicate is idempotent and does not reuse an edit key';
  v_dup := public.duplicate_content_variant(v_variant.id, 'dup__contentverify-1');
  v_again := public.duplicate_content_variant(v_variant.id, 'dup__contentverify-1');
  assert v_dup.id = v_again.id and v_dup.id <> v_variant.id, 'duplicate is not idempotent';
  begin
    perform public.duplicate_content_variant(v_variant.id, 'edit__contentverify-li');
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'an edit key was accepted as a duplicate';

  raise notice '10.2 archived content cannot be reviewed or regenerated';
  update public.content_variants set archived_at = now() where id = v_dup.id;
  v_failed := false;
  begin
    perform public.review_content_revision(v_dup.current_revision_id, 'approved');
  exception when sqlstate 'CRM07' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'archived', 'an archived variant was approved';
  v_failed := false;
  begin
    perform public.enqueue_content_job('generate_text', 'regen__contentverify-archived', v_dup.item_id, v_dup.id,
      v_dup.current_revision_id, null, '{"channels":["linkedin"]}');
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an archived variant was regenerated';

  raise notice '10.3 an abandoned ingestion rejects its image';
  insert into public.content_assets (brand_id, origin, quarantine_path, created_by)
  select id, 'upload', 'uploads/y/b.jpg', '00000000-0000-4000-8000-0000000c0b01'
    from public.content_brand_profiles where slug = 'ai4l'
  returning id into v_asset;
  v_job := public.enqueue_content_job('ingest_asset', 'ingest__contentverify-2', null, null, null, v_asset,
             jsonb_build_object('assetId', v_asset, 'quarantinePath', 'uploads/y/b.jpg'));
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.claim_content_jobs('worker-a', array['ingest_asset'], 20, 120);
  update public.content_jobs set lease_expires_at = now() - interval '1 minute', attempts = max_attempts
   where id = v_job.id;
  perform public.recover_content_jobs();
  assert (select status from public.content_jobs where id = v_job.id) = 'failed', 'exhausted ingestion not failed';
  assert (select ingest_status from public.content_assets where id = v_asset) = 'rejected',
         'an abandoned ingestion left its image pending';
end $$;

----------------------------------------------------------------------------
-- 11. Review hardening: blocked content, forged audit, lease token, re-ingestion
----------------------------------------------------------------------------
do $$
declare
  v_item    uuid := (select id from public.content_items where title = 'Launch __contentverify');
  v_variant uuid;
  v_rev     uuid;
  v_asset   uuid;
  v_failed  boolean := false;
  v_hint    text;
begin
  raise notice '11.1 a blocked generated revision cannot be approved until edited';
  insert into public.content_variants (item_id, channel, style) values (v_item, 'facebook', 'blocked') returning id into v_variant;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_rev := (public.content_insert_revision(v_variant, null, 'generated',
    '{"body":"Visit https://evil.example","violations":["blocked:link https://evil.example is not an allowed origin"]}',
    null, null, null)).id;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  begin
    perform public.review_content_revision(v_rev, 'approved');
  exception when sqlstate 'CRM07' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'blocked_content', 'blocked generated content was approved';
  v_rev := (public.create_content_revision(v_variant, v_rev, '{"body":"Visit our site"}', 'edit__contentverify-blocked')).id;
  perform public.review_content_revision(v_rev, 'approved');
  assert public.content_revision_is_approved(v_rev), 'the edited revision could not be approved';

  raise notice '11.2 members cannot read lease tokens nor forge audit rows';
  assert not has_column_privilege('authenticated', 'public.content_jobs', 'claim_token', 'select'),
         'members can read claim tokens';
  assert has_column_privilege('authenticated', 'public.content_jobs', 'status', 'select'), 'members cannot read job status';
  assert not has_table_privilege('authenticated', 'public.content_audit_events', 'insert'), 'members can insert audit rows';
  v_failed := false;
  begin
    perform public.record_content_audit('publication.published', 'social_publication', gen_random_uuid());
  exception when invalid_parameter_value then v_failed := true;
  end;
  assert v_failed, 'a member recorded a publication event';
  perform public.record_content_audit('item.updated', 'content_item', v_item, '{"field":"title"}');

  raise notice '11.3 member functions never return a lease token';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.enqueue_content_job('generate_image', 'img__contentverify-token', v_item, null, null, null, '{"prompt":"p","count":1}');
  perform public.claim_content_jobs('worker-token', array['generate_image'], 20, 120);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  assert (public.cancel_content_job((select id from public.content_jobs where idempotency_key = 'img__contentverify-token'))).claim_token is null,
         'cancel returned the running job''s lease token';
  assert (public.enqueue_content_job('generate_image', 'img__contentverify-token', v_item, null, null, null, '{}')).claim_token is null,
         'an idempotent enqueue returned the running job''s lease token';

  raise notice '11.3 a ready asset cannot be ingested again';
  v_asset := (select id from public.content_assets where ingest_status = 'ready' and quarantine_path = 'uploads/x/a.jpg');
  v_failed := false;
  begin
    perform public.enqueue_content_job('ingest_asset', 'ingest__contentverify-again', null, null, null, v_asset, '{}');
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'a ready asset was queued for ingestion again';
end $$;

----------------------------------------------------------------------------
-- 12. Brand profile: administrators only, shapes enforced
----------------------------------------------------------------------------
reset role;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c0a99', 'admin__contentverify@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000c0a99', 'admin', true);

do $$
declare
  v_row    public.content_brand_profiles;
  v_failed boolean := false;
  v_hint   text;
begin
  raise notice '12.1 an operator cannot change the brand profile';
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
  begin
    perform public.update_content_brand_profile('ai4l', '{"tone":"Shouty"}');
  exception when insufficient_privilege then v_failed := true;
  end;
  assert v_failed, 'an operator changed the brand profile';
  assert not has_table_privilege('authenticated', 'public.content_brand_profiles', 'update'),
         'members can update the brand profile directly';

  raise notice '12.2 an administrator can, and bad shapes are refused';
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0a99","role":"authenticated"}', true);
  v_failed := false;
  begin
    perform public.update_content_brand_profile('ai4l', '{"allowedLinkOrigins":["http://insecure.example"]}');
  exception when sqlstate 'CRM07' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'invalid_origin', 'an http origin was accepted';
  v_failed := false;
  begin
    perform public.update_content_brand_profile('ai4l', '{"approvedFacts":[{"id":"f1","text":" "}]}');
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'an empty fact was accepted';

  v_row := public.update_content_brand_profile('ai4l', jsonb_build_object(
    'tone', 'Practical', 'hashtagSeeds', jsonb_build_array('#AI', ' Automation '),
    'allowedLinkOrigins', jsonb_build_array('https://AI4L.example', 'https://ai4l.example'),
    'approvedFacts', jsonb_build_array(jsonb_build_object('id', 'f1', 'text', 'Founded in 2024', 'source', 'site'))));
  assert v_row.tone = 'Practical', 'tone not saved';
  assert v_row.hashtag_seeds = array['AI', 'Automation'], format('hashtags not normalised: %s', v_row.hashtag_seeds);
  assert v_row.allowed_link_origins = array['https://ai4l.example'], 'origins not normalised';
  assert v_row.name = 'AI4L', 'an omitted field was cleared';
  assert exists (select 1 from public.content_audit_events where action = 'brand.updated' and subject_id = v_row.id),
         'the change was not audited';
end $$;

rollback;
