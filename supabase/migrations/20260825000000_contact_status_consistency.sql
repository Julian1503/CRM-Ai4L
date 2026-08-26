-- Keep the lifecycle enum and legacy boolean consistent for every write path.
-- `status` is canonical because filters, segments and exports all read it.

update public.contacts
set is_customer = (status = 'customer'::public.contact_status)
where is_customer is distinct from (status = 'customer'::public.contact_status);

create or replace function public.sync_contact_customer_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.deleted_at is not null then
    new.status := 'archived'::public.contact_status;
  elsif new.status = 'archived'::public.contact_status then
    new.status := 'prospect'::public.contact_status;
  end if;

  new.is_customer := (new.status = 'customer'::public.contact_status);
  return new;
end;
$$;

drop trigger if exists contacts_sync_customer_status on public.contacts;
create trigger contacts_sync_customer_status
before insert or update of status, is_customer, deleted_at
on public.contacts
for each row
execute function public.sync_contact_customer_status();
