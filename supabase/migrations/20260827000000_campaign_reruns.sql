-- Campaign re-runs.
--
-- A campaign that has been sent is currently frozen: the status trigger treats 'sent'
-- as terminal, so the same audience can never be mailed again without creating a second
-- campaign and losing the connection between the two.
--
-- The obvious way to allow it -- clear `campaign_sends` and send again -- destroys the
-- only record of who was emailed and what happened to them, which is both the audit
-- trail and, under the Australian Spam Act, the evidence that a send went only to
-- subscribed contacts. So a campaign gains a run counter instead: every fan-out is
-- numbered, rows are kept forever, and the deduplication guarantee moves from
-- "once per campaign" to "once per campaign per run" -- which is what it always meant.

-- ---------------------------------------------------------------------------
-- 1. Run counters
-- ---------------------------------------------------------------------------
alter table public.campaigns
    add column if not exists send_run integer not null default 1;

alter table public.campaigns
    drop constraint if exists campaigns_send_run_check;
alter table public.campaigns
    add constraint campaigns_send_run_check check (send_run >= 1);

alter table public.campaign_sends
    add column if not exists run integer not null default 1;

alter table public.campaign_sends
    drop constraint if exists campaign_sends_run_check;
alter table public.campaign_sends
    add constraint campaign_sends_run_check check (run >= 1);

-- ---------------------------------------------------------------------------
-- 2. Deduplication, per run
-- ---------------------------------------------------------------------------
-- Still the mechanism that stops a double send: EmailOctopus will happily queue the
-- same contact twice with "Allow contacts to repeat" enabled, so this index is what
-- prevents it. Widened by `run` so a deliberate second send is possible and an
-- accidental one is not.
drop index if exists public.campaign_sends_unique_recipient_idx;

create unique index if not exists campaign_sends_unique_recipient_run_idx
    on public.campaign_sends (campaign_id, contact_id, run);

-- Every read of the ledger is now scoped to a run.
create index if not exists campaign_sends_campaign_run_idx
    on public.campaign_sends (campaign_id, run);

-- ---------------------------------------------------------------------------
-- 3. 'sent' is no longer terminal
-- ---------------------------------------------------------------------------
-- Re-opening returns the campaign to 'draft' rather than straight to 'approved': the
-- audience may have changed since the first send, so the human approval gate has to be
-- crossed again. That keeps the invariant this trigger exists for -- nothing reaches
-- 'sending' without an approval -- intact for a second run.
create or replace function public.enforce_campaign_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_allowed text[];
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A campaign must be created as draft, got %', new.status;
    end if;
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'draft'     then array['in_review']
    when 'in_review' then array['draft', 'approved']
    when 'approved'  then array['draft', 'sending']
    when 'sending'   then array['sent', 'failed']
    when 'failed'    then array['draft', 'approved']
    when 'sent'      then array['draft']
    else array[]::text[]
  end;

  if not (new.status::text = any (v_allowed)) then
    raise exception 'Invalid campaign status transition: % -> %', old.status, new.status;
  end if;

  -- Approval must be deliberate and attributable.
  if new.status = 'approved' and new.approved_by is null then
    raise exception 'A campaign cannot be approved without approved_by';
  end if;

  -- Without an automation id there is nothing to queue contacts into, so approving
  -- would produce a campaign that can never send.
  if new.status = 'approved' and coalesce(btrim(new.provider_automation_id), '') = '' then
    raise exception 'A campaign cannot be approved without provider_automation_id';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A run may never be re-used
-- ---------------------------------------------------------------------------
-- The unique index above assumes the counter only ever goes forward. Enforced here
-- because a decrement would let a second fan-out write over the first run's history.
create or replace function public.enforce_campaign_send_run_forward()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.send_run < old.send_run then
    raise exception 'A campaign send run cannot go backwards: % -> %', old.send_run, new.send_run;
  end if;

  return new;
end;
$$;

drop trigger if exists campaigns_send_run_forward on public.campaigns;
create trigger campaigns_send_run_forward
    before update of send_run on public.campaigns
    for each row execute function public.enforce_campaign_send_run_forward();
