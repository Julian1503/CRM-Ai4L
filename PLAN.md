# Implementation Plan — Database & Marketing Agent

Status as of 2026-08-07. Companion to `PRODUCT.md` (brand/UX) and `AGENTS.md` (Next.js 16 rules).
Covers only the **partial** and **from-scratch** scope items. Completed items (contact schema,
spreadsheet import, status filter tabs, contact CRUD, dashboard) are not repeated here.

---

## Progress

| Phase | Status |
|---|---|
| 0 — Foundations | **Complete** (SQL unverified — see below) |
| 1.1 — Auth | **Code complete**, unauthenticated paths verified; signed-in paths blocked |
| 1.2 — Deploy | **Blocked** — needs your Vercel account and DNS |
| 2.2 — Filters | **Complete** (job type, state, status, search) |
| 2.3 — CSV export | **Complete** (two formats, filter-aware, injection-safe) |
| 2.4 — Soft delete | **Complete** (archive API + UI; no hard-delete path remains) |
| 2.1 — `page.tsx` decomposition | **Deferred** — see below |
| 3 — Newsletter intake | **Complete** (signature + idempotency + v2 client) |
| 4.1 — Segments | **Complete** |
| 4.2 — Approval workflow | **Complete** (status machine enforced in the database) |
| 4.3 — Send pipeline | **Complete** (adapter, rate limiter, resumable ledger) |
| 4.4 — Segment & campaign API | **Complete** (8 routes, session-checked) |
| 4.5 — Campaigns UI | **Complete** (unverified against a live database) |
| 4.6 — AI copy generation | **On hold** — pending merge-field ceiling check |
| 5.1 — Booking tokens | **Complete** |
| 5.2 — Stripe checkout | **Complete** (unverified against a live account) |
| 5.3 — Calendly | **Complete** (needs a paid Calendly plan to function) |
| 6 — Hardening | **Complete** (a11y/visual regression partly blocked) |
| Gap closure | **Complete** — booking links wired; archive screen shipped |

**Gap closure (post-Phase 6):** `createBooking()` existed and was tested but had **zero
production callers** — the campaign send never minted booking tokens, so requirement 3.3
("emails route recipients to book a consultation") did not work end to end. Both halves
were built; the join was missing. Now each recipient gets a personal single-use link in
the `BookingUrl` merge field. Also shipped the archive screen (`/api/contacts` +
`ArchiveView`), completing "records archived, not permanently removed" — archiving
worked, but nothing in the UI listed or restored them.

⚠️ **EmailOctopus setup required for booking links to work:** the list needs a custom
field tagged `BookingUrl`, and the automation template must reference `{{BookingUrl}}`.
Without both, the email sends with an empty link and the funnel silently does nothing.
`NEXT_PUBLIC_APP_URL` must also be set to the deployed origin.

**A real runtime bug found by E2E, not by the build or unit tests:** `login/actions.ts`
exported `INITIAL_LOGIN_STATE`, a plain object, from a `'use server'` module. Next.js
rejects that at runtime — *"A 'use server' file can only export async functions"* — and
the whole module fails to evaluate, taking the login page with it. **The login page had
been broken since Phase 1.** It survived because the build does not check it, Jest
imports the module without the Server Actions transform, and the E2E skip guard treated
a crashed page as "Supabase not configured" and skipped. Fixed by moving the constant to
`login/state.ts`; a structural test now asserts every `'use server'` module exports only
async functions, and the E2E guard asserts the page rendered before deciding to skip.

**Phase 6 delivered:** `src/lib/security.test.ts` — structural invariants asserting every
API route authenticates, every webhook verifies its signature and reads the raw body,
service-role usage stays confined to sessionless routes, and authenticated responses are
uncacheable · label/input association across `ContactDrawer` · README rewritten from the
create-next-app stub · GitHub Actions CI enforcing the whole gate.
Gate: 679 unit tests green, lint 0 errors, typecheck clean, build clean, 22 E2E green.
Coverage 87.4% statements / 79.7% branches / 71.9% functions.

**The structural security test found three real defects on its first run:**
1. `/api/locations/autocomplete` had **no session check** — it proxies to Geoapify with
   the client's API key, so anyone reaching it could burn their quota. `proxy.ts` gated
   it, but that is the optimistic layer only.
2. `/api/import/parse` returned parsed spreadsheet contents with no `no-store`.
3. `/api/integrations/emailoctopus/sync` echoed contact email addresses in its error
   list, also cacheable.
All three fixed. This is the class of failure that is silent — no throw, no failing
test, nothing obviously wrong in review.

**Accessibility:** every field in `ContactDrawer` was unlabelled for assistive
technology — labels were siblings with no `htmlFor` (WCAG 1.3.1 / 3.3.2). Fixed for all
15 fields and pinned by tests. `LoginForm` already carried correct `aria-invalid` /
`aria-describedby`, now covered.

**Not delivered, and why:** automated axe scans and visual-regression baselines at
320/768/1024/1440 were scoped for this phase. They are only meaningful against rendered
authenticated screens, which cannot be reached — the signed-in E2E specs skip for want
of a Supabase account. Capturing baselines from the two public pages alone would give
false confidence. Do this with the deferred `page.tsx` decomposition, once sign-in works.

**Coverage:** statements and lines now exceed the 80% project standard. Branches (79.7%)
and functions (71.9%) do not, and the shortfall is concentrated in `src/app/page.tsx` at
42% function coverage. Raising those means doing the Phase 2.1 decomposition, not
writing more tests around a component that resists them.

**Phase 5 delivered:** `bookings` schema · `src/lib/booking/token.ts` (single-use,
expiring, hashed) + `repository.ts` · `src/lib/stripe/` (config, $500→$0 checkout) ·
`/api/booking/create-session` · `/api/stripe/webhook` · `/api/calendly/webhook` ·
lead-facing `/book/[token]` and `/book/[token]/scheduled`.
Gate: 585 unit tests green, lint 0 errors, typecheck clean, build clean, 22 E2E green.

Design decisions worth reviewing:
- **A single 100%-off coupon, not per-lead promotion codes.** The plan called for a
  promotion code per lead with `max_redemptions: 1`; that is redundant because single
  use is already enforced by the booking token, checked before a session is created.
  One reusable coupon avoids an extra API call and an extra object per recipient.
- **The link is consumed when checkout starts, not when payment completes.** A forwarded
  copy therefore cannot open a second checkout even if the first is abandoned.
- **`payment_intent_data` is deliberately not set.** At a $0 total Stripe creates no
  PaymentIntent, so passing it may be rejected. The booking id travels in session
  metadata, which is always present.
- **`/book` and `/api/booking` are public.** The visitor is a lead with no CRM account;
  the booking token is the credential. Prefix-collision tests guard `/bookkeeping` and
  `/api/bookings`.

Unverified against live services (no Stripe or Calendly account was available):
- the Stripe Checkout call shape, and whether a 100%-off session behaves as expected
  at $0;
- the Calendly payload shape, and whether `utm_content` reliably returns under
  `tracking` — there is an email fallback for when it does not.

⚠️ **Calendly webhooks require a paid plan (Standard or above).** Without one no
`invitee.created` ever arrives and bookings stay stuck at `paid` — the appointment
happens but the CRM never records it. Confirm the client's plan before go-live.

**Phase 4 delivered:** `segments` / `campaigns` / `campaign_sends` schema with the status
machine enforced by a database trigger · `src/lib/marketing/segments.ts` (reuses the
Phase 2 filter vocabulary; forces subscribed-only) · `campaignStatus.ts` ·
`providers/types.ts` adapter boundary + `providers/emailOctopus.ts` ·
`rateLimiter.ts` (token bucket matching 100 @ 10/sec) · `send.ts` (resumable,
deduplicated, chunkable fan-out).
Plus `/api/segments`, `/api/segments/preview`, `/api/campaigns`,
`/api/campaigns/[id]` (GET/PATCH), `/api/campaigns/[id]/approve`,
`/api/campaigns/[id]/send`, and a Campaigns workspace in the sidebar.
Gate: 492 unit tests green, lint 0 errors, typecheck clean, build clean, 17 E2E green.

The UI surfaces the provider constraint rather than hiding it: the screen states that
the email is authored in EmailOctopus as a "Started via API" automation, shows live
audience size, and shows the estimated send duration *before* approval — because with a
per-contact send, audience size translates directly into wall clock.

PATCH deliberately refuses to set `approved`, `sending`, `sent` or `failed`. Those have
dedicated endpoints so approval stays attributed and the irreversible step stays
guarded; allowing them through a generic edit would let an ordinary field update smuggle
a campaign past the human gate.

**AI generation is on hold, correctly.** It is coupled to the provider answer, not
independent of it: with `canSupplyBody: false` the only content route is contact custom
fields merged into a UI-authored template, so there is no HTML body for a model to
generate. Before shaping it, confirm on a free account (30–60 min):
1. the merge-field ceiling — how many custom fields, and their length limits;
2. whether automation sends surface in **any** report (currently recorded as
   `perSendReporting: 'unknown'`, deliberately not guessed).

If full API-driven campaign creation is a hard requirement, this becomes a provider
selection decision — the adapter boundary is what keeps that swap contained.

**Phase 3 delivered:** `src/lib/webhooks/verify.ts` (HMAC + replay window +
constant-time compare) · `idempotency.ts` + `webhook_events` ledger ·
`src/lib/contacts/newsletter.ts` (creates contacts, not just updates) · rewritten
webhook route · EmailOctopus **v2** client with 429/5xx retry · session checks added to
the sync and import routes.
Gate: 355 unit tests green, **lint green for the first time (0 errors)**, typecheck
clean, build clean, 12 E2E green.

Two things in Phase 3 are written against documented behaviour but **never exercised
against the real services**, because no API key or webhook secret was available:
- the EmailOctopus **webhook signature header name and encoding** (`verify.ts`)
- the **v2 API contract** — endpoint, `status` vocabulary, error body (`emailOctopus.ts`)

Both are isolated to a single file each and flagged in-code. Confirm against
EmailOctopus documentation before go-live; a wrong signature format means every real
webhook is rejected (fails closed, which is the safe direction, but it will look like
the integration is simply broken).

**Phase 2 delivered:** `src/lib/csv.ts` (RFC 4180 + formula-injection defence) ·
`src/lib/contacts/query.ts` (validated filter parsing, PostgREST injection defence) ·
`repository.ts` (archive/restore, bounded queries) · `export.ts` (two column sets) ·
`/api/contacts/export` · `/api/contacts/[id]` archive+restore · `FilterBar` with job
type and state controls · hard delete removed.
Gate: 277 unit tests green, typecheck clean, lint clean, build clean, 11 E2E green.

### Deferred: 2.1 page.tsx decomposition

The plan required E2E coverage of current behaviour *before* refactoring. Those specs
exist but **skip**, because there is no Supabase project to sign in against — so the
safety net the refactor depends on does not currently exist. Rewriting a 1,300-line
component with no database, no working dev hydration, and no runnable UI tests would be
changing code that cannot be observed.

What was done instead, without the refactor:
- Filtering, export and archival all live in tested modules under `src/lib/contacts/`,
  so the decomposition later becomes a move rather than a rewrite.
- `FilterBar` is extracted, which is the first slice of it.
- The export endpoint parses the *same* filter vocabulary the UI serialises, so
  "export what I'm looking at" holds without the UI owning query logic.

Still outstanding in 2.1: real routes per view, server-rendered contact list reading
`await searchParams`, pagination UI, and an archive screen (the archive/restore **API**
is done and tested; only the page is missing). Do this once sign-in works.

**Phase 1 delivered:** `src/proxy.ts` session gate · `src/lib/auth/` (DAL, route rules,
open-redirect sanitiser, credential validation) · login page + Server Action · POST
logout + sidebar control · security headers · robots exclusion.
Gate: 149 unit tests green, typecheck clean, production build clean, 8 E2E green.

### Blocked: there is no Supabase project

Every value in `.env.local` is empty except `GEOAPIFY_API_KEY`. The CRM has never
connected to a database, so there is no account to sign in with and the authenticated
half of Phase 1 cannot be verified. **9 E2E specs skip** with an explicit reason rather
than passing vacuously.

To unblock, in order:

1. Create a Supabase project. Put the URL, anon key, and service-role key in
   `.env.local` (template: `.env.local.example`).
2. Apply the migrations, then run `npm run db:verify` — the Phase 0 SQL has still never
   been executed anywhere.
3. In the Supabase dashboard: **disable public sign-ups** (the CRM is invite-only, and
   nothing in the app enforces that — it is a project setting), then invite your user.
4. Set Site URL and the redirect allowlist to the deployment domain, or login silently
   fails on preview builds.
5. Export `E2E_EMAIL` / `E2E_PASSWORD` to switch the 9 skipped specs on.

Phase 1.2 additionally needs a Vercel account, the exact subdomain, and DNS access.

**Phase 0 delivered:** migration `20260807000000` (soft delete, job types, contact status,
`import_contacts` RPC) · three Supabase clients with credential isolation · DB types ·
`src/e2e/` created with 5 passing specs · coverage ratchet · test factories and fixtures.
Gate: 51 unit tests green, typecheck clean, production build clean, 5 E2E green.

**Two things need your attention:**

1. **The migration SQL has not been executed.** Docker isn't running, so no local Supabase
   was available. `supabase/tests/verify_20260807000000.sql` contains 13 assertions covering
   every behaviour the migration claims; run `npm run db:verify` (or paste it into the
   Supabase SQL editor) against a branch DB before trusting it. It rolls back, so it is safe
   to run anywhere.
2. **`next dev` does not hydrate on this machine.** The client bundle loads but React never
   attaches — no fiber keys on any DOM node — so every click in dev is a no-op. It survives
   a cleared `.next`, produces no console or page errors, and correlates with a failing HMR
   WebSocket handshake (`ERR_INVALID_HTTP_RESPONSE`). `next build` + `next start` hydrates
   correctly. Environment issue rather than an app defect, but it makes dev unusable for any
   interactive work, so it is worth chasing before Phase 1.

## 0. Locked decisions

| Decision | Choice |
|---|---|
| Booking + payment | In-app Stripe Checkout ($500 price, 100%-off promo → $0) then Calendly |
| Campaign copy | AI-generated per segment, **human approval gate before send** |
| Auth | Supabase Auth, invite-only, cookie sessions via `@supabase/ssr` |
| Hosting | Vercel + custom subdomain |

## 1. Platform constraints that shape every task

These come from reading `node_modules/next/dist/docs/` for the pinned Next **16.2.7**. They differ
from common Next.js knowledge and are the most likely source of wasted time.

| Constraint | Impact |
|---|---|
| `middleware.ts` → **`proxy.ts`** | Auth gate lives in root `proxy.ts`, exporting a function named `proxy`. Codemod: `npx @next/codemod@canary middleware-to-proxy .` |
| Proxy defaults to **Node.js runtime** | `runtime` config is **not allowed** in proxy — setting it throws. Node APIs (crypto) are available. |
| Async request APIs are **mandatory** | `await cookies()`, `await headers()`, `await params`, `await searchParams`. Sync access removed in 16 — no fallback. |
| Server Functions bypass proxy matchers | Docs explicitly warn: a matcher change can silently drop proxy coverage on Server Actions. **Every** route handler and server action re-verifies session itself. |
| `after()` available | Post-response background work in route handlers — used for campaign sends and webhook side effects. |
| Turbopack is default | Build config changes; watch for xlsx/stripe bundling issues. |
| `next typegen` | Generates `PageProps<'/route'>` / `RouteContext` helpers for typed async params. |

**Existing debt that blocks new work:** `src/app/page.tsx` is a single 1,354-line `'use client'`
component that queries Supabase directly from the browser with the anon key, loads *all* contacts,
and filters in memory. Server-side filtering, RLS enforcement, and export all require breaking this
up. Scheduled in Phase 2, not deferred to the end.

---

## 2. Phase sequence

```
Phase 0  Foundations ──┬─> Phase 1  Auth + Deploy ──┬─> Phase 2  Database completion
                       │                            │
                       └─> Phase 3  Newsletter intake┘
                                                     │
                                    Phase 4  Marketing agent ──> Phase 5  Booking & payments
                                                     │
                                                     └─────────> Phase 6  Hardening
```

Phase 1 first for a hard reason: the app currently has **no auth**, so it cannot be shown to the
client on a URL at all. Everything else is unreviewable until that ships.

| Phase | Work | Rough effort |
|---|---|---|
| 0 | Schema migrations, server DB clients, test infra | 1–1.5 d |
| 1 | Supabase Auth, proxy gate, login UI, Vercel + subdomain | 2–3 d |
| 2 | Soft delete, job type, filters, CSV export, `page.tsx` refactor | 3–4 d |
| 3 | Newsletter auto-intake, webhook hardening, EmailOctopus v2 | 1.5–2 d |
| 4 | Segments, AI generation, approval UI, campaign send | 4–5 d |
| 5 | Stripe checkout, booking tokens, Calendly, booking records | 4–5 d |
| 6 | Coverage to 80%, security pass, a11y, docs | 2–3 d |

---

## PHASE 0 — Foundations

### 0.1 Schema migrations

**Where:** `supabase/migrations/2026XXXX_soft_delete_and_segmentation.sql` (new, forward-only)

**Includes:**
```sql
-- Soft delete
alter table public.contacts add column deleted_at timestamptz;

-- Unique email must ignore archived rows
alter table public.contacts drop constraint contacts_email_key;
create unique index contacts_email_active_idx
  on public.contacts (email) where deleted_at is null;

-- Job type as a reference table (filterable, consistent, no free-text drift)
create table public.job_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default timezone('utc', now())
);
alter table public.contacts add column job_type_id uuid references public.job_types(id);

-- Richer client status, backfilled from is_customer
create type contact_status as enum ('lead','prospect','customer','archived');
alter table public.contacts add column status contact_status not null default 'lead';
update public.contacts set status = case when is_customer then 'customer' else 'prospect' end;

create index contacts_status_idx    on public.contacts (status)      where deleted_at is null;
create index contacts_state_idx     on public.contacts (state)       where deleted_at is null;
create index contacts_job_type_idx  on public.contacts (job_type_id) where deleted_at is null;
```

**Technical considerations:**
- ⚠️ **Partial unique index breaks the existing import.** `page.tsx:453` uses
  `.upsert(rows, { onConflict: 'email' })`. Postgres cannot infer a *partial* unique index from a
  bare `ON CONFLICT (email)` — the index predicate must be included. PostgREST/supabase-js does not
  emit it. Fix: replace the bulk upsert with a Postgres function
  `import_contacts(rows jsonb)` called via `.rpc()`, which does
  `insert ... on conflict (email) where deleted_at is null do update ...`. This is a required
  rewrite of the ingest path, not optional.
- Keep `is_customer` during transition; drop in a later migration once nothing reads it.
- RLS: add `deleted_at is null` to the standard SELECT policy and expose archived rows through a
  separate policy/view, so a forgotten `.is('deleted_at', null)` cannot leak deleted data.

**Testing:** apply to a Supabase branch DB; assert (a) two contacts can share an email if one is
archived, (b) inserting a duplicate active email fails, (c) `status` backfill matches `is_customer`
for every row, (d) the `import_contacts` RPC upserts and does not resurrect archived rows silently.

---

### 0.2 Server-side data access

**Where:** `src/lib/supabase/server.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/admin.ts`,
`src/lib/db/types.ts`

**Includes:** three distinct clients with different trust levels —
browser (anon key + user JWT, RLS enforced), server component/route handler (anon key + cookie
session, RLS enforced), and admin (service-role key, **RLS bypassed**, webhooks only).

**Needs:** `@supabase/ssr`; `SUPABASE_SERVICE_ROLE_KEY` in env (never `NEXT_PUBLIC_`).

**Technical considerations:**
- The service-role client must be import-guarded so it can never reach a client bundle —
  `import 'server-only'` at the top of `admin.ts`.
- Generate DB types: `supabase gen types typescript` → `src/lib/db/types.ts`, replacing the
  hand-written `DbContact` in `page.tsx:42-61`.
- The existing `getSupabaseClient()` (`src/lib/supabaseClient.ts`) stays for the browser path but is
  renamed for clarity; every current caller is audited.

**Testing:** unit test that `admin.ts` throws when the service-role key is absent; a lint/CI grep
asserting `SUPABASE_SERVICE_ROLE_KEY` never appears in a `'use client'` file or `NEXT_PUBLIC_` name.

---

### 0.3 Test infrastructure

**Where:** `jest.config.ts`, `src/e2e/` (**does not exist** — `playwright.config.ts:4` points at a
missing dir, so `npm run test:e2e` currently collects zero tests), `src/test/factories.ts`,
`src/test/fixtures/`

**Includes:** create `src/e2e/`; coverage thresholds in Jest; contact/segment/campaign factories;
recorded webhook fixtures (EmailOctopus, Stripe, Calendly) as JSON.

**Technical considerations:**
- Route handlers are testable by importing `POST` directly and passing a constructed `NextRequest` —
  no HTTP server needed. Mock `@/lib/supabase/*` at module level.
- Proxy matcher coverage is testable via `unstable_doesProxyMatch` from
  `next/experimental/testing/server` (experimental, present in 16).
- Add to `jest.config.ts`:
  ```ts
  coverageThreshold: { global: { statements: 80, branches: 80, functions: 80, lines: 80 } }
  ```

---

## PHASE 1 — Auth and deployment

### 1.1 Supabase Auth (invite-only)

**Where:** `proxy.ts` (root), `src/lib/auth/dal.ts`, `src/app/login/page.tsx`,
`src/app/login/actions.ts`, `src/app/auth/callback/route.ts`, `src/app/logout/route.ts`

**Includes:** login form (Server Action + `useActionState`), cookie session refresh in `proxy.ts`,
a `verifySession()` Data Access Layer, logout, and a session-expiry redirect.

**Needs:** `@supabase/ssr`; Supabase dashboard — disable public signups, invite the client's users
by email, set Site URL + redirect allowlist to the production subdomain.

**Technical considerations:**
- `proxy.ts` — file name and exported function name are both `proxy`. Matcher must exclude
  `_next/static`, `_next/image`, `favicon.ico`, and `/api/*/webhook` (third-party webhooks carry no
  session cookie and must not be redirected to `/login`).
- Proxy is an **optimistic check only**. Per the Next docs, Server Functions are POSTs to their own
  route and can fall outside a matcher. `verifySession()` is called inside every route handler and
  server action that touches data.
- `verifySession()` wrapped in React `cache()` so it runs once per render pass.
- The RLS policies in `20260603000000_init_schema.sql` already target the `authenticated` role.
  Today the app connects as `anon`, so those policies deny everything — this phase is what makes the
  existing security model actually function. Verify with a logged-out `curl` against PostgREST.
- Return generic auth errors ("Invalid email or password") — no user-enumeration.

**Testing:**
- Unit: `verifySession()` returns null on missing/expired/malformed cookie.
- Proxy: `unstable_doesProxyMatch` asserts `/` and `/api/contacts` are matched, and
  `/api/stripe/webhook`, `/_next/static/*` are **not**.
- E2E (`src/e2e/auth.spec.ts`): logged-out `/` → `/login`; bad password → error, no redirect; good
  password → dashboard; logout → session cleared, back-button does not restore data; direct
  `fetch('/api/contacts')` with no cookie → 401 not 200.

---

### 1.2 Vercel deployment + private subdomain

**Where:** Vercel project settings, `next.config.ts` (security headers), `.env.local.example`

**Includes:** prod + preview environments, custom subdomain (`crm.<client-domain>`), TLS, security
headers (HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
`Permissions-Policy`), and Vercel Cron for scheduled sends in Phase 4.

**Needs:** Vercel account; DNS access to add a CNAME; a **production** Supabase project separate from
dev; all env vars set per-environment.

**Technical considerations:**
- Preview deployments are publicly reachable by URL — enable Vercel deployment protection so preview
  builds carrying real data aren't exposed.
- `robots.txt` disallow-all plus `X-Robots-Tag: noindex` on the subdomain.
- Supabase auth redirect allowlist must include both the prod subdomain and preview wildcards, or
  login silently fails on previews.

**Testing:** smoke E2E against the preview URL in CI; verify headers with a `curl -I` assertion in
the pipeline; confirm an unauthenticated request to the prod domain 302s to `/login`.

---

## PHASE 2 — Database completion (scope 3.1)

### 2.1 `page.tsx` decomposition

**Where:** `src/app/(crm)/layout.tsx`, `src/app/(crm)/contacts/page.tsx` (server),
`src/components/contacts/ContactsView.tsx` (client), plus `imports/`, `integrations/`, `settings/`
as sibling routes.

**Includes:** replacing the `currentView` state machine with real routes; moving the contact query
server-side into a server component reading `await searchParams`; the table stays a client component
for sorting/selection.

**Technical considerations:** this is a refactor with no user-visible feature change, so it lands
behind the existing E2E suite as the safety net — write the E2E coverage for current behaviour
*first*, then refactor until green. `searchParams` is a Promise in Next 16.

---

### 2.2 Filter by job type, state, and status

**Where:** `src/lib/contacts/query.ts` (pure query-param → Supabase filter builder),
`src/components/contacts/FilterBar.tsx`

**Includes:** job type dropdown (from `job_types`), state dropdown (AU states + territories),
status dropdown, free-text search, and **URL-as-state** (`?jobType=&state=&status=&q=&sort=&page=`)
so filtered views are shareable and survive reload — required by the project's own web patterns rule.

**Technical considerations:**
- Current search (`page.tsx:680`) concatenates name/email/org/position — **state is not searchable
  today**. Server-side filtering replaces it entirely.
- Search across contact + joined organisation name needs either a denormalised `search_tsv` tsvector
  column with a GIN index, or `.or()` with an inner join. Start with `ilike` filters; add tsvector
  only if the list grows past a few thousand rows (YAGNI).
- Pagination is mandatory once filtering is server-side — the current "load everything" pattern is
  what forced client-side filtering in the first place.

**Testing:** unit tests on the query builder (each param → expected filter object; unknown params
ignored; SQL wildcards in `q` escaped). E2E: apply job type + state, assert row count and that a
reload preserves the filter.

---

### 2.3 CSV export

**Where:** `src/lib/csv.ts` (pure), `src/app/api/contacts/export/route.ts`

**Includes:** two shapes — **EmailOctopus** (`EmailAddress,FirstName,LastName` + merge fields) and
**Full** (all contact fields). Export respects the active filters by reusing the same query builder
as 2.2. Streams as `text/csv` with `Content-Disposition: attachment`.

**Technical considerations:**
- 🔒 **CSV injection.** Any field starting with `=`, `+`, `-`, `@`, tab, or CR must be prefixed with
  a single quote before writing, or opening the export in Excel executes it as a formula. This is a
  real vulnerability in exported CRM data, not a formatting nicety.
- RFC 4180 quoting: escape embedded quotes by doubling, quote any field containing comma/quote/newline.
- UTF-8 BOM so Excel renders non-ASCII names correctly.
- `verifySession()` before streaming; excludes soft-deleted rows unless explicitly requested.

**Testing:** unit tests are the priority here — quoting, embedded commas/newlines/quotes, the
injection prefix for each dangerous leading character, empty result set, BOM present. Route test:
401 without session; correct `Content-Type`/`Content-Disposition`; filters applied.

---

### 2.4 Soft delete + archive UI

**Where:** `src/app/api/contacts/[id]/route.ts` (DELETE → sets `deleted_at`),
`src/app/(crm)/contacts/archive/page.tsx`, `ContactDrawer.tsx:538-550`

**Includes:** replacing the hard delete at `page.tsx:600-611` with an archive action, an archive
list view, and restore. No UI path performs a hard delete.

**Technical considerations:** every existing contact query needs `.is('deleted_at', null)` — this is
the easiest thing in the whole plan to miss, which is why the RLS policy carries it too. Restoring a
contact whose email was since reused by an active contact must fail with a clear message, not a 500
from the partial unique index.

**Testing:** unit — archive sets timestamp, does not remove the row; restore clears it; restore into
an email collision returns a handled error. E2E — archive a contact, confirm it leaves the main list
and appears in the archive, restore it, confirm it returns.

---

## PHASE 3 — Automated newsletter intake (scope 3.2)

### 3.1 Webhook creates contacts, not just updates

**Where:** `src/app/api/integrations/emailoctopus/webhook/route.ts`

**Problem today:** the handler does `.update().eq('email', email)` (line 25-28). A brand-new website
subscriber matches zero rows and is **silently dropped** — the response is still `200 {success:true}`.
The core requirement of 3.2 does not work.

**Includes:** upsert on email — update if the contact exists, otherwise insert a new `lead` with
`subscribed_to_newsletter = true` and a `source = 'newsletter'` marker. Handle the archived-contact
case explicitly (resubscribe should restore, not create a duplicate). Log every event to `sync_logs`.

**Technical considerations:** uses the **admin** client (no user session on a webhook), which means
RLS is bypassed — so payload validation has to be strict. Wrap the DB write in `after()` only if the
provider requires a fast ack; otherwise ack after commit so failures are retried.

---

### 3.2 Webhook signature verification

**Where:** `src/lib/webhooks/verify.ts`

**Problem today:** the endpoint is unauthenticated. Anyone who finds the URL can flip newsletter
subscription state for any email address, or inject arbitrary contacts once 3.1 lands.

**Includes:** HMAC verification against the shared secret, timestamp/replay window check, and
constant-time comparison (`crypto.timingSafeEqual`). Reject with 401 before any parsing.

**Technical considerations:** signature must be computed over the **raw body** — read with
`await req.text()` and parse afterwards; `req.json()` first makes verification impossible. Store
processed event IDs to make retries idempotent.

**Testing:** valid signature → 200; tampered body → 401; replayed old timestamp → 401; missing header
→ 401; duplicate event ID → 200 with no second write.

---

### 3.3 EmailOctopus API v2 migration

**Where:** `src/lib/emailOctopus.ts`, `src/lib/emailOctopus.test.ts`

**Includes:** move from v1.6 (`api_key` in the JSON body) to v2 (`Authorization: Bearer`), plus
typed error handling and retry-with-backoff on 429.

**Technical considerations:** v1.6 is legacy and its shutdown would break the only working
integration. Verify current v2 endpoints and payloads against EmailOctopus docs at implementation
time rather than assuming. The existing test asserts the exact v1.6 URL and body
(`emailOctopus.test.ts:29-40`) and will need rewriting alongside.

---

## PHASE 4 — Marketing agent (scope 3.3)

> ✅ **RESOLVED 2026-08-08 — the EmailOctopus API cannot create or send campaigns.**
> Campaign endpoints are read-only in both v1 and v2: `GET /campaigns`, `GET /campaigns/{id}`,
> and `/reports*`. There is no POST/PUT/DELETE anywhere under `/campaigns`. Lists, contacts,
> custom fields and tags have full CRUD, including a contact upsert accepting tags and field
> values.
>
> **The only programmatic send trigger is `POST /automations/{id}/queue`.** It starts an
> automation for *one contact*; the automation must use the "Started via API" trigger type, and
> a contact can trigger it only once unless "Allow contacts to repeat" is enabled.
>
> Three consequences that reshape this phase:
>
> 1. **Send is per contact, not per broadcast.** One API call per recipient. Rate limit is a
>    token bucket — 100 tokens refilling at 10/sec — so a 10k segment is ~17 minutes of
>    queueing, plus our own retry and idempotency handling. With "Allow contacts to repeat" on
>    for recurring sends, **deduplication becomes entirely our responsibility.**
> 2. **AI-generated copy cannot reach the email body.** The template is authored in the
>    EmailOctopus UI. The only injection route is contact custom fields merged into that
>    template — short personalisation tokens, not a generated HTML body. The AI generation piece
>    is therefore *coupled* to this answer, not independent of it as previously assumed.
> 3. **Automation send tracking is undocumented.** Every reporting endpoint is keyed to a
>    campaign id; there are no automation reporting endpoints. Per-send opens and clicks for
>    automation-driven email probably do not come back through the API at all. This is the
>    largest remaining unknown.
>
> **Approach:** build segments and the approval workflow provider-agnostically, behind an
> adapter boundary at the send step. Hold the AI generation shape until the merge-field ceiling
> and automation reporting are confirmed on a free account (30–60 min).
>
> If full API-driven campaign creation turns out to be a hard requirement rather than a
> nice-to-have, **this is a provider-selection problem** — Mailchimp, Brevo and Resend Broadcasts
> all support create-plus-send programmatically. The adapter boundary exists so that swap stays
> contained.

### 4.1 Segments

**Where:** `supabase/migrations/*_segments.sql`, `src/lib/marketing/segments.ts`,
`src/app/(crm)/campaigns/segments/page.tsx`

**Includes:** a `segments` table storing named filter definitions as JSONB
(`{jobTypeIds, states, statuses, subscribedOnly}`), a live member-count preview, and reuse of the
Phase 2.2 query builder so a segment and a filtered list mean exactly the same thing.

**Technical considerations:** store the *definition*, not a frozen member list, so segments stay
current as contacts change. Validate the JSONB against a Zod schema on read — a hand-edited or
migrated row must not be able to produce an unbounded query.

---

### 4.2 AI campaign generation with approval gate

**Where:** `src/lib/marketing/generateCampaign.ts`, `src/lib/marketing/prompt.ts`,
`src/app/api/campaigns/generate/route.ts`, `src/app/(crm)/campaigns/[id]/review/page.tsx`

**Includes:** Claude generates `{subject, preheader, bodyHtml, bodyText}` for a given segment; the
draft is stored with status `draft`; a human reviews and edits in the CRM; only an explicit approve
action moves it to `approved`. **Nothing sends without approval.**

**Needs:** `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY` (server-only). Model: `claude-sonnet-5` for copy.
Brand voice sourced from `PRODUCT.md`.

**Technical considerations:**
- Use structured output (tool/JSON schema) rather than parsing prose — validation happens at the
  tool-call layer so the model retries on a shape mismatch.
- The prompt carries segment definition + brand voice + the mandatory booking CTA. Contact PII does
  **not** go to the model — generation is per-segment, personalisation happens via merge fields at
  send time.
- Status machine: `draft → in_review → approved → sending → sent | failed`. Only `approved` is
  sendable, enforced in the DB with a check constraint, not just in the UI.
- Generation is slow — run it in a route handler and poll, or use `after()`; do not block a form submit.

**Testing:** mock the SDK entirely — unit tests assert prompt construction (segment values present,
booking CTA present, no PII), schema validation rejects malformed output, and the status machine
refuses to send a `draft`. One manual smoke test against the live API per release, not in CI.

---

### 4.3 Campaign send

**Where:** `src/app/api/campaigns/[id]/send/route.ts`, `src/lib/emailOctopus/campaigns.ts`

**Includes:** resolve segment members → push/tag into EmailOctopus → create and send the campaign →
record a `campaign_sends` row per recipient with their unique booking token (Phase 5.1).

**Technical considerations:** long-running and partially failable. Chunk recipients, make each chunk
idempotent (unique on `campaign_id + contact_id`), and record per-recipient status so a retry does
not double-send. Use `after()` to return quickly. Vercel function timeouts apply — for large lists,
chunk across Cron invocations rather than one long request.

**Compliance (raise with client before first send):** Australian **Spam Act 2003** requires consent,
sender identification, and a functional unsubscribe on commercial electronic messages. Mining the
contact database for people who never opted in is a legal exposure for the client, not just a
deliverability risk. Recommend restricting sends to `subscribed_to_newsletter = true` by default and
getting written confirmation before any broader send.

---

## PHASE 5 — Booking and payments (scope 3.4)

Flow: **email CTA → `/book/[token]` → Stripe Checkout ($500 − 100% promo = $0) →
`checkout.session.completed` → Calendly (prefilled) → `invitee.created` → booking row in CRM.**

### 5.1 Booking tokens

**Where:** `src/lib/booking/token.ts`, `supabase/migrations/*_bookings.sql`

**Includes:** per-recipient single-use expiring token generated at send time; `bookings` table
(`token`, `contact_id`, `campaign_id`, `expires_at`, `stripe_session_id`, `promotion_code_id`,
`calendly_event_uri`, `status`).

**Technical considerations:** never put a contact UUID in an email link. Use a random 32-byte token
stored hashed, looked up on visit. Expired/used tokens get a friendly "this link has expired" page,
not a 404.

---

### 5.2 Stripe

**Where:** `src/lib/stripe/client.ts`, `src/app/api/booking/create-session/route.ts`,
`src/app/api/stripe/webhook/route.ts`, `src/app/book/[token]/page.tsx`

**Needs:** Stripe account (AU, AUD); a $500 Consultation product/price; one 100%-off coupon
(`duration: once`); per-lead promotion codes with `max_redemptions: 1` and
`metadata.contact_id`; `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.

**Technical considerations:**
- A 100% discount makes the session total **$0**; set `payment_method_collection: 'if_required'` so
  Stripe doesn't demand a card for a zero-value checkout.
- Webhook signature needs the **raw body**: `const body = await req.text()` then
  `stripe.webhooks.constructEvent(body, sig, secret)`. Using `req.json()` breaks verification.
- `export const runtime = 'nodejs'` on the webhook route for the Stripe SDK.
- Idempotency: unique index on `stripe_event_id`; Stripe retries aggressively.
- Test mode end-to-end first; live keys only at handover.

---

### 5.3 Calendly

**Where:** `src/app/api/calendly/webhook/route.ts`, `src/app/book/[token]/scheduled/page.tsx`

**Needs:** ⚠️ Calendly **webhooks require a paid plan** (Standard or higher) — confirm the client has
one or budget for it, as the whole "booking lands back in the CRM" requirement depends on it.
Also a personal access token and the 30-minute event type URI.

**Includes:** prefill the scheduling link with the invitee's name/email, subscribe to
`invitee.created` and `invitee.canceled`, and write the booking back to the contact record.

**Technical considerations:** verify the `Calendly-Webhook-Signature` header (HMAC-SHA256 over
`timestamp + body`, with a replay window) — same raw-body rule as Stripe. Match the invitee back to
the contact via the booking token passed through the scheduling URL, with email as a fallback.

**Testing:** unit tests on signature verification and payload → booking mapping using recorded
fixtures. E2E against Stripe test mode: click a real booking link, complete the $0 checkout, assert
the booking row exists and the contact shows the consultation. Cancellation path tested separately.

---

## PHASE 6 — Hardening

- Coverage to the 80% threshold; enforce in CI so it can't regress.
- Security pass: no secrets in client bundles, every route handler calls `verifySession()`, all three
  webhooks verify signatures, RLS verified from a logged-out client, CSV injection covered.
- Accessibility per `PRODUCT.md` (WCAG 2.1 AA): keyboard paths through drawer, filters, and the
  booking flow; 4.5:1 contrast; `prefers-reduced-motion` honoured by the GSAP timelines.
- Visual regression at 320/768/1024/1440 on the new campaign and booking surfaces.
- Rewrite `README.md` — it is still the stock create-next-app text below the env block.

---

## 3. Testing strategy

| Layer | Tool | Covers |
|---|---|---|
| Unit | Jest | Pure libs: csv, query builder, token signing, signature verification, prompt building, validators |
| Integration | Jest | Route handlers — import `POST`/`GET`, pass a `NextRequest`, mock `@/lib/supabase/*` |
| Proxy | `unstable_doesProxyMatch` | Auth matcher includes protected routes, excludes webhooks and static |
| DB | Supabase branch | Migrations, RLS policies, partial unique index, RPC upsert |
| E2E | Playwright | Auth, filter+export, import, campaign approval, booking happy path (Stripe test mode) |
| Visual | Playwright screenshots | New surfaces at 4 breakpoints |

**Rules applied throughout:** tests first (RED → GREEN → REFACTOR); external services always mocked
in CI with recorded fixtures; one manual live smoke per integration per release.

---

## 4. Development process

1. **Branch per phase** off `main` (note: repo is currently on `master` with one commit and a large
   uncommitted working tree — resolve that before Phase 0).
2. **Migrations are forward-only.** Never edit an applied migration; add a new timestamped one.
3. **TDD.** Failing test first, minimal implementation, refactor.
4. **Review before merge** — `code-reviewer` then `security-reviewer` on anything touching auth,
   webhooks, payments, or user input. CRITICAL/HIGH block the merge.
5. **Conventional commits** (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`).
6. **Definition of done:** tests pass · coverage ≥80% · `npm run build` clean · no secrets ·
   no `console.log` in new code · env vars documented in `.env.local.example` · docs updated.
7. **Client checkpoint at the end of each phase** on the Vercel preview URL.

---

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| EmailOctopus API may not support programmatic campaign send | **High** | Verify before Phase 4. Fallback: agent manages segments/tags, EmailOctopus automation sends. |
| Calendly webhooks need a paid plan | **High** | Confirm with client now — booking-into-CRM depends on it. |
| Partial unique index breaks existing bulk upsert | Medium | Known; RPC rewrite scheduled in Phase 0.1. |
| Australian Spam Act exposure on mined segments | Medium | Default to opted-in contacts only; written client sign-off before broader sends. |
| `page.tsx` refactor regresses working features | Medium | E2E coverage of current behaviour written *before* the refactor. |
| Next 16 API divergence from common knowledge | Medium | Consult `node_modules/next/dist/docs/` per `AGENTS.md` before each new file convention. |
| `next dev` does not hydrate locally — dev is non-interactive | Medium | E2E runs against `next build` + `next start`. Root cause still open; see Progress. |
| Phase 0 migration SQL executed nowhere yet | Medium | `npm run db:verify` against a branch DB before Phase 1 builds on the schema. |
| Pre-existing lint debt: 12 `no-explicit-any` errors in `excelParser.ts` / `contacts.ts` | Low | Untouched in Phase 0 to avoid changing a working parser; cleared in Phase 6. |
| Remaining scope is large relative to the agreed AU$1,000 fee | — | Flagged for commercial decision; not a technical blocker. |

---

## 6. Open questions for the client

1. **Job type values** — what's the actual list? (trades, industries, service categories?) It drives
   the `job_types` seed data and every segment.
2. **Client status values** — is `lead / prospect / customer / archived` right, or do they use
   different language?
3. **Calendly plan** — do they have Standard or above (needed for webhooks)?
4. **Stripe account** — existing AU account, or new? Who owns the API keys at handover?
5. **Sending domain + consent** — which domain sends the campaigns, and can they confirm the existing
   database has consent to receive marketing?
6. **Subdomain** — exact hostname, and who controls DNS?
