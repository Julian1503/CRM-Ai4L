-- Verification for 20260825030000_integration_operations.sql.
-- Non-destructive: fixtures and telemetry are rolled back.

begin;

do $$
declare
  v_summary jsonb;
  v_columns text[];
begin
  assert to_regclass('public.integration_deliveries') is not null,
         'integration_deliveries table missing';

  assert (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'integration_delivery_status') = 4,
         'integration_delivery_status should have four labels';

  select array_agg(column_name order by column_name) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'integration_deliveries';

  assert not (v_columns && array['payload', 'raw_body', 'email', 'secret']),
         'integration delivery telemetry contains a prohibited PII/secret column';

  assert (select relrowsecurity from pg_class
          where oid = 'public.integration_deliveries'::regclass),
         'RLS is not enabled on integration_deliveries';

  assert (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'integration_deliveries'
            and cmd = 'SELECT') = 1,
         'authenticated users need one read-only delivery policy';

  assert (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'integration_deliveries'
            and cmd in ('INSERT', 'UPDATE', 'DELETE')) = 0,
         'authenticated users must not mutate provider delivery traces';

  insert into public.integration_deliveries (
    provider, event_type, status, event_count, processed_count, failed_count, completed_at
  ) values (
    'stripe', 'checkout.session.completed', 'succeeded', 1, 1, 0, now()
  );

  select public.get_operations_summary() into v_summary;

  assert jsonb_typeof(v_summary -> 'integrations') = 'array',
         'operations summary integrations must be an array';
  assert jsonb_array_length(v_summary -> 'integrations') = 3,
         'operations summary should always include all three providers';
  assert v_summary ? 'campaignSends' and v_summary ? 'bookings' and v_summary ? 'sync',
         'operations summary is missing one or more funnel aggregates';

  raise notice 'ALL INTEGRATION OPERATIONS CHECKS PASSED';
end $$;

rollback;
