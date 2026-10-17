-- Content Studio AI suggestions (docs/CONTENT_STUDIO_SUGGESTIONS_PLAN.md).
--
-- One row per suggestion request a member sends to the content engine. The table does
-- three jobs:
--   * rate limit — claim_content_suggestion() refuses a member's 51st request within a
--     minute (CRM10, hint rate_limited → HTTP 429). The count lives here because an
--     in-memory counter does not survive across serverless instances;
--   * cache — a succeeded result is reused for 24 h by anyone asking for the same kind
--     and context hash (the context is content and brand only, never personal data);
--   * usage — model, prompt version, tokens and latency, to measure the real cost.
--
-- Members read every row (the cache is shared) and write only through the two
-- functions below, which act on their own rows. No contact data is ever stored here.

create table if not exists public.content_suggestion_requests (
    id              uuid primary key default gen_random_uuid(),
    requested_by    uuid references auth.users (id) on delete set null,
    kind            text not null
                    check (kind in ('rewrite_instructions', 'image_prompts', 'brief_completion', 'content_ideas')),
    context_hash    text not null check (context_hash ~ '^[0-9a-f]{64}$'),
    status          text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
    result          jsonb,
    model           text check (model is null or char_length(model) <= 100),
    prompt_version  text check (prompt_version is null or char_length(prompt_version) <= 100),
    usage           jsonb not null default '{}'::jsonb,
    latency_ms      integer check (latency_ms is null or latency_ms between 0 and 600000),
    error_code      text,
    created_at      timestamptz not null default now(),
    finished_at     timestamptz,
    constraint content_suggestion_requests_result_object check (
      result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 32000)
    ),
    constraint content_suggestion_requests_usage_object check (
      jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 1000
    ),
    constraint content_suggestion_requests_error_code check (error_code is null or error_code ~ '^[a-z0-9_]{1,60}$'),
    constraint content_suggestion_requests_succeeded_has_result check (status <> 'succeeded' or result is not null),
    constraint content_suggestion_requests_finished check ((status = 'pending') = (finished_at is null))
);

comment on table public.content_suggestion_requests is
  'AI suggestion requests from Content Studio: rate limit, shared 24 h cache and usage. Content only.';

create index if not exists content_suggestion_requests_member_idx
    on public.content_suggestion_requests (requested_by, created_at desc);
create index if not exists content_suggestion_requests_cache_idx
    on public.content_suggestion_requests (kind, context_hash, created_at desc) where status = 'succeeded';

alter table public.content_suggestion_requests enable row level security;
revoke all on public.content_suggestion_requests from anon, authenticated;
grant select on public.content_suggestion_requests to authenticated;

drop policy if exists "Members read suggestion requests" on public.content_suggestion_requests;
create policy "Members read suggestion requests"
  on public.content_suggestion_requests for select to authenticated using (true);
drop policy if exists "Approved CRM members only" on public.content_suggestion_requests;
create policy "Approved CRM members only"
  on public.content_suggestion_requests as restrictive for all to authenticated
  using ((select public.is_crm_member())) with check ((select public.is_crm_member()));

/**
 * Takes one of the calling member's 50 suggestion requests per minute and records it as
 * pending. Serialised per member, so two concurrent requests cannot both take the 50th.
 */
create or replace function public.claim_content_suggestion(p_kind text, p_context_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_count integer;
  v_id    uuid;
begin
  if v_uid is null or not public.is_crm_member() then
    raise exception 'Only CRM members can ask for suggestions.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('content_suggestions:' || v_uid::text, 0));

  select count(*) into v_count
    from public.content_suggestion_requests
   where requested_by = v_uid
     and created_at > now() - interval '1 minute';
  if v_count >= 50 then
    raise exception 'Too many suggestion requests. Wait a minute and try again.'
      using errcode = 'CRM10', hint = 'rate_limited';
  end if;

  insert into public.content_suggestion_requests (requested_by, kind, context_hash)
  values (v_uid, p_kind, p_context_hash)
  returning id into v_id;
  return v_id;
end;
$$;

/** Settles one of the calling member's pending requests, once. */
create or replace function public.finish_content_suggestion(
  p_id             uuid,
  p_status         text,
  p_result         jsonb,
  p_model          text,
  p_prompt_version text,
  p_usage          jsonb,
  p_latency_ms     integer,
  p_error_code     text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'A suggestion request ends as succeeded or failed.' using errcode = '22023';
  end if;

  update public.content_suggestion_requests
     set status         = p_status,
         result         = p_result,
         model          = p_model,
         prompt_version = p_prompt_version,
         usage          = coalesce(p_usage, '{}'::jsonb),
         latency_ms     = p_latency_ms,
         error_code     = p_error_code,
         finished_at    = now()
   where id = p_id
     and requested_by = auth.uid()
     and status = 'pending';
  if not found then
    raise exception 'Suggestion request not found.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.claim_content_suggestion(text, text) from public, anon;
grant execute on function public.claim_content_suggestion(text, text) to authenticated;
revoke all on function public.finish_content_suggestion(uuid, text, jsonb, text, text, jsonb, integer, text) from public, anon;
grant execute on function public.finish_content_suggestion(uuid, text, jsonb, text, text, jsonb, integer, text) to authenticated;
