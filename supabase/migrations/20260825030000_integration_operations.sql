-- Durable, privacy-minimised operational telemetry for third-party deliveries.
-- Raw webhook bodies are deliberately excluded: they can contain contact PII and are
-- already represented by provider/event counts and the idempotency ledger.

do $$
begin
  create type public.integration_delivery_status as enum (
    'processing', 'succeeded', 'completed_with_errors', 'failed'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.integration_deliveries (
    id uuid primary key default gen_random_uuid(),
    provider text not null,
    event_type text,
    status public.integration_delivery_status not null default 'processing',
    event_count integer not null default 0 check (event_count >= 0),
    processed_count integer not null default 0 check (processed_count >= 0),
    failed_count integer not null default 0 check (failed_count >= 0),
    error_code text,
    started_at timestamptz not null default timezone('utc'::text, now()),
    completed_at timestamptz,
    constraint integration_deliveries_provider_check
      check (provider in ('emailoctopus', 'stripe', 'calendly')),
    constraint integration_deliveries_counts_check
      check (processed_count + failed_count <= event_count)
);

create index if not exists integration_deliveries_provider_started_idx
    on public.integration_deliveries (provider, started_at desc);

create index if not exists integration_deliveries_open_idx
    on public.integration_deliveries (started_at)
    where status = 'processing';

alter table public.integration_deliveries enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'integration_deliveries'
      and policyname = 'Allow read access to authenticated users'
  ) then
    create policy "Allow read access to authenticated users"
      on public.integration_deliveries for select to authenticated using (true);
  end if;
end $$;

grant select on table public.integration_deliveries to authenticated;
grant select, insert, update on table public.integration_deliveries to service_role;

-- One stable database call supplies the whole panel. Aggregating in SQL avoids moving
-- delivery rows to the application and keeps the UI cost constant as history grows.
create or replace function public.get_operations_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with providers(provider) as (
    values ('emailoctopus'::text), ('stripe'::text), ('calendly'::text)
  ), integration_health as (
    select
      p.provider,
      count(d.id) filter (
        where d.started_at >= timezone('utc'::text, now()) - interval '24 hours'
      ) as deliveries_24h,
      count(d.id) filter (
        where d.status in ('failed', 'completed_with_errors')
          and d.started_at >= timezone('utc'::text, now()) - interval '24 hours'
      ) as failed_24h,
      count(d.id) filter (where d.status = 'processing') as processing,
      count(d.id) filter (
        where d.status = 'processing'
          and d.started_at < timezone('utc'::text, now()) - interval '15 minutes'
      ) as processing_stale,
      coalesce(sum(d.event_count) filter (
        where d.started_at >= timezone('utc'::text, now()) - interval '24 hours'
      ), 0) as events_24h,
      coalesce(sum(d.failed_count) filter (
        where d.started_at >= timezone('utc'::text, now()) - interval '24 hours'
      ), 0) as failed_events_24h,
      max(d.started_at) as last_delivery_at,
      max(d.completed_at) filter (where d.status = 'succeeded') as last_success_at,
      max(d.completed_at) filter (
        where d.status in ('failed', 'completed_with_errors')
      ) as last_failure_at
    from providers p
    left join public.integration_deliveries d on d.provider = p.provider
    group by p.provider
  )
  select jsonb_build_object(
    'generatedAt', timezone('utc'::text, now()),
    'integrations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'provider', provider,
          'deliveries24h', deliveries_24h,
          'failed24h', failed_24h,
          'processing', processing,
          'processingStale', processing_stale,
          'events24h', events_24h,
          'failedEvents24h', failed_events_24h,
          'lastDeliveryAt', last_delivery_at,
          'lastSuccessAt', last_success_at,
          'lastFailureAt', last_failure_at
        ) order by provider
      ) from integration_health
    ), '[]'::jsonb),
    'campaignSends', (
      select jsonb_build_object(
        'pending', count(*) filter (where status = 'pending'),
        'sent', count(*) filter (where status = 'sent'),
        'failed', count(*) filter (where status = 'failed'),
        'skipped', count(*) filter (where status = 'skipped')
      ) from public.campaign_sends
    ),
    'bookings', (
      select jsonb_build_object(
        'pending', count(*) filter (where status = 'pending'),
        'checkoutStarted', count(*) filter (where status = 'checkout_started'),
        'paid', count(*) filter (where status = 'paid'),
        'booked', count(*) filter (where status = 'booked'),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'expired', count(*) filter (where status = 'expired')
      ) from public.bookings
    ),
    'sync', (
      select jsonb_build_object(
        'events24h', count(*) filter (
          where created_at >= timezone('utc'::text, now()) - interval '24 hours'
        ),
        'failures24h', count(*) filter (
          where status = 'failed'
            and created_at >= timezone('utc'::text, now()) - interval '24 hours'
        ),
        'latestAt', max(created_at)
      ) from public.sync_logs
    )
  );
$$;

revoke all on function public.get_operations_summary() from public, anon;
grant execute on function public.get_operations_summary() to authenticated;
