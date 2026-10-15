-- Scheduled job runs (UX plan P1.5): one row per run of /api/cron/jobs and
-- /api/cron/newsletters, so the integration health card can say when the worker last
-- ran and whether it succeeded, instead of "unknown".
--
-- integration_deliveries is not reused: its provider check allows only third-party
-- providers, and its rows feed get_operations_summary() per provider.
--
-- Append-only evidence: written by the service role at the end of each run, never
-- updated or deleted. Counts only — no contact data, no error text (a short code).

create table if not exists public.cron_runs (
    id           uuid primary key default gen_random_uuid(),
    job          text not null check (job in ('jobs', 'newsletters')),
    status       text not null check (status in ('succeeded', 'failed')),
    started_at   timestamptz not null,
    finished_at  timestamptz not null default timezone('utc'::text, now()),
    summary      jsonb not null default '{}'::jsonb,
    error_code   text,
    constraint cron_runs_summary_object check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 4000),
    constraint cron_runs_error_code check (error_code is null or error_code ~ '^[a-z0-9_]{1,60}$'),
    constraint cron_runs_order check (finished_at >= started_at)
);

comment on table public.cron_runs is
  'One row per scheduled job run (jobs, newsletters). Append-only; counts only.';

create index if not exists cron_runs_job_finished_idx on public.cron_runs (job, finished_at desc);

create or replace function public.refuse_cron_run_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Scheduled job runs are a record and cannot change.' using errcode = 'CRM06';
end;
$$;

drop trigger if exists cron_runs_append_only on public.cron_runs;
create trigger cron_runs_append_only
    before update or delete on public.cron_runs
    for each row execute function public.refuse_cron_run_change();

alter table public.cron_runs enable row level security;
revoke all on public.cron_runs from anon, authenticated;
grant select on public.cron_runs to authenticated;
grant select, insert on public.cron_runs to service_role;
revoke update, delete, truncate on public.cron_runs from service_role;

drop policy if exists "Members read cron runs" on public.cron_runs;
create policy "Members read cron runs"
  on public.cron_runs for select to authenticated using (true);
drop policy if exists "Approved CRM members only" on public.cron_runs;
create policy "Approved CRM members only"
  on public.cron_runs as restrictive for all to authenticated
  using ((select public.is_crm_member())) with check ((select public.is_crm_member()));

revoke all on function public.refuse_cron_run_change() from public, anon;
