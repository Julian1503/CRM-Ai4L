# Ai4L CRM

A contact database with an attached marketing automation layer. Stores client and lead
contact data, filters and exports it, and automates outreach — including scheduling
consultations and applying promotional pricing.

Built on Next.js 16, React 19, Supabase (Postgres + Auth + RLS), EmailOctopus, Stripe and
Calendly.

> **Read `PLAN.md` before starting work.** It records what is built, what is deliberately
> deferred, and — importantly — which integrations have never been exercised against a
> live service. Several are written from documentation and remain unverified.

---

## Requirements

- Node.js 20+
- A Supabase project (Postgres + Auth)
- Accounts for EmailOctopus, Stripe and Calendly, for the features that use them

## Setup

```bash
npm install
cp .env.local.example .env.local   # then fill it in — see the table below
npm run dev
```

Apply the database migrations to your Supabase project (they are in `supabase/migrations/`,
applied in filename order), then verify the Phase 0 schema:

```bash
npm run db:verify   # non-destructive; rolls back at the end
```

Regenerate the TypeScript schema types after any migration:

```bash
npm run db:types
```

### Supabase configuration

The CRM is **invite-only**, and nothing in the application enforces that — it is a project
setting. In the Supabase dashboard:

1. **Disable public sign-ups.** Without this, anyone can create an account.
2. Invite your users by email.
3. Set the Site URL and redirect allowlist to your deployment domain, including preview
   URLs. Login fails silently otherwise.

### Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Everything | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Everything | Public by design; RLS is what protects data |
| `SUPABASE_SERVICE_ROLE_KEY` | Webhooks, booking pages | **Bypasses RLS.** Server only — never prefix `NEXT_PUBLIC_` |
| `EMAILOCTOPUS_API_KEY` / `_LIST_ID` | Newsletter sync | |
| `EMAILOCTOPUS_WEBHOOK_SECRET` | Newsletter intake | Without it the webhook rejects everything |
| `GEOAPIFY_API_KEY` | Address autocomplete | |
| `STRIPE_SECRET_KEY` | Booking | |
| `STRIPE_CONSULTATION_PRICE_ID` | Booking | A $500 AUD one-off Price |
| `STRIPE_CONSULTATION_COUPON_ID` | Booking | A 100%-off Coupon, `duration: once` |
| `STRIPE_WEBHOOK_SECRET` | Booking | From the `checkout.session.completed` endpoint |
| `CALENDLY_WEBHOOK_SECRET` | Scheduling | **Requires a paid Calendly plan** |
| `NEXT_PUBLIC_CALENDLY_SCHEDULING_URL` | Scheduling | The 30-minute event type link |

Every secret fails **closed**: a missing webhook secret rejects all deliveries rather than
accepting them, and a missing Supabase config denies access rather than granting it.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Unit and integration tests |
| `npm run test:coverage` | Tests with the coverage ratchet enforced |
| `npm run test:e2e` | Playwright, against a **production build** |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:verify` | Schema assertions against the live database |

E2E runs against `next build` + `next start` rather than the dev server — both because
E2E should exercise the shipped artifact, and because `next dev` does not currently
hydrate in this environment (see `PLAN.md`).

Signed-in E2E specs **skip** unless `E2E_EMAIL` and `E2E_PASSWORD` are set and point at a
real account. They skip loudly rather than passing vacuously.

---

## Architecture

```
src/
├── proxy.ts              Auth gate + Supabase session refresh (Next 16 renamed
│                         middleware.ts → proxy.ts; the function must be named `proxy`)
├── app/
│   ├── api/              Route handlers — each re-verifies the session itself
│   ├── book/[token]/     Lead-facing booking pages (public; token is the credential)
│   └── login/            Invite-only sign-in
├── components/           UI, grouped by surface
└── lib/
    ├── auth/             DAL, route classification, open-redirect sanitiser
    ├── booking/          Single-use expiring tokens, booking persistence
    ├── contacts/         Filter parsing, repository, CSV export, import
    ├── marketing/        Segments, campaign status machine, send pipeline
    │   └── providers/    Provider adapter boundary
    ├── stripe/           Checkout ($500 list → $0 charged)
    ├── supabase/         Browser / server / service-role clients
    └── webhooks/         HMAC verification, idempotency ledger
```

### Things worth knowing before you change something

**`proxy.ts` is an optimistic gate, not the authorisation boundary.** The Next.js docs
warn that Server Functions can fall outside a matcher, so every route handler calls
`getSession()` itself. `src/lib/security.test.ts` enforces this structurally — a new API
route without a session check fails the suite.

**Webhook paths are a fail-closed allowlist** (`src/lib/auth/routes.ts`). A new webhook is
blocked by the auth gate until it is added there.

**Three clients, three trust levels.** Browser and server clients use the anon key with RLS
in force. `getAdminClient()` uses the service-role key and **bypasses RLS entirely** — it
is confined to webhooks and the public booking routes, which have no session. A structural
test enforces that confinement.

**Sending is per-recipient.** The EmailOctopus API cannot create or send campaigns; the
only trigger is a per-contact automation queue against a 100-token bucket refilling at
10/sec. A 10,000-contact segment takes roughly 17 minutes. The send pipeline is therefore
resumable, deduplicated and chunked — see `src/lib/marketing/send.ts`.

**Contacts are archived, never deleted.** There is no hard-delete path. Email uniqueness is
a *partial* index (`WHERE deleted_at IS NULL`), which is why bulk import goes through the
`import_contacts` RPC rather than a client-side upsert.

---

## Testing

- **Unit / integration** — Jest. Route handlers are tested by importing the handler and
  passing a constructed `NextRequest`.
- **Structural** — `src/lib/security.test.ts` and `src/lib/supabase/secrets.test.ts` assert
  properties of the codebase (every route authenticates, no server secret reachable from a
  client bundle). These catch failures that are silent rather than loud.
- **E2E** — Playwright against a production build.

Coverage is a **ratchet**: thresholds sit just below the measured baseline so it cannot
regress, and are raised as tests are added. Statements and lines are past the 80% project
standard; branches and functions are not, and the shortfall is concentrated in
`src/app/page.tsx`, whose decomposition is still outstanding.
