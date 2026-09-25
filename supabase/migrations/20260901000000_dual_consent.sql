-- Dual consent — newsletter and programs as two separate permissions.
--
-- Until now one boolean, `subscribed_to_newsletter`, answered every question about
-- whether a contact may be emailed. The client sends two distinct kinds of mail — the
-- newsletter, and courses/trainings — and a person can reasonably want one without the
-- other. One flag cannot express that, so the newsletter's unsubscribe link was also
-- silently cancelling course invitations.
--
-- Three rules are enforced here rather than in the application, because five paths
-- write consent (the EmailOctopus webhook, the contact form, the importer, the sync,
-- and the preference centre still to be built) and a rule that lives in one of them is
-- a rule the other four can break:
--
--   1. Losing every consent archives the contact.
--   2. Regaining any consent un-archives a contact archived *for that reason*, and
--      never one a human archived on purpose.
--   3. Every change to either flag is recorded, with its source.
--
-- Rule 3 is not bookkeeping. The Australian Spam Act 2003 exposure noted in PLAN.md is
-- about being able to *prove* consent; a boolean records the current answer and none of
-- the history behind it.

-- ---------------------------------------------------------------------------
-- 1. The second consent, and why an archive has a reason
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists subscribed_to_programs boolean not null default false;

comment on column public.contacts.subscribed_to_programs is
  'Consent to course, training and programme email. Independent of subscribed_to_newsletter.';

-- Without this column an unsubscribe and a deliberate archive are indistinguishable,
-- and rule 2 cannot be written: re-subscribing would resurrect records the client
-- archived on purpose, which is exactly what applyNewsletterEvent refuses to do today.
alter table public.contacts
  add column if not exists archive_reason text;

comment on column public.contacts.archive_reason is
  'Why the contact is archived: manual (a person decided) or opted_out (they revoked every consent). Null while active.';

-- Every archived row predating this column was archived by a person.
update public.contacts
set archive_reason = 'manual'
where deleted_at is not null and archive_reason is null;

do $$
begin
  alter table public.contacts
    add constraint contacts_archive_reason_valid
    check (
      (deleted_at is null and archive_reason is null)
      or (deleted_at is not null and archive_reason in ('manual', 'opted_out'))
    );
exception
  when duplicate_object then null;
end $$;

create index if not exists contacts_programs_idx
  on public.contacts (subscribed_to_programs) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. Backfill: programme consent for everyone who has not already opted out
-- ---------------------------------------------------------------------------
-- The client's decision is that programme email is on by default until the contact
-- unsubscribes. Contacts already carrying `subscribed_to_newsletter = false` are
-- excluded: whatever else that flag means, it is the only record we have of somebody
-- declining email, and the provider status becomes `newsletter OR programs` — so
-- granting programme consent here would flip them back to `subscribed` in
-- EmailOctopus on the next sync and start mailing people who clicked unsubscribe.
--
-- To grant it to everyone instead, drop the `subscribed_to_newsletter` condition. Do
-- that only with the client's written confirmation; it is their legal exposure, not a
-- technical choice.
update public.contacts
set subscribed_to_programs = true
where deleted_at is null
  and subscribed_to_newsletter = true
  and subscribed_to_programs = false;

-- ---------------------------------------------------------------------------
-- 3. The consent ledger
-- ---------------------------------------------------------------------------
-- Append-only. Written by a trigger rather than by the application, so a path that
-- forgets to record its change cannot exist. `source` is read from a session setting
-- the caller may set (`set_config('app.consent_source', ...)`); an unlabelled write is
-- recorded as 'unknown' rather than dropped, because an unattributed event is still
-- evidence and a missing one is not.
create table if not exists public.contact_consent_events (
    id uuid primary key default gen_random_uuid(),
    contact_id uuid not null references public.contacts(id) on delete cascade,
    stream text not null check (stream in ('newsletter', 'programs')),
    granted boolean not null,
    source text not null,
    -- Request context for a preference-centre change: IP, user agent, provider event
    -- id. Deliberately free-form; what is worth keeping differs per source.
    evidence jsonb,
    occurred_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists contact_consent_events_contact_idx
  on public.contact_consent_events (contact_id, occurred_at desc);

alter table public.contact_consent_events enable row level security;

-- Readable, never writable through the API: the only legitimate writer is the trigger
-- below. An audit trail an application can edit proves nothing.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'contact_consent_events'
      and policyname = 'Allow read access to authenticated users'
  ) then
    create policy "Allow read access to authenticated users"
      on public.contact_consent_events for select to authenticated using (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Consent, archive and status kept consistent on every write
-- ---------------------------------------------------------------------------
-- Extends the existing sync_contact_customer_status trigger rather than adding a
-- second one: both decide the same three columns, and two BEFORE triggers on one row
-- would make the outcome depend on their names.
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

  -- Consent rules apply to a *transition*, never to a row's resting state. Two cases
  -- depend on that distinction:
  --   - A contact created with no consent (someone typed it into the CRM) is a record
  --     the operator meant to create, not an unsubscribe. Archiving it on insert would
  --     make the contact form unusable for anyone who is not a mailing-list member.
  --   - Restoring an opted-out contact from the archive screen leaves both flags false.
  --     Re-reading the resting state would archive it again, making restore impossible.
  if tg_op = 'UPDATE' then
    v_had_consent := old.subscribed_to_newsletter or old.subscribed_to_programs;

    if v_had_consent and not v_has_consent and new.deleted_at is null then
      new.deleted_at := timezone('utc'::text, now());
      new.archive_reason := 'opted_out';
    end if;

    -- Undoes exactly what the rule above did, and nothing else. A contact a person
    -- archived keeps `archive_reason = 'manual'` and stays archived, so an external
    -- newsletter signup still cannot resurrect a record the client removed on purpose.
    if not v_had_consent and v_has_consent
       and new.deleted_at is not null
       and new.archive_reason = 'opted_out'
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
      new.status := 'prospect'::public.contact_status;
    end if;
    -- Enforced by contacts_archive_reason_valid; cleared here so a restore does not
    -- have to remember to do it.
    new.archive_reason := null;
  end if;

  new.is_customer := (new.status = 'customer'::public.contact_status);
  return new;
end;
$$;

drop trigger if exists contacts_sync_customer_status on public.contacts;
create trigger contacts_sync_customer_status
before insert or update of
  status, is_customer, deleted_at, subscribed_to_newsletter, subscribed_to_programs
on public.contacts
for each row
execute function public.sync_contact_customer_status();

-- ---------------------------------------------------------------------------
-- 5. Recording every consent change
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the insert bypasses the read-only policy above: the trigger is
-- the one writer the ledger has.
create or replace function public.record_contact_consent_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text := coalesce(nullif(current_setting('app.consent_source', true), ''), 'unknown');
begin
  if tg_op = 'INSERT' then
    -- Only consent is an event. A contact created with both flags false has granted
    -- nothing, and recording that would fill the ledger with non-events.
    if new.subscribed_to_newsletter then
      insert into public.contact_consent_events (contact_id, stream, granted, source)
      values (new.id, 'newsletter', true, v_source);
    end if;

    if new.subscribed_to_programs then
      insert into public.contact_consent_events (contact_id, stream, granted, source)
      values (new.id, 'programs', true, v_source);
    end if;

    return null;
  end if;

  -- `UPDATE OF` fires on assignment, not on change — an import writing the same value
  -- back must not look like the contact acted.
  if new.subscribed_to_newsletter is distinct from old.subscribed_to_newsletter then
    insert into public.contact_consent_events (contact_id, stream, granted, source)
    values (new.id, 'newsletter', new.subscribed_to_newsletter, v_source);
  end if;

  if new.subscribed_to_programs is distinct from old.subscribed_to_programs then
    insert into public.contact_consent_events (contact_id, stream, granted, source)
    values (new.id, 'programs', new.subscribed_to_programs, v_source);
  end if;

  return null;
end;
$$;

drop trigger if exists contacts_record_consent_events on public.contacts;
create trigger contacts_record_consent_events
after insert or update of subscribed_to_newsletter, subscribed_to_programs
on public.contacts
for each row
execute function public.record_contact_consent_events();

comment on table public.contact_consent_events is
  'Append-only record of every consent change, written by the contacts_record_consent_events trigger. Spam Act 2003 evidence: a boolean says what is true now, this says when it became true and where it came from.';
