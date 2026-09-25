-- Two gaps left by 20260901000000: who changed a consent, and which consent a campaign
-- is allowed to use.
--
-- 1. `app.consent_source` is a session setting, and PostgREST gives every request its
--    own transaction — so nothing that writes consent through supabase-js can label
--    what it did. Every unsubscribe would land in the ledger as 'unknown', which is
--    exactly the event the ledger exists to prove. apply_contact_consent() closes that
--    by doing the labelling and the write in one call, and it is the same door the
--    preference centre will use.
--
-- 2. A campaign selling a course must not be able to reach the newsletter's audience.
--    Consent is per stream, so the gate in segmentDefinitionToFilters needs to know
--    which stream it is gating, and that has to come from the campaign rather than from
--    the segment: a segment is a description of people ("NSW electricians"), not a
--    permission.

-- ---------------------------------------------------------------------------
-- 1. Consent evidence in the ledger
-- ---------------------------------------------------------------------------
-- The trigger from 20260901000000 reads the source; it now also reads the request
-- context, which is what makes an entry usable as evidence rather than just a date.
create or replace function public.record_contact_consent_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source   text := coalesce(nullif(current_setting('app.consent_source', true), ''), 'unknown');
  v_evidence jsonb;
begin
  -- Defensive: a malformed value in the setting must not be able to abort a contact
  -- update. Losing the context is recoverable; refusing an unsubscribe is not.
  begin
    v_evidence := nullif(current_setting('app.consent_evidence', true), '')::jsonb;
  exception
    when others then v_evidence := null;
  end;

  if tg_op = 'INSERT' then
    -- Only consent is an event. A contact created with both flags false has granted
    -- nothing, and recording that would fill the ledger with non-events.
    if new.subscribed_to_newsletter then
      insert into public.contact_consent_events (contact_id, stream, granted, source, evidence)
      values (new.id, 'newsletter', true, v_source, v_evidence);
    end if;

    if new.subscribed_to_programs then
      insert into public.contact_consent_events (contact_id, stream, granted, source, evidence)
      values (new.id, 'programs', true, v_source, v_evidence);
    end if;

    return null;
  end if;

  -- `UPDATE OF` fires on assignment, not on change — an import writing the same value
  -- back must not look like the contact acted.
  if new.subscribed_to_newsletter is distinct from old.subscribed_to_newsletter then
    insert into public.contact_consent_events (contact_id, stream, granted, source, evidence)
    values (new.id, 'newsletter', new.subscribed_to_newsletter, v_source, v_evidence);
  end if;

  if new.subscribed_to_programs is distinct from old.subscribed_to_programs then
    insert into public.contact_consent_events (contact_id, stream, granted, source, evidence)
    values (new.id, 'programs', new.subscribed_to_programs, v_source, v_evidence);
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The one door consent changes go through
-- ---------------------------------------------------------------------------
-- A null flag means "leave this stream alone", which is the difference between the
-- newsletter form (grants one consent, says nothing about the other) and the
-- unsubscribe link (withdraws both). Both are callers of this function.
--
-- The settings are transaction-local (`is_local => true`), so a pooled connection
-- cannot carry one request's attribution into the next.
create or replace function public.apply_contact_consent(
  p_contact_id uuid,
  p_newsletter boolean,
  p_programs   boolean,
  p_source     text,
  p_evidence   jsonb default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_contact_id is null then
    raise exception 'apply_contact_consent: a contact id is required';
  end if;

  -- An unlabelled consent change is worth less than no function at all: it would look
  -- attributed while recording 'unknown'.
  if p_source is null or btrim(p_source) = '' then
    raise exception 'apply_contact_consent: a source is required';
  end if;

  perform set_config('app.consent_source', btrim(p_source), true);
  perform set_config('app.consent_evidence', coalesce(p_evidence::text, ''), true);

  update public.contacts
  set subscribed_to_newsletter = coalesce(p_newsletter, subscribed_to_newsletter),
      subscribed_to_programs   = coalesce(p_programs, subscribed_to_programs)
  where id = p_contact_id;

  -- Cleared rather than left standing: a later write in the same transaction that is
  -- not a consent decision must not inherit this one's attribution.
  perform set_config('app.consent_source', '', true);
  perform set_config('app.consent_evidence', '', true);
end;
$$;

comment on function public.apply_contact_consent(uuid, boolean, boolean, text, jsonb) is
  'Changes one contact''s email consent and labels the resulting ledger entries. A null '
  'flag leaves that stream untouched. The only path that can attribute a consent change, '
  'because the source is a transaction-local setting the trigger reads.';

-- ---------------------------------------------------------------------------
-- 3. Which consent a campaign spends
-- ---------------------------------------------------------------------------
do $$
begin
  create type public.consent_stream as enum ('newsletter', 'programs');
exception
  when duplicate_object then null;
end $$;

-- On the template because the template *is* the stream: an automation whose HTML is a
-- monthly newsletter is not the one that invites somebody to a course.
alter table public.campaign_templates
  add column if not exists consent_stream public.consent_stream not null default 'newsletter';

-- Copied onto the campaign at creation and frozen there. By reference, retiring or
-- re-pointing a template would retroactively change who a campaign that already went
-- out had been allowed to reach — and the send ledger would no longer be explicable.
alter table public.campaigns
  add column if not exists consent_stream public.consent_stream not null default 'newsletter';

comment on column public.campaigns.consent_stream is
  'Which consent this campaign spends. Frozen at creation from the template; the segment gate forces the matching column, so a course campaign cannot reach newsletter-only contacts.';
