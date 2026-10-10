-- Page content items with a current, unreviewed revision. SECURITY INVOKER keeps
-- the caller's existing RLS policies on items, variants and reviews in force.
create or replace function public.content_pending_review_items(
  p_search_pattern text,
  p_offset integer,
  p_limit integer
)
returns table (item_id uuid, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with candidates as (
    select i.id, i.created_at
    from public.content_items i
    where i.removed_at is null
      and i.archived_at is null
      and (p_search_pattern is null or i.title ilike p_search_pattern)
      and exists (
        select 1
        from public.content_variants v
        where v.item_id = i.id
          and v.archived_at is null
          and v.current_revision_id is not null
          and not exists (
            select 1 from public.content_reviews r
            where r.revision_id = v.current_revision_id
          )
      )
  )
  , tally as (select count(*) as total from candidates)
  , page as (
    select candidates.id
    from candidates
    order by candidates.created_at desc, candidates.id desc
    offset greatest(p_offset, 0)
    limit least(greatest(p_limit, 1), 200)
  )
  select page.id, tally.total from tally left join page on true;
$$;

revoke all on function public.content_pending_review_items(text, integer, integer) from public;
grant execute on function public.content_pending_review_items(text, integer, integer) to authenticated;
