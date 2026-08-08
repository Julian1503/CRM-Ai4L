-- Phase 5 — consultation bookings.
--
-- Flow: campaign email → /book/{token} → Stripe Checkout ($500 list, 100%-off promotion
-- code, $0 charged) → checkout.session.completed → Calendly (prefilled) →
-- invitee.created → this row completed.
--
-- The row is created when a campaign is sent, then advanced by two independent webhooks.
-- Both can arrive out of order or more than once, so every transition is written to be
-- idempotent rather than assuming a sequence.

do $$
begin
  create type public.booking_status as enum (
    'pending',           -- link minted, not yet opened
    'checkout_started',  -- Stripe Checkout session created
    'paid',              -- checkout.session.completed received ($0)
    'booked',            -- Calendly invitee.created received
    'cancelled',         -- invitee.canceled, or cancelled by staff
    'expired'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.bookings (
    id uuid primary key default gen_random_uuid(),

    -- SHA-256 of the token that appears in the email link. The raw token is never
    -- stored, so a database leak yields no working booking links.
    token_hash text not null,

    contact_id uuid not null references public.contacts(id) on delete cascade,
    campaign_id uuid references public.campaigns(id) on delete set null,

    status public.booking_status not null default 'pending',
    expires_at timestamptz not null,
    -- Set the moment the link is acted on, which is what makes it single-use.
    consumed_at timestamptz,

    stripe_session_id text,
    stripe_promotion_code_id text,

    calendly_event_uri text,
    calendly_invitee_uri text,
    scheduled_at timestamptz,
    cancelled_at timestamptz,

    -- Recorded on the booking itself so the "$500 value, $0 charged" position is
    -- evidenced per booking rather than inferred from whatever Stripe is configured
    -- with at the time someone asks.
    list_amount_cents integer not null default 50000,
    charged_amount_cents integer,
    currency text not null default 'AUD',

    created_at timestamptz not null default timezone('utc'::text, now()),
    updated_at timestamptz not null default timezone('utc'::text, now())
);

create unique index if not exists bookings_token_hash_idx on public.bookings (token_hash);
create index if not exists bookings_contact_idx on public.bookings (contact_id);
create index if not exists bookings_status_idx on public.bookings (status);

-- Maps a Stripe session back to exactly one booking. Unique so a replayed
-- checkout.session.completed cannot attach to a second row.
create unique index if not exists bookings_stripe_session_idx
    on public.bookings (stripe_session_id) where stripe_session_id is not null;

create unique index if not exists bookings_calendly_invitee_idx
    on public.bookings (calendly_invitee_uri) where calendly_invitee_uri is not null;

alter table public.bookings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'bookings'
      and policyname = 'Allow read access to authenticated users'
  ) then
    create policy "Allow read access to authenticated users"
      on public.bookings for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'bookings'
      and policyname = 'Allow update access to authenticated users'
  ) then
    create policy "Allow update access to authenticated users"
      on public.bookings for update to authenticated using (true) with check (true);
  end if;
end $$;

-- Writes from the booking page and both webhooks go through the service-role client,
-- which bypasses RLS. No insert policy is granted to authenticated users: bookings are
-- minted by the send pipeline, never by hand.
