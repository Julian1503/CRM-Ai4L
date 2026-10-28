-- Verification for 20261028000000_drop_linkedin.sql (LinkedIn dropped from the Studio).
--
-- Non-destructive: runs inside a transaction that is ROLLED BACK. Fixtures carry the
-- suffix `__nolinkedin`.
--
-- Run with:  npm run db:verify -- nolinkedin
--
-- What this guards: no social-account check names LinkedIn any more; a LinkedIn
-- channel, platform, provider or author kind is refused on every table that stored one;
-- the remaining channels (Facebook, Instagram, email) and the Meta/mock providers are
-- still accepted; rows stored before the decision can still be archived, restored and
-- edited; the brand profile refuses channel rules for LinkedIn.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000d1a01', 'admin__nolinkedin@example.invalid');
insert into public.crm_members (user_id, role, active) values
  ('00000000-0000-4000-8000-0000000d1a01', 'admin', true);

do $$
begin
  raise notice '1. no check constraint on social accounts mentions LinkedIn';
  assert not exists (
    select 1 from pg_constraint
     where contype = 'c'
       and conrelid = 'public.social_accounts'::regclass
       and (pg_get_constraintdef(oid) ilike '%linkedin%'
            or pg_get_constraintdef(oid) ilike '%organization%'
            or pg_get_constraintdef(oid) ilike '%''member''%')
  ), 'a check constraint still accepts LinkedIn';
end $$;

do $$
declare
  v_brand  uuid := (select id from public.content_brand_profiles where slug = 'ai4l');
  v_item   uuid;
  v_failed boolean;
  v_bad    text[];
  v_case   text;
begin
  raise notice '2. content items and variants: LinkedIn refused, the rest accepted';
  insert into public.content_items (brand_id, title, brief, channels)
  values (v_brand, 'Post __nolinkedin', '{"topic":"t"}', array['facebook', 'instagram', 'email'])
  returning id into v_item;

  foreach v_case in array array['{linkedin}', '{facebook,linkedin}'] loop
    v_failed := false;
    begin
      insert into public.content_items (brand_id, title, brief, channels)
      values (v_brand, 'Bad __nolinkedin', '{"topic":"t"}', v_case::text[]);
    exception when check_violation then v_failed := true;
    end;
    assert v_failed, format('an item with channels %s was stored', v_case);
  end loop;

  insert into public.content_variants (item_id, channel) values (v_item, 'instagram');
  v_failed := false;
  begin
    insert into public.content_variants (item_id, channel) values (v_item, 'linkedin');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a LinkedIn variant was stored';

  raise notice '3. social accounts: LinkedIn platform, provider and author kinds refused';
  insert into public.social_accounts (brand_id, platform, provider, external_id, display_name, author_kind)
  values (v_brand, 'facebook', 'meta', 'page__nolinkedin', 'Page', 'page'),
         (v_brand, 'instagram', 'mock', 'ig__nolinkedin', 'IG', 'instagram_business');

  foreach v_case in array array[
    'linkedin|meta|page', 'facebook|linkedin|page', 'facebook|meta|organization', 'facebook|meta|member'
  ] loop
    v_bad := string_to_array(v_case, '|');
    v_failed := false;
    begin
      insert into public.social_accounts (brand_id, platform, provider, external_id, display_name, author_kind)
      values (v_brand, v_bad[1], v_bad[2], 'x__nolinkedin-' || v_case, 'X', v_bad[3]);
    exception when check_violation then v_failed := true;
    end;
    assert v_failed, format('a social account %s was stored', v_case);
  end loop;

  raise notice '4. a pre-decision LinkedIn item and variant stay workable';
  -- Stored as production holds them: written before the trigger existed.
  set local session_replication_role = replica;
  insert into public.content_items (brand_id, title, brief, channels)
  values (v_brand, 'Legacy __nolinkedin', '{"topic":"t"}', array['linkedin', 'email'])
  returning id into v_item;
  insert into public.content_variants (item_id, channel) values (v_item, 'linkedin');
  set local session_replication_role = origin;

  update public.content_items set archived_at = now() where id = v_item;
  update public.content_items set archived_at = null, title = 'Legacy edited __nolinkedin' where id = v_item;
  update public.content_variants set archived_at = now() where item_id = v_item and channel = 'linkedin';
  update public.content_items set channels = array['email'] where id = v_item;

  v_failed := false;
  begin
    update public.content_items set channels = array['linkedin', 'email'] where id = v_item;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'LinkedIn was written back onto an item';

  raise notice '5. OAuth state: only Meta and mock';
  insert into public.social_oauth_states (state_hash, provider, actor_id, brand_id, expires_at)
  values ('meta__nolinkedin', 'meta', '00000000-0000-4000-8000-0000000d1a01', v_brand, now() + interval '10 minutes');
  v_failed := false;
  begin
    insert into public.social_oauth_states (state_hash, provider, actor_id, brand_id, expires_at)
    values ('li__nolinkedin', 'linkedin', '00000000-0000-4000-8000-0000000d1a01', v_brand, now() + interval '10 minutes');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a LinkedIn OAuth state was stored';
end $$;

do $$
declare
  v_row    public.content_brand_profiles;
  v_failed boolean := false;
  v_hint   text;
begin
  raise notice '6. brand profile: channel rules for LinkedIn refused, the rest saved';
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000d1a01","role":"authenticated"}', true);
  begin
    perform public.update_content_brand_profile('ai4l', '{"channelRules":{"linkedin":{"cta":"Book"}}}');
  exception when sqlstate 'CRM07' then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_failed := true;
  end;
  assert v_failed and v_hint = 'invalid_channel_rules', 'channel rules for LinkedIn were accepted';

  v_row := public.update_content_brand_profile('ai4l',
    '{"channelRules":{"facebook":{"cta":"Book"},"instagram":{"cta":"Tap"},"email":{"structure":"Short"}}}');
  assert v_row.channel_rules ? 'instagram' and not v_row.channel_rules ? 'linkedin', 'remaining channel rules not saved';
end $$;

rollback;
