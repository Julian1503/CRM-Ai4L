-- Enforce approved CRM membership (audit findings C1, H1).
--
-- Requires 20261002000000_crm_membership.sql. Every public table gets a RESTRICTIVE
-- membership policy; integration secrets leave the browser; the one operator-callable
-- SECURITY DEFINER RPC checks membership instead of a bare session.
--
-- ROLLOUT: refuses to run while auth accounts exist but no active administrator does,
-- so a push cannot lock the legitimate administrator out. Bootstrap one with
-- `npm run db:member -- grant <email> admin`, then push again.

-- Rollout guard. A fresh database (no auth accounts: local stack, CI) enforces
-- immediately; a live one must have its administrator bootstrapped first.
do $$
begin
  if exists (select 1 from auth.users)
     and not exists (select 1 from public.crm_members where role = 'admin' and active) then
    raise exception
      'crm_members has no active administrator. Run `npm run db:member -- grant <email> admin` '
      'against this database, then apply 20261002000100_crm_membership_enforce again.';
  end if;
end;
$$;

-- Every public table: RLS on, and a restrictive membership policy for `authenticated`.
-- Restrictive policies are ANDed with the permissive ones, so each table keeps exactly
-- the operations it allowed before, now only for approved staff.
do $$
declare
  t text;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and c.relname <> 'crm_members'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('drop policy if exists "Approved CRM members only" on public.%I', t);
    execute format(
      'create policy "Approved CRM members only" on public.%I as restrictive for all '
      'to authenticated using (public.is_crm_member()) with check (public.is_crm_member())',
      t
    );
  end loop;
end;
$$;

-- The view runs with the caller's rights (security_invoker), so the contacts policies
-- above already apply; anon keeps no grant on it.
revoke all on public.active_contacts from anon;

-- Integration secrets (audit finding H1): no browser role reads or writes them. The
-- server reads with the service role after checking the caller's membership, and only
-- administrators may replace them — see src/lib/integrations/credentialStore.ts.
drop policy if exists "Allow read access to authenticated users" on public.credentials;
drop policy if exists "Allow insert access to authenticated users" on public.credentials;
drop policy if exists "Allow update access to authenticated users" on public.credentials;
drop policy if exists "Allow delete access to authenticated users" on public.credentials;
revoke all on public.credentials from anon, authenticated;

-- The one SECURITY DEFINER RPC callable by operators checked only for a session.
create or replace function public.create_campaign_booking(
  p_token_hash text,
  p_contact_id uuid,
  p_campaign_id uuid,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking_id uuid;
begin
  if not public.is_crm_member() then
    raise exception 'An approved CRM member is required.' using errcode = '42501';
  end if;

  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid booking token hash.' using errcode = '22023';
  end if;

  if p_expires_at <= now() or p_expires_at > now() + interval '31 days' then
    raise exception 'Invalid booking expiry.' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.campaigns c
      join public.campaign_sends cs
        on cs.campaign_id = c.id
       and cs.contact_id = p_contact_id
     where c.id = p_campaign_id
       and c.status = 'sending'
       and cs.status = 'pending'
  ) then
    raise exception 'No pending campaign send can mint this booking.' using errcode = '42501';
  end if;

  insert into public.bookings (
    token_hash,
    contact_id,
    campaign_id,
    status,
    expires_at
  ) values (
    p_token_hash,
    p_contact_id,
    p_campaign_id,
    'pending',
    p_expires_at
  )
  returning id into booking_id;

  return booking_id;
end;
$$;

revoke all on function public.create_campaign_booking(text, uuid, uuid, timestamptz)
  from public, anon;
grant execute on function public.create_campaign_booking(text, uuid, uuid, timestamptz)
  to authenticated;

-- Every other function in public is either SECURITY INVOKER (RLS applies) or a trigger.
-- Anonymous callers have no business executing any of them: every public page (booking,
-- preferences) reads through the service role. EXECUTE is granted to PUBLIC by default,
-- which anon inherits, so both grants go.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end;
$$;

alter default privileges in schema public revoke execute on functions from public, anon;
