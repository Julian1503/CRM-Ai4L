-- Enable pgcrypto for gen_random_uuid() if needed
create extension if not exists "pgcrypto";

-- Create organisations table
create table public.organisations (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    industry text,
    type text,
    size text,
    website text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create contacts table
create table public.contacts (
    id uuid primary key default gen_random_uuid(),
    first_name text not null,
    last_name text not null,
    preferred_name text,
    email text not null unique,
    mobile_number text,
    work_phone text,
    address text,
    suburb text,
    state text,
    postcode text,
    country text,
    organisation_id uuid references public.organisations(id) on delete set null,
    department text,
    position text,
    notes text,
    is_customer boolean default false not null,
    subscribed_to_newsletter boolean default false not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create services table
create table public.services (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create contact_services join table (many-to-many relationship)
create table public.contact_services (
    contact_id uuid references public.contacts(id) on delete cascade,
    service_id uuid references public.services(id) on delete cascade,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    primary key (contact_id, service_id)
);

-- Enable Row Level Security (RLS) on all tables
alter table public.organisations enable row level security;
alter table public.contacts enable row level security;
alter table public.services enable row level security;
alter table public.contact_services enable row level security;

-- Create Policies for Organisations (Authenticated Users)
create policy "Allow read access to authenticated users" 
    on public.organisations for select to authenticated using (true);
create policy "Allow insert access to authenticated users" 
    on public.organisations for insert to authenticated with check (true);
create policy "Allow update access to authenticated users" 
    on public.organisations for update to authenticated using (true) with check (true);
create policy "Allow delete access to authenticated users" 
    on public.organisations for delete to authenticated using (true);

-- Create Policies for Contacts (Authenticated Users)
create policy "Allow read access to authenticated users" 
    on public.contacts for select to authenticated using (true);
create policy "Allow insert access to authenticated users" 
    on public.contacts for insert to authenticated with check (true);
create policy "Allow update access to authenticated users" 
    on public.contacts for update to authenticated using (true) with check (true);
create policy "Allow delete access to authenticated users" 
    on public.contacts for delete to authenticated using (true);

-- Create Policies for Services (Authenticated Users)
create policy "Allow read access to authenticated users" 
    on public.services for select to authenticated using (true);
create policy "Allow insert access to authenticated users" 
    on public.services for insert to authenticated with check (true);
create policy "Allow update access to authenticated users" 
    on public.services for update to authenticated using (true) with check (true);
create policy "Allow delete access to authenticated users" 
    on public.services for delete to authenticated using (true);

-- Create Policies for Contact Services (Authenticated Users)
create policy "Allow read access to authenticated users" 
    on public.contact_services for select to authenticated using (true);
create policy "Allow insert access to authenticated users" 
    on public.contact_services for insert to authenticated with check (true);
create policy "Allow update access to authenticated users" 
    on public.contact_services for update to authenticated using (true) with check (true);
create policy "Allow delete access to authenticated users" 
    on public.contact_services for delete to authenticated using (true);
