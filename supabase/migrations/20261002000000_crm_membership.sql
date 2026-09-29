-- Approved CRM membership (audit finding C1).
--
-- Until now every policy granted CRM data to the `authenticated` role, and a verified
-- Supabase session was the only check. Email signup was enabled, so anyone able to
-- register an account became an operator. Identity and membership are different
-- questions: this migration adds the second one.
--
--   * public.crm_members        one row per approved person, keyed by auth user id
--   * public.is_crm_member()    true for an active member of any role
--   * public.is_crm_admin()     true for an active administrator
--   * a RESTRICTIVE policy on every public table, ANDed with the existing permissive
--     ones, so no existing rule is widened and a missing membership denies everything
--
-- Membership is never derived from user_metadata: users can edit their own metadata
-- through the auth API. Rows are written only by the service role (the provisioning
-- script, supabase/manage-member.js) or by an administrator.
--
-- Permission matrix (docs/ACCESS_CONTROL.md):
--   operator  daily CRM work, including campaign approval and removal
--   admin     everything an operator can do, plus membership and integration secrets
--
-- This file only creates the membership store; it changes nobody's access. Enforcement
-- is 20261002000100_crm_membership_enforce.sql, which refuses to run until an active
-- administrator exists. Between the two, bootstrap one:
--   npm run db:member -- grant <email> admin
-- See docs/ACCESS_CONTROL.md, "Rollout order".

create table if not exists public.crm_members (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    role       text not null check (role in ('admin', 'operator')),
    active     boolean not null default true,
    granted_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default timezone('utc'::text, now()),
    updated_at timestamptz not null default timezone('utc'::text, now())
);

comment on table public.crm_members is
  'Approved CRM staff. A verified Supabase session without an active row here grants nothing.';

create or replace function public.touch_crm_members_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists crm_members_touch_updated_at on public.crm_members;
create trigger crm_members_touch_updated_at
  before update on public.crm_members
  for each row execute function public.touch_crm_members_updated_at();

-- SECURITY DEFINER so the check itself is not subject to the crm_members policies
-- (which would recurse). search_path is empty and every name is schema-qualified.
create or replace function public.is_crm_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.crm_members m
     where m.user_id = auth.uid()
       and m.active
  );
$$;

create or replace function public.is_crm_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.crm_members m
     where m.user_id = auth.uid()
       and m.active
       and m.role = 'admin'
  );
$$;

revoke all on function public.is_crm_member() from public, anon;
revoke all on function public.is_crm_admin() from public, anon;
grant execute on function public.is_crm_member() to authenticated;
grant execute on function public.is_crm_admin() to authenticated;

alter table public.crm_members enable row level security;
revoke all on public.crm_members from anon;

drop policy if exists "Members read their own membership" on public.crm_members;
create policy "Members read their own membership"
  on public.crm_members for select to authenticated
  using (user_id = auth.uid() or public.is_crm_admin());

drop policy if exists "Administrators manage membership" on public.crm_members;
create policy "Administrators manage membership"
  on public.crm_members for all to authenticated
  using (public.is_crm_admin())
  with check (public.is_crm_admin());

-- An administrator must not be able to remove the last active administrator, which
-- would leave only the service-role script as a way back in.
create or replace function public.enforce_last_crm_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'DELETE' or new.role <> 'admin' or not new.active)
     and old.role = 'admin' and old.active
     and not exists (
       select 1 from public.crm_members m
        where m.user_id <> old.user_id and m.role = 'admin' and m.active
     ) then
    raise exception 'The last active administrator cannot be removed or demoted.'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists crm_members_keep_last_admin on public.crm_members;
create trigger crm_members_keep_last_admin
  before update or delete on public.crm_members
  for each row execute function public.enforce_last_crm_admin();
