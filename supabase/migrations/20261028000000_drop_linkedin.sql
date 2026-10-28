-- Drop LinkedIn from the Content Studio (2026-10-28). The product owner decided LinkedIn
-- will not be supported: only Facebook and Instagram (plus email) remain.
--
-- 20261007000000_content_studio.sql accepted 'linkedin' as a channel, a social platform
-- and an OAuth provider, with the LinkedIn-only author kinds 'organization' and
-- 'member'. This narrows those checks so none of them can be stored again.
--
-- No row is changed or removed (project rule: no physical deletes). If any row still
-- uses LinkedIn the migration stops with the counts, so an operator decides what to do
-- with that data; production is expected to have none (its social accounts are Facebook
-- and Instagram only, and it has no publications).
--
-- A brand profile may still hold a 'linkedin' key in channel_rules from earlier edits.
-- It is left as stored: the CRM ignores it when reading (src/lib/content-studio/mappers.ts)
-- and the next save from Settings writes only the remaining channels.


-- ---------------------------------------------------------------------------
-- 1. Refuse to run while anything still uses LinkedIn.
-- ---------------------------------------------------------------------------
do $$
declare
  v_items     bigint;
  v_variants  bigint;
  v_accounts  bigint;
  v_states    bigint;
  v_jobs      bigint;
begin
  select count(*) into v_items from public.content_items where 'linkedin' = any (channels);
  select count(*) into v_variants from public.content_variants where channel = 'linkedin';
  select count(*) into v_accounts from public.social_accounts
   where platform = 'linkedin' or provider = 'linkedin' or author_kind in ('organization', 'member');
  select count(*) into v_states from public.social_oauth_states where provider = 'linkedin';
  -- A queued or running generation for LinkedIn would fail in the engine, which no
  -- longer knows the channel. Finished jobs keep their input as history.
  select count(*) into v_jobs from public.content_jobs
   where status in ('queued', 'running')
     and jsonb_typeof(input -> 'channels') = 'array' and (input -> 'channels') ? 'linkedin';

  if v_items + v_variants + v_accounts + v_states + v_jobs > 0 then
    raise exception 'LinkedIn data still present; nothing was changed.'
      using errcode = 'P0001',
            detail = format('content_items: %s, content_variants: %s, social_accounts: %s, social_oauth_states: %s, active content_jobs: %s',
                            v_items, v_variants, v_accounts, v_states, v_jobs),
            hint = 'Review these rows and decide how to retire them before applying 20261028000000_drop_linkedin.sql. Do not delete them.';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Narrow the checks. The constraints are dropped by name (no "if exists") so a
--    renamed constraint fails here instead of leaving 'linkedin' accepted.
-- ---------------------------------------------------------------------------
alter table public.content_items drop constraint content_items_channels_valid;
alter table public.content_items add constraint content_items_channels_valid check (
  cardinality(channels) between 1 and 3
  and channels <@ array['facebook', 'instagram', 'email']::text[]
);

alter table public.content_variants drop constraint content_variants_channel_check;
alter table public.content_variants add constraint content_variants_channel_check
  check (channel in ('facebook', 'instagram', 'email'));

alter table public.social_accounts drop constraint social_accounts_platform_check;
alter table public.social_accounts add constraint social_accounts_platform_check
  check (platform in ('facebook', 'instagram'));

alter table public.social_accounts drop constraint social_accounts_provider_check;
alter table public.social_accounts add constraint social_accounts_provider_check
  check (provider in ('meta', 'mock'));

-- 'organization' and 'member' were LinkedIn's author kinds.
alter table public.social_accounts drop constraint social_accounts_author_kind_check;
alter table public.social_accounts add constraint social_accounts_author_kind_check
  check (author_kind in ('page', 'instagram_business'));

alter table public.social_oauth_states drop constraint social_oauth_states_provider_check;
alter table public.social_oauth_states add constraint social_oauth_states_provider_check
  check (provider in ('meta', 'mock'));

comment on column public.social_oauth_states.options is
  'Unused since LinkedIn was dropped (2026-10-28); it held the LinkedIn author mode. Always {}.';


-- ---------------------------------------------------------------------------
-- 3. The brand profile no longer accepts channel rules for LinkedIn. Body as in
--    20261007000000_content_studio.sql with the channel list narrowed; grants are kept.
-- ---------------------------------------------------------------------------

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
        where k not in ('facebook', 'instagram', 'email')  -- LinkedIn dropped (2026-10-28)
     ) then
    raise exception 'Channel rules may only name facebook, instagram or email.'
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
