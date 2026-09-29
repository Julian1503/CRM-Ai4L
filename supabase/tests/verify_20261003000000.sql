-- Verification for 20261003000000_campaign_delivery.sql and 20261003010000_consent_outbox.sql
-- (audit H3, H4, H5, H6, H7).
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end. Every fixture carries the suffix `__deliveryverify`.
--
-- Run with:
--   npm run db:verify -- delivery
--
-- The concurrent-worker, fault-injection and row-cap cases need real separate
-- connections and a client; they live in src/lib/marketing/delivery.integration.test.ts
-- and src/lib/consent/outbox.integration.test.ts (npm run test:integration).

begin;

do $$
declare
  v_failed   boolean;
  v_segment  uuid;
  v_campaign uuid;
  v_contact1 uuid;
  v_contact2 uuid;
  v_claim    record;
  v_token    uuid;
  v_send     uuid;
  v_verdict  text;
  v_revision integer;
begin
  insert into public.segments (name) values ('Segment __deliveryverify') returning id into v_segment;
  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
    values ('A', 'One', 'a__deliveryverify@example.invalid', true) returning id into v_contact1;
  insert into public.contacts (first_name, last_name, email, subscribed_to_newsletter)
    values ('B', 'Two', 'b__deliveryverify@example.invalid', true) returning id into v_contact2;
  insert into public.campaigns (name, segment_id, provider_automation_id)
    values ('Campaign __deliveryverify', v_segment, 'auto__deliveryverify') returning id into v_campaign;

  ----------------------------------------------------------------------------
  raise notice '1. content changes move the revision; approval binds it (H6)';
  ----------------------------------------------------------------------------
  update public.campaigns set merge_fields = '{"Headline":"One"}' where id = v_campaign;
  assert (select revision from public.campaigns where id = v_campaign) = 2, 'revision did not move on a copy change';

  update public.campaigns set status = 'in_review' where id = v_campaign;
  v_failed := false;
  begin
    update public.campaigns set merge_fields = '{"Headline":"Sneaky"}' where id = v_campaign;
  exception when sqlstate 'CRM03' then v_failed := true;
  end;
  assert v_failed, 'content changed while in review';

  update public.campaigns set status = 'approved', approved_by = gen_random_uuid() where id = v_campaign;
  assert (select approved_revision = revision from public.campaigns where id = v_campaign),
         'approval did not bind the current revision';

  ----------------------------------------------------------------------------
  raise notice '2. no dispatch before the run is fully prepared (H7)';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    update public.campaigns set status = 'sending' where id = v_campaign;
  exception when sqlstate 'CRM05' then v_failed := true;
  end;
  assert v_failed, 'sending started without a prepared run';

  insert into public.campaign_runs (campaign_id, run, revision, segment_id, consent_stream, audience_status)
  select id, send_run, revision, segment_id, consent_stream, 'prepared' from public.campaigns where id = v_campaign;
  insert into public.campaign_sends (campaign_id, contact_id, run) values (v_campaign, v_contact1, 1), (v_campaign, v_contact2, 1);
  update public.campaigns set status = 'sending' where id = v_campaign;

  ----------------------------------------------------------------------------
  raise notice '3. claims are owned; only the owner records an outcome (H3)';
  ----------------------------------------------------------------------------
  select * into v_claim from public.claim_campaign_sends(v_campaign, 1, 1, 60);
  assert v_claim.send_id is not null, 'nothing was claimed';
  assert (select count(*) from public.claim_campaign_sends(v_campaign, 1, 10, 60)) = 1,
         'a second claim took the already-claimed recipient';

  assert not public.complete_campaign_send(v_claim.send_id, gen_random_uuid(), 'sent'),
         'a stranger recorded an outcome';

  v_verdict := public.begin_campaign_dispatch(v_claim.send_id, v_claim.claim_token);
  assert v_verdict = 'go', format('dispatch refused: %s', v_verdict);
  assert (select provider_attempted_at is not null from public.campaign_sends where id = v_claim.send_id),
         'the provider attempt was not recorded before the call';

  ----------------------------------------------------------------------------
  raise notice '4. a lease that expires after the provider call becomes uncertain';
  ----------------------------------------------------------------------------
  update public.campaign_sends set lease_expires_at = now() - interval '1 second' where id = v_claim.send_id;
  perform public.claim_campaign_sends(v_campaign, 1, 1, 60);
  assert (select status from public.campaign_sends where id = v_claim.send_id) = 'uncertain',
         'an attempted row was recovered as retryable';

  -- The original worker learns it succeeded after all: it may settle its own row.
  assert public.complete_campaign_send(v_claim.send_id, v_claim.claim_token, 'sent', 'ref'),
         'the owner could not settle its uncertain row';
  assert (select status from public.campaign_sends where id = v_claim.send_id) = 'sent', 'uncertain -> sent failed';

  ----------------------------------------------------------------------------
  raise notice '5. consent withdrawal suppresses queued and claimed recipients (H4)';
  ----------------------------------------------------------------------------
  -- The recipient step 3's second claim took (which contact came first is not ordered).
  select cs.id, cs.claim_token, cs.contact_id into v_send, v_token, v_contact2
    from public.campaign_sends cs
   where cs.campaign_id = v_campaign and cs.id <> v_claim.send_id;
  select id into v_contact1 from public.contacts where id = v_claim.contact_id;
  update public.contacts set subscribed_to_newsletter = false, subscribed_to_programs = true where id = v_contact2;
  v_verdict := public.begin_campaign_dispatch(v_send, v_token);
  assert v_verdict = 'skipped', format('a withdrawn contact was dispatched: %s', v_verdict);
  assert (select error from public.campaign_sends where id = v_send) like '%newsletter consent%',
         'the skip reason was not recorded';

  ----------------------------------------------------------------------------
  raise notice '6. a failed campaign that is edited needs a new approval (H6)';
  ----------------------------------------------------------------------------
  update public.campaigns set status = 'failed' where id = v_campaign;
  select revision into v_revision from public.campaigns where id = v_campaign;
  update public.campaigns set merge_fields = '{"Headline":"Fixed"}' where id = v_campaign;
  assert (select status = 'draft' and approved_revision is null and revision = v_revision + 1
            from public.campaigns where id = v_campaign),
         'an edited failed campaign kept its approval';

  ----------------------------------------------------------------------------
  raise notice '7. consent changes are queued for the provider in the same transaction (H5)';
  ----------------------------------------------------------------------------
  assert exists (
    select 1 from public.consent_sync_outbox
     where contact_id = v_contact2
       and consent_version = (select consent_version from public.contacts where id = v_contact2)
  ), 'the withdrawal was not queued for the provider';

  update public.contacts set subscribed_to_newsletter = true where id = v_contact1;  -- no change
  assert (select count(*) from public.consent_sync_outbox where contact_id = v_contact1) = 1,
         'a write that changed nothing was queued';

  raise notice 'All delivery and consent checks passed.';
end $$;

rollback;
