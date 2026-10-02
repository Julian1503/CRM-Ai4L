-- Verification for 20261007010000_campaign_content_snapshots.sql (email bridge).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__snapverify`.
--
-- Run with:  npm run db:verify -- snapshots
--
-- What this guards: a Studio email is an immutable snapshot whose hash the database
-- computes; reserved fields never travel in content; the stream, automation and
-- contract come from the template, never the caller; legacy templates cannot carry
-- Studio content; creation is idempotent and always a draft; a snapshot campaign's copy
-- cannot be edited alone; approval binds to the snapshot hash; a used template's
-- contract is frozen; a failed campaign edited after deliveries starts a new run; each
-- run records the content it sends.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000d0b01', 'operator__snapverify@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000d0b01', 'operator', true);

insert into public.campaign_templates (id, name, provider_automation_id, consent_stream, contract_id, contract_version, slots)
values
  ('00000000-0000-4000-8000-0000000d0a01', 'Studio __snapverify', 'auto-studio', 'newsletter', 'studio-newsletter-v1', 1, '[{"tag":"Headline"}]'),
  ('00000000-0000-4000-8000-0000000d0a02', 'Legacy __snapverify', 'auto-legacy', 'programs', 'legacy-v1', 1, '[{"tag":"Headline"}]');

insert into public.content_items (id, brand_id, title, channels, created_by)
select '00000000-0000-4000-8000-0000000d0c01', id, 'Item __snapverify', array['email'],
       '00000000-0000-4000-8000-0000000d0b01'
  from public.content_brand_profiles where slug = 'ai4l';
insert into public.content_variants (id, item_id, channel) values
  ('00000000-0000-4000-8000-0000000d0d01', '00000000-0000-4000-8000-0000000d0c01', 'email');
insert into public.content_variant_revisions (id, variant_id, revision_number, origin, body, checksum) values
  ('00000000-0000-4000-8000-0000000d0e01', '00000000-0000-4000-8000-0000000d0d01', 1, 'generated', 'Body', 'x');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_result   jsonb;
  v_again    jsonb;
  v_campaign public.campaigns;
  v_failed   boolean := false;
  v_hint     text;
  v_fields   jsonb := '{"Headline":"Hi","Preheader":"Pre","CtaLabel":"Read"}';
begin
  raise notice '1. privileges';
  assert not has_table_privilege('authenticated', 'public.campaign_content_snapshots', 'insert'),
         'members can insert snapshots directly';
  assert not has_table_privilege('anon', 'public.campaign_content_snapshots', 'select'), 'anon can read snapshots';
  assert not has_function_privilege('authenticated',
    'public.create_content_email_snapshot(text, text, uuid, uuid, text, text, text, jsonb, jsonb, text, text, text, uuid, text, uuid)',
    'execute'), 'members can store unrendered snapshot HTML directly';

  raise notice '2. reserved fields refused';
  begin
    perform public.create_content_email_snapshot('export', 'export__snapverify-bad', '00000000-0000-4000-8000-0000000d0e01',
      null, 'none', null, 'Subject', '{"BookingUrl":"https://evil.example"}', '[]', '<p>x</p>', 'x',
      p_actor => '00000000-0000-4000-8000-0000000d0b01');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a reserved field travelled in content';

  raise notice '3. legacy template refused, external_url needs https';
  v_failed := false;
  begin
    perform public.create_content_email_snapshot('campaign', 'camp__snapverify-legacy', '00000000-0000-4000-8000-0000000d0e01',
      '00000000-0000-4000-8000-0000000d0a02', 'none', null, 'Subject', v_fields, '[]', null, null, 'Legacy',
      p_actor => '00000000-0000-4000-8000-0000000d0b01');
  exception when sqlstate 'CRM07' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'legacy_template', 'a legacy template accepted Studio content';

  v_failed := false;
  begin
    perform public.create_content_email_snapshot('export', 'export__snapverify-http', '00000000-0000-4000-8000-0000000d0e01',
      null, 'external_url', 'http://insecure.example', 'S', v_fields, '[]', null, null,
      p_actor => '00000000-0000-4000-8000-0000000d0b01');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'an http CTA URL was accepted';

  raise notice '4. campaign draft from snapshot, idempotent, stream and automation from template';
  v_result := public.create_content_email_snapshot('campaign', 'camp__snapverify-1', '00000000-0000-4000-8000-0000000d0e01',
    '00000000-0000-4000-8000-0000000d0a01', 'external_url', 'https://ai4l.example/post', 'Subject', v_fields, '[]',
    '<p>Hi</p>', 'Hi', 'Studio email __snapverify',
      p_actor => '00000000-0000-4000-8000-0000000d0b01');
  v_again := public.create_content_email_snapshot('campaign', 'camp__snapverify-1', '00000000-0000-4000-8000-0000000d0e01',
    '00000000-0000-4000-8000-0000000d0a01', 'external_url', 'https://ai4l.example/post', 'Subject', v_fields, '[]',
    '<p>Hi</p>', 'Hi', 'Studio email __snapverify',
      p_actor => '00000000-0000-4000-8000-0000000d0b01');
  assert (v_result ->> 'created')::boolean and not (v_again ->> 'created')::boolean, 'creation is not idempotent';
  assert v_result ->> 'campaignId' = v_again ->> 'campaignId', 'a retried conversion created a second campaign';

  select * into v_campaign from public.campaigns where id = (v_result ->> 'campaignId')::uuid;
  assert v_campaign.status = 'draft', 'a converted email is not a draft';
  assert v_campaign.consent_stream = 'newsletter' and v_campaign.provider_automation_id = 'auto-studio',
         'stream or automation did not come from the template';
  assert v_campaign.merge_fields = v_fields, 'merge_fields do not mirror the snapshot';
  assert (select content_hash from public.campaign_content_snapshots where id = v_campaign.content_snapshot_id)
         = public.campaign_snapshot_hash('studio-newsletter-v1', 1, '00000000-0000-4000-8000-0000000d0a01', 'auto-studio',
             'external_url', 'https://ai4l.example/post', 'Subject', v_fields, '[]', '<p>Hi</p>', 'Hi'),
         'stored hash is not the canonical hash';
  assert (select created_by from public.campaign_content_snapshots where id = v_campaign.content_snapshot_id)
         = '00000000-0000-4000-8000-0000000d0b01', 'the acting member was not recorded';
end $$;
reset role;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000d0b01","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_campaign public.campaigns;
  v_failed   boolean := false;
  v_hint     text;
begin
  select * into v_campaign from public.campaigns where name = 'Studio email __snapverify';

  raise notice '5. snapshot copy cannot be edited alone';
  v_failed := false;
  begin
    update public.campaigns set merge_fields = '{"Headline":"Changed"}' where id = v_campaign.id;
  exception when sqlstate 'CRM07' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'snapshot_content_locked', 'a snapshot campaign''s copy was edited in place';

  v_failed := false;
  begin
    update public.campaigns set provider_automation_id = 'auto-other' where id = v_campaign.id;
  exception when sqlstate 'CRM07' then v_failed := true;
  end;
  assert v_failed, 'a snapshot campaign was re-pointed to another automation';

  raise notice '6. snapshots are immutable';
  v_failed := false;
  begin
    update public.campaign_content_snapshots set subject = 'x' where id = v_campaign.content_snapshot_id;
  exception when insufficient_privilege or sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a snapshot was modified';

  raise notice '7. approval binds to the hash';
  update public.campaigns set status = 'in_review' where id = v_campaign.id;
  update public.campaigns set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = v_campaign.id;
  assert (select approved_content_hash from public.campaigns where id = v_campaign.id)
         = (select content_hash from public.campaign_content_snapshots where id = v_campaign.content_snapshot_id),
         'approval did not record the snapshot hash';
end $$;
reset role;

do $$
declare
  v_campaign uuid := (select id from public.campaigns where name = 'Studio email __snapverify');
  v_legacy   uuid;
  v_contact  uuid;
  v_failed   boolean := false;
begin
  v_failed := false;
  raise notice '8. a used template''s contract is frozen';
  begin
    update public.campaign_templates set contract_version = 2 where id = '00000000-0000-4000-8000-0000000d0a01';
  exception when sqlstate 'CRM06' then v_failed := true;
  end;
  assert v_failed, 'a used template changed contract in place';

  raise notice '9. runs record the content they send';
  insert into public.segments (name) values ('Seg __snapverify');
  insert into public.campaign_runs (campaign_id, run, revision, segment_id, consent_stream)
  values (v_campaign, 1, 1, (select id from public.segments where name = 'Seg __snapverify'), 'newsletter');
  assert (select cta_mode from public.campaign_runs where campaign_id = v_campaign and run = 1) = 'external_url',
         'run did not record the CTA mode';
  assert (select content_hash from public.campaign_runs where campaign_id = v_campaign and run = 1)
         = (select content_hash from public.campaign_content_snapshots s join public.campaigns c on c.content_snapshot_id = s.id
             where c.id = v_campaign), 'run did not record the content hash';

  raise notice '10. a failed campaign still starts a new run only for a new audience';
  insert into public.campaigns (name, consent_stream, merge_fields) values ('Legacy __snapverify', 'programs', '{"Headline":"A"}')
  returning id into v_legacy;
  insert into public.contacts (first_name, last_name, email) values ('Ann', 'Snap', 'ann__snapverify@example.invalid')
  returning id into v_contact;

  set local session_replication_role = replica;   -- place the fixture in 'failed' without replaying a send
  update public.campaigns set status = 'failed', send_run = 1 where id = v_legacy;
  insert into public.campaign_sends (campaign_id, contact_id, run, status) values (v_legacy, v_contact, 1, 'sent');
  set local session_replication_role = origin;

  update public.campaigns set segment_id = (select id from public.segments where name = 'Seg __snapverify')
   where id = v_legacy;
  assert (select send_run from public.campaigns where id = v_legacy) = 2, 'audience change reused the ledger';
  assert (select status from public.campaigns where id = v_legacy) = 'draft', 'edited failed campaign is not a draft';
end $$;

rollback;
