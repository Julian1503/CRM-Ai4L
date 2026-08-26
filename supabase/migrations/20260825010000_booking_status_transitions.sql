-- Enforce the booking funnel in the database, not only in individual webhooks.

create or replace function public.enforce_booking_status_transition()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  allowed public.booking_status[];
begin
  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'pending' then array['checkout_started', 'paid', 'cancelled', 'expired']::public.booking_status[]
    when 'checkout_started' then array['paid', 'cancelled', 'expired']::public.booking_status[]
    when 'paid' then array['booked', 'cancelled']::public.booking_status[]
    when 'booked' then array['cancelled']::public.booking_status[]
    else array[]::public.booking_status[]
  end;

  if not (new.status = any(allowed)) then
    raise exception 'Invalid booking status transition: % -> %', old.status, new.status;
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_enforce_status_transition on public.bookings;
create trigger bookings_enforce_status_transition
before update of status on public.bookings
for each row
execute function public.enforce_booking_status_transition();
