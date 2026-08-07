-- Create credentials table for key-value system settings
create table if not exists public.credentials (
    key text primary key,
    value text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create sync_logs table to hold history events
create table if not exists public.sync_logs (
    id uuid primary key default gen_random_uuid(),
    event_text text not null,
    status text not null, -- 'success', 'failed', 'info'
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.credentials enable row level security;
alter table public.sync_logs enable row level security;

-- Policies for credentials (Authenticated Users)
create policy "Allow read access to authenticated users" 
    on public.credentials for select to authenticated using (true);

create policy "Allow insert access to authenticated users" 
    on public.credentials for insert to authenticated with check (true);

create policy "Allow update access to authenticated users" 
    on public.credentials for update to authenticated using (true) with check (true);

create policy "Allow delete access to authenticated users" 
    on public.credentials for delete to authenticated using (true);

-- Policies for sync_logs (Authenticated Users)
create policy "Allow read access to authenticated users" 
    on public.sync_logs for select to authenticated using (true);

create policy "Allow insert access to authenticated users" 
    on public.sync_logs for insert to authenticated with check (true);
