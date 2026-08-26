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

Apply the database migrations to your Supabase project (`npx supabase db push`, or run the
files in `supabase/migrations/` in filename order), then verify the schema:

```bash
npm run db:verify   # all five suites; non-destructive, each rolls back at the end
```

Each suite can be run alone: `db:verify:contacts`, `db:verify:webhooks`,
`db:verify:campaigns`, `db:verify:bookings`, `db:verify:operations`. They assert what a mocked unit test cannot —
that the database itself refuses a replayed webhook, an unapproved send, and a booking
token reused for a second free consultation.

Contacts get their job type from their EmailOctopus tags, which is where the client's own
classification lives. Re-run after any import:

```bash
npm run db:sync-job-types -- --dry-run   # report only
npm run db:sync-job-types                # apply
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
| `EMAILOCTOPUS_API_KEY` / `_LIST_ID` | Newsletter sync | The list id is the UUID in the list's dashboard URL |
| `EMAILOCTOPUS_WEBHOOK_SECRET` | Newsletter intake | Per-endpoint secret; without it the webhook rejects everything |
| `GEOAPIFY_API_KEY` | Address autocomplete | |
| `STRIPE_SECRET_KEY` | Booking | |
| `STRIPE_CONSULTATION_PRICE_ID` | Booking | A $500 AUD one-off Price |
| `STRIPE_CONSULTATION_COUPON_ID` | Booking | A 100%-off Coupon, `duration: once` |
| `STRIPE_WEBHOOK_SECRET` | Booking | From the `checkout.session.completed` endpoint |
| `CALENDLY_WEBHOOK_SECRET` | Scheduling | **Requires a paid Calendly plan** |
| `ANTHROPIC_API_KEY` | AI campaign copy | Server only. Without it copy is typed by hand and the button says so |
| `NEXT_PUBLIC_CALENDLY_SCHEDULING_URL` | Scheduling | The 30-minute event type link |

Every secret fails **closed**: a missing webhook secret rejects all deliveries rather than
accepting them, and a missing Supabase config denies access rather than granting it.

**Deploying? Read [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) first.** It carries the full
manifest of which variables go where, which two are *not* environment variables at all,
and why `NEXT_PUBLIC_APP_URL` has to be right before the first campaign send rather than
after it.

### EmailOctopus webhook

Register one endpoint under **Settings → Webhooks**, pointing at
`https://<host>/api/integrations/emailoctopus/webhook`. It must be HTTPS and publicly
reachable; tunnel it (`cloudflared`, `ngrok`) to test locally.

| Setting | Value | Why |
|---|---|---|
| Contact events | Created, Updated, Deleted | `deleted` ends the subscription; it never deletes the CRM record |
| Email events | Unsubscribed only | Clicked/opened/bounced/complained have nowhere to go in the schema yet — they are acknowledged and dropped |
| Exclude events from an API request | **Checked** | The CRM pushes contacts to EmailOctopus itself; without this every sync echoes straight back |
| Exclude events from an import | Checked | Unless bulk imports should create CRM leads |

Copy the endpoint's signing secret into `EMAILOCTOPUS_WEBHOOK_SECRET`. Deliveries are
signed `sha256=<hmac>` in an `EmailOctopus-Signature` header, and carry an **array** of up
to 1000 events buffered over roughly a minute — each is claimed separately in
`webhook_events`, so a partial failure retries only the events that actually failed.

---

## Campaign copy

The Campaigns screen writes seven short merge-field values, not an email body. That is not
a design preference — the EmailOctopus API cannot accept a body at all, so the template
lives in their dashboard and the only route content takes into a send is contact custom
fields merged into it.

`docs/EMAILOCTOPUS_SETUP.md` has the full picture: the field list, the automation setup,
the rate limit and what it means for send duration, and the two things that still cannot
be verified. Read it before the first real send.

Two gates sit between generated text and a recipient's inbox:

- **Validation.** `src/lib/marketing/mergeFields.ts` is the single source of truth for
  which fields exist and how long each may be. The model's tool schema is derived from it,
  and the same validator runs on hand-typed edits — an operator cannot overrun the
  template either. It also refuses any attempt to set `BookingUrl`, which is minted per
  recipient at send time; a generated value there would replace every recipient's real
  booking link with one dead URL.
- **Approval.** Generation writes to a `draft` campaign and never changes that. Approval
  is a separate, attributed endpoint, and the database enforces the status machine with a
  trigger — an unapproved campaign cannot reach `sending` through any code path, including
  direct SQL.

Contact details never reach the model. Generation is per *segment*: the prompt carries the
filters and the audience size, and `redactPii` strips emails and phone numbers from the
free-text fields an operator could hide one in — typically a segment saved from a contact
search.

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
| `npm run db:verify` | Schema assertions against the live database (five suites) |
| `npm run verify:deployment <url>` | Post-deploy checks: headers, auth, webhook signatures, secret leaks |
| `npm run verify:newsletter -- <url>` | Signed newsletter signup, replay, unsubscribe, and cleanup canary |
| `npm run preflight -- [--online] [url]` | Release config, schema and provider readiness checks |
| `npm run db:sync-job-types` | Assign job types from EmailOctopus tags (`-- --dry-run` to preview) |
| `npm run db:create-admin` | Seed the first dashboard login from `ADMIN_EMAIL` / `ADMIN_PASSWORD` |

E2E runs against `next build` + `next start` rather than the dev server — both because
E2E should exercise the shipped artifact, and because `next dev` does not currently
hydrate in this environment (see `PLAN.md`).

Signed-in E2E specs **skip** unless `E2E_EMAIL` and `E2E_PASSWORD` are set and point at a
real account. They skip loudly rather than passing vacuously. A setup project signs in
once and shares a temporary storage state with the three browser projects. The logout
check runs only after those projects finish so its global session revocation cannot
invalidate another test. The 3 remaining skips assert the "sign-in unavailable" screen,
which only renders when Supabase is *not* configured.

Three things to know before running it:

- `npx playwright install` — firefox and webkit binaries are not installed by default,
  and their absence fails 18 specs on a missing executable rather than on anything real.
- Port 3100 must be free by default. Existing servers are never reused unless
  `E2E_REUSE_EXISTING_SERVER=true` is explicitly set. Use `E2E_BASE_URL` to select a
  different origin, or set `E2E_EXTERNAL_SERVER=true` to test an already deployed host.
- `E2E_BROWSERS=chromium` limits a smoke run to one installed browser. CI also sets
  `E2E_SKIP_BUILD=true` because its production build step has already created `.next`.
- Workers are capped at 3 and the per-test budget is 60s. The constraint is one
  `next start` and one remote Supabase project, not CPU — at Playwright's default width
  a different spec times out on each run.

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
    ├── booking/          Single-use expiring tokens, booking persistence, and the
    │                     funnel read model behind the Bookings screen
    ├── contacts/         Filter parsing, repository, CSV export, import
    ├── marketing/        Segments, campaign status machine, copy generation, send
    │   │                 pipeline. mergeFields.ts is the contract every other
    │   │                 piece derives from
    │   └── providers/    Provider adapter boundary
    ├── motion.ts         prefers-reduced-motion, checked before any GSAP timeline
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

**A booking that reaches `paid` and stops is the failure to watch for.** It means the
lead claimed the free consultation and never chose a time — and it is also exactly what a
Calendly webhook outage looks like, which is a live risk on plans below Standard. The
Bookings screen leads with that count and says so, rather than only counting completed
bookings, because a screen that celebrates conversions hides this one.

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
regress, and are raised as tests are added. All four metrics now clear the 80% project
standard (91.7 / 82.8 / 81.0 / 91.7). `src/app/page.tsx` remains the weakest file at 44%
function coverage; its decomposition is still outstanding, but it is no longer what is
holding the number down.
