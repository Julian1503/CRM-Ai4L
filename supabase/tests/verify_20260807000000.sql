-- Verification for migration 20260807000000_soft_delete_and_segmentation.sql
--
-- Non-destructive: the whole script runs inside a transaction that is ROLLED BACK at
-- the end, so it is safe against any environment that already has the migration applied.
--
-- Run with either:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/verify_20260807000000.sql
--   supabase db execute --file supabase/tests/verify_20260807000000.sql
-- Or paste into the Supabase SQL editor.
--
-- Success = "ALL PHASE 0.1 CHECKS PASSED". Any failure raises and aborts.

begin;

-- Isolate from real data: every fixture uses the suffix `__p0verify`, and the whole
-- script rolls back regardless.
--
-- Deliberately no `\set`: this runs through `supabase db query --linked`, which posts
-- SQL to the Management API rather than piping it through psql, so psql meta-commands
-- are a syntax error there. Keeping the suffix inline costs nothing and lets the same
-- file run over either transport.

do $$
declare
  v_count      int;
  v_result     jsonb;
  v_contact_id uuid;
  v_org_id     uuid;
  v_status     public.contact_status;
  v_failed     boolean;
begin
  ----------------------------------------------------------------------------
  raise notice '1. schema objects exist';
  ----------------------------------------------------------------------------
  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='contacts' and column_name='deleted_at') = 1,
         'contacts.deleted_at missing';

  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='contacts' and column_name='status') = 1,
         'contacts.status missing';

  assert (select count(*) from information_schema.columns
          where table_schema='public' and table_name='contacts' and column_name='job_type_id') = 1,
         'contacts.job_type_id missing';

  assert (select count(*) from pg_class where relname='job_types' and relkind='r') = 1,
         'job_types table missing';

  assert (select count(*) from pg_class where relname='active_contacts' and relkind='v') = 1,
         'active_contacts view missing';

  assert (select count(*) from pg_indexes
          where schemaname='public' and indexname='contacts_email_active_idx') = 1,
         'partial unique index contacts_email_active_idx missing';

  ----------------------------------------------------------------------------
  raise notice '2. old full UNIQUE(email) constraint is gone';
  ----------------------------------------------------------------------------
  select count(*) into v_count
  from pg_constraint con
  where con.conrelid = 'public.contacts'::regclass
    and con.contype = 'u'
    and con.conkey = array[
      (select attnum from pg_attribute
       where attrelid='public.contacts'::regclass and attname='email')
    ];
  assert v_count = 0,
    'a full UNIQUE(email) constraint still exists - archived emails cannot be reused';

  ----------------------------------------------------------------------------
  raise notice '3. archived contact does not block reusing its email';
  ----------------------------------------------------------------------------
  insert into public.contacts (first_name, last_name, email, deleted_at)
  values ('Archived', 'Person', 'reuse__p0verify@example.com', now())
  returning id into v_contact_id;

  -- Must succeed: the live index ignores the archived row.
  insert into public.contacts (first_name, last_name, email)
  values ('Live', 'Person', 'reuse__p0verify@example.com');

  assert (select count(*) from public.contacts
          where email='reuse__p0verify@example.com') = 2,
         'expected one archived + one live contact sharing an email';

  ----------------------------------------------------------------------------
  raise notice '4. two LIVE contacts cannot share an email';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    insert into public.contacts (first_name, last_name, email)
    values ('Dup', 'Person', 'reuse__p0verify@example.com');
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed, 'duplicate LIVE email was allowed - partial unique index is not working';

  ----------------------------------------------------------------------------
  raise notice '5. active_contacts view hides archived rows';
  ----------------------------------------------------------------------------
  assert (select count(*) from public.active_contacts
          where email='reuse__p0verify@example.com') = 1,
         'active_contacts should expose exactly the live row';

  ----------------------------------------------------------------------------
  raise notice '6. status backfill is consistent with is_customer';
  ----------------------------------------------------------------------------
  select count(*) into v_count
  from public.contacts
  where deleted_at is null
    and ((is_customer and status <> 'customer')
      or (not is_customer and status not in ('prospect', 'lead')));
  assert v_count = 0,
    format('%s contacts have status inconsistent with is_customer', v_count);

  ----------------------------------------------------------------------------
  raise notice '7. import_contacts inserts, and creates org + job type';
  ----------------------------------------------------------------------------
  select public.import_contacts($json$[
    {"email":"imp1__p0verify@example.com","first_name":"Ada","last_name":"Lovelace",
     "organisation_name":"Analytical Engines __p0verify","job_type_name":"Electrician __p0verify",
     "state":"NSW","is_customer":false,"subscribed_to_newsletter":true}
  ]$json$::jsonb) into v_result;

  assert (v_result->>'inserted')::int = 1, format('expected 1 inserted, got %s', v_result);
  assert (v_result->>'updated')::int  = 0, format('expected 0 updated, got %s', v_result);

  assert (select count(*) from public.job_types
          where lower(btrim(name)) = lower('Electrician __p0verify')) = 1,
         'import_contacts did not create the job type';

  assert (select count(*) from public.organisations
          where lower(btrim(name)) = lower('Analytical Engines __p0verify')) = 1,
         'import_contacts did not create the organisation';

  assert (select job_type_id is not null and organisation_id is not null
          from public.contacts where email='imp1__p0verify@example.com'),
         'imported contact was not linked to its job type / organisation';

  ----------------------------------------------------------------------------
  raise notice '8. import_contacts updates on re-import, does not duplicate';
  ----------------------------------------------------------------------------
  select public.import_contacts($json$[
    {"email":"imp1__p0verify@example.com","first_name":"Ada","last_name":"Byron",
     "state":"VIC","is_customer":true,"subscribed_to_newsletter":false}
  ]$json$::jsonb) into v_result;

  assert (v_result->>'inserted')::int = 0, format('expected 0 inserted, got %s', v_result);
  assert (v_result->>'updated')::int  = 1, format('expected 1 updated, got %s', v_result);

  assert (select count(*) from public.contacts
          where email='imp1__p0verify@example.com') = 1,
         'reimport created a duplicate instead of updating';

  select status into v_status from public.contacts where email='imp1__p0verify@example.com';
  assert v_status = 'customer', format('status should follow is_customer, got %s', v_status);

  -- coalesce semantics: omitted fields must not be nulled out
  assert (select organisation_id is not null
          from public.contacts where email='imp1__p0verify@example.com'),
         'reimport without organisation_name wiped the existing organisation link';

  ----------------------------------------------------------------------------
  raise notice '9. import_contacts de-duplicates within a single batch';
  ----------------------------------------------------------------------------
  -- Without DISTINCT ON this raises "ON CONFLICT cannot affect row a second time".
  select public.import_contacts($json$[
    {"email":"dupe__p0verify@example.com","first_name":"First","last_name":"Win"},
    {"email":"DUPE__p0verify@example.com","first_name":"Second","last_name":"Lose"}
  ]$json$::jsonb) into v_result;

  assert (v_result->>'inserted')::int = 1,
         format('batch duplicates should collapse to 1 insert, got %s', v_result);
  assert (select first_name from public.contacts
          where email='dupe__p0verify@example.com') = 'First',
         'first occurrence should win within a batch';

  ----------------------------------------------------------------------------
  raise notice '10. import_contacts skips rows missing required fields';
  ----------------------------------------------------------------------------
  select public.import_contacts($json$[
    {"email":"ok__p0verify@example.com","first_name":"Valid","last_name":"Row"},
    {"email":"","first_name":"No","last_name":"Email"},
    {"email":"noname__p0verify@example.com","first_name":"","last_name":""}
  ]$json$::jsonb) into v_result;

  assert (v_result->>'inserted')::int = 1, format('expected 1 inserted, got %s', v_result);
  assert (v_result->>'skipped')::int  = 2, format('expected 2 skipped, got %s', v_result);
  assert (v_result->>'total')::int    = 3, format('expected total 3, got %s', v_result);

  ----------------------------------------------------------------------------
  raise notice '11. import_contacts rejects a non-array payload';
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    perform public.import_contacts('{"email":"x@example.com"}'::jsonb);
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'import_contacts accepted a JSON object instead of an array';

  ----------------------------------------------------------------------------
  raise notice '12. import_contacts does not resurrect an archived contact';
  ----------------------------------------------------------------------------
  insert into public.contacts (first_name, last_name, email, deleted_at)
  values ('Old', 'Record', 'revive__p0verify@example.com', now());

  select public.import_contacts($json$[
    {"email":"revive__p0verify@example.com","first_name":"New","last_name":"Record"}
  ]$json$::jsonb) into v_result;

  assert (v_result->>'inserted')::int = 1,
         'importing an archived email should create a new live row';
  assert (select count(*) from public.contacts
          where email='revive__p0verify@example.com' and deleted_at is not null) = 1,
         'the archived row must stay archived';
  assert (select count(*) from public.active_contacts
          where email='revive__p0verify@example.com') = 1,
         'exactly one live row expected after importing an archived email';

  ----------------------------------------------------------------------------
  raise notice '13. organisation names are unique case-insensitively';
  ----------------------------------------------------------------------------
  v_failed := false;
  insert into public.organisations (name) values ('CaseTest __p0verify') returning id into v_org_id;
  begin
    insert into public.organisations (name) values ('casetest __P0VERIFY');
  exception when unique_violation then
    v_failed := true;
  end;
  assert v_failed, 'organisations should be unique case-insensitively';

  raise notice '';
  raise notice 'ALL PHASE 0.1 CHECKS PASSED';
end $$;

rollback;
