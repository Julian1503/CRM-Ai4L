-- Mint campaign booking links without granting authenticated users direct INSERT
-- access to bookings. The send route runs with the operator's session, while the
-- bookings table deliberately accepts writes only through controlled server paths.

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
  if auth.role() <> 'authenticated' then
    raise exception 'An authenticated operator is required.' using errcode = '42501';
  end if;

  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid booking token hash.' using errcode = '22023';
  end if;

  if p_expires_at <= now() or p_expires_at > now() + interval '31 days' then
    raise exception 'Invalid booking expiry.' using errcode = '22023';
  end if;

  -- The row can only be minted while the authenticated send pipeline owns a pending
  -- ledger entry. This keeps the RPC from becoming a general free-consultation API.
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
