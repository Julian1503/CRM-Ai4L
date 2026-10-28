-- Drop LinkedIn from the Content Studio (2026-10-28). The product owner decided LinkedIn
-- will not be supported: only Facebook and Instagram (plus email) remain.
--
-- 20261007000000_content_studio.sql accepted 'linkedin' as a channel, a social platform
-- and an OAuth provider, with the LinkedIn-only author kinds 'organization' and
-- 'member'. This narrows those checks so none of them can be stored again.
--
-- No row is changed or removed (project rule: no physical deletes). Production holds
-- some LinkedIn history from before the decision -- content items that listed it as a
-- channel, their LinkedIn variants and expired OAuth states. Those rows are kept as
-- written, and must stay archivable, restorable and editable. A CHECK cannot do that:
-- even NOT VALID, Postgres re-checks it on every UPDATE of the row, so restoring an
-- archived {linkedin,email} item would fail. Those three tables keep their original
-- checks and gain a trigger instead, which refuses LinkedIn only when the channel or
-- provider column itself is written. Social accounts have no LinkedIn rows, so their
-- checks are narrowed outright.
--
-- A brand profile may still hold a 'linkedin' key in channel_rules from earlier edits.
-- It is left as stored: the CRM ignores it when reading (src/lib/content-studio/mappers.ts)
-- and the next save from Settings writes only the remaining channels.


-- ---------------------------------------------------------------------------
-- 1. Refuse to run while a LinkedIn account exists or a LinkedIn generation is in
--    flight. Both would break once the engine no longer knows the platform.
-- ---------------------------------------------------------------------------
do $$
declare
  v_accounts  bigint;
  v_jobs      bigint;
begin
  select count(*) into v_accounts from public.social_accounts
   where platform = 'linkedin' or provider = 'linkedin' or author_kind in ('organization', 'member');
  select count(*) into v_jobs from public.content_jobs
   where status in ('queued', 'running')
     and jsonb_typeof(input -> 'channels') = 'array' and (input -> 'channels') ? 'linkedin';

  if v_accounts + v_jobs > 0 then
    raise exception 'LinkedIn accounts or generations still active; nothing was changed.'
      using errcode = 'P0001',
            detail = format('social_accounts: %s, active content_jobs: %s', v_accounts, v_jobs),
            hint = 'Disconnect the accounts and let the jobs finish before applying 20261028000000_drop_linkedin.sql. Do not delete them.';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Narrow the checks. The constraints are dropped by name (no "if exists") so a
--    renamed constraint fails here instead of leaving 'linkedin' accepted.
-- ---------------------------------------------------------------------------
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

/*
 * Refuses LinkedIn wherever a channel or provider is written: a new row, or an UPDATE
 * that sets the column. Updates that leave it out (archive, restore, a title edit, a
 * new revision) never fire it, so pre-decision rows stay workable. Raised as
 * check_violation so callers see the same error a CHECK would give.
 */
create or replace function public.refuse_linkedin()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_linkedin boolean;
begin
  -- One branch per table: NEW only has the columns of the table that fired.
  if tg_table_name = 'content_items' then
    v_linkedin := 'linkedin' = any (new.channels);
  elsif tg_table_name = 'content_variants' then
    v_linkedin := new.channel = 'linkedin';
  else
    v_linkedin := new.provider = 'linkedin';
  end if;

  if v_linkedin then
    raise exception 'LinkedIn is no longer supported (%).', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger content_items_refuse_linkedin
  before insert or update of channels on public.content_items
  for each row execute function public.refuse_linkedin();

create trigger content_variants_refuse_linkedin
  before insert or update of channel on public.content_variants
  for each row execute function public.refuse_linkedin();

create trigger social_oauth_states_refuse_linkedin
  before insert or update of provider on public.social_oauth_states
  for each row execute function public.refuse_linkedin();

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
