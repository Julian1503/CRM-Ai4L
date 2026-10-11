-- Evaluate the membership check once per query, not once per row.
--
-- Every public table carries the restrictive policy "Approved CRM members only"
-- (20261002000100) with `using (public.is_crm_member())`. Postgres treats a bare
-- function call in a policy as row-dependent and runs it for every row the query
-- touches: counting 47,000 contacts as a member took ~2 s (EXPLAIN: `Filter:
-- is_crm_member()` on every row), and the dashboard's six counts plus a contact search
-- running together exceeded the authenticated role's 8 s statement timeout — the
-- contact list and the counters then failed ("canceling statement due to statement
-- timeout"), and a spreadsheet upload queued behind them long enough to look hung.
--
-- Wrapped in a scalar sub-select, the call becomes an InitPlan: evaluated once per query
-- and reused (Supabase's documented RLS performance pattern). The same count takes ~5 ms
-- and a four-column ILIKE search ~80 ms. The meaning of every policy is unchanged —
-- is_crm_member()/is_crm_admin() depend only on the caller (auth.uid()), never on the row.
--
-- Applied to every existing policy in `public` and `storage` that calls is_crm_member(),
-- is_crm_admin() or auth.uid() directly. Idempotent: an expression that already contains
-- a sub-select is left alone. A later migration that (re)creates a membership policy
-- should write it in the wrapped form: `using ((select public.is_crm_member()))`.

do $$
declare
  v_policy record;
  v_using  text;
  v_check  text;
begin
  for v_policy in
    select n.nspname as schema_name, c.relname as table_name, p.polname as policy_name,
           pg_get_expr(p.polqual, p.polrelid) as using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'storage')
  loop
    v_using := v_policy.using_expr;
    v_check := v_policy.check_expr;

    if v_using is not null and v_using !~* 'select' and v_using ~ '(is_crm_member|is_crm_admin|auth\.uid)\(\)' then
      v_using := regexp_replace(v_using, '(public\.)?\mis_crm_member\(\)', '(select public.is_crm_member())', 'g');
      v_using := regexp_replace(v_using, '(public\.)?\mis_crm_admin\(\)', '(select public.is_crm_admin())', 'g');
      v_using := regexp_replace(v_using, '\mauth\.uid\(\)', '(select auth.uid())', 'g');
    else
      v_using := null;
    end if;

    if v_check is not null and v_check !~* 'select' and v_check ~ '(is_crm_member|is_crm_admin|auth\.uid)\(\)' then
      v_check := regexp_replace(v_check, '(public\.)?\mis_crm_member\(\)', '(select public.is_crm_member())', 'g');
      v_check := regexp_replace(v_check, '(public\.)?\mis_crm_admin\(\)', '(select public.is_crm_admin())', 'g');
      v_check := regexp_replace(v_check, '\mauth\.uid\(\)', '(select auth.uid())', 'g');
    else
      v_check := null;
    end if;

    if v_using is not null then
      execute format('alter policy %I on %I.%I using (%s)',
                     v_policy.policy_name, v_policy.schema_name, v_policy.table_name, v_using);
    end if;
    if v_check is not null then
      execute format('alter policy %I on %I.%I with check (%s)',
                     v_policy.policy_name, v_policy.schema_name, v_policy.table_name, v_check);
    end if;
  end loop;
end;
$$;
