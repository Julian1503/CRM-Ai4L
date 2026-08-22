# Deployment

The CRM is a standard Next.js 16 application and deploys to Vercel with no adapter. This
document is the runbook: what has to exist before a deploy, exactly which environment
variables to set and where, which ones are *not* environment variables, how to register
the three webhooks, and how to prove the result is safe to point real traffic at.

Everything here was derived from the code and checked against a production build, not
from memory.

---

## 1. Prerequisites (client-owned)

| What | Why it blocks | Status |
|---|---|---|
| Vercel account + project | Nothing can be deployed without one | **Open** |
| Subdomain (e.g. `crm.hellobloom.com`) | `NEXT_PUBLIC_APP_URL` is baked into the build — see §3 | **Open** |
| DNS control for that subdomain | To point it at Vercel and issue TLS | **Open** |

Until a public HTTPS host exists, **none of the three webhooks can be exercised**, so
newsletter intake, payment confirmation and scheduling cannot be verified end to end no
matter how complete the code is.

---

## 2. Region

The Supabase project is in **`ap-northeast-1` (Tokyo)**. Vercel functions default to
`iad1` (Washington DC), which would put the Pacific *and* the Atlantic between a request
handler and its database on every query.

`vercel.json` pins functions to `hnd1` (Tokyo) to sit alongside the database.

**If the database region changes, change `vercel.json` in the same commit.** The pin is
only correct relative to where Postgres actually is.

> **Worth raising with the client, not decided here.** This is an Australian business
> whose contact database — 5,202 people, with names, emails, phone numbers and employers
> — is stored in Japan. Australian Privacy Principle 8 imposes accountability obligations
> on cross-border disclosure of personal information. Moving the project to
> `ap-southeast-2` (Sydney) would address both residency and latency, but Supabase cannot
> change a project's region in place: it means a new project and a data migration. That
> is a cost-and-downtime decision for the client, not a technical one.

---

## 3. Environment variables

Set these with `npm run vercel:env -- <environment>`, which reads `.env.local`, applies
the manifest below, and pushes each value over stdin so it stays out of the process list
and the shell history:

```bash
npm run vercel:env -- preview --dry-run   # classify without sending anything
npm run vercel:env -- preview
npm run vercel:env -- production
```

It skips any value that is still identical to the one in `.env.local.example` — comparing
against the example rather than pattern-matching on `your-`, so it stays correct as the
example changes — and refuses to push the four that must never be set on Vercel. The
dashboard works too; the script exists because fifteen variables done by hand is how a
deployment ends up with a placeholder Stripe secret and a green checkmark.

### Required — the app will not function without them

| Variable | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Inlined into the browser bundle at build time |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Safe to expose; RLS is what protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** | Bypasses RLS entirely. Webhooks and the booking routes only |
| `NEXT_PUBLIC_APP_URL` | Public | **Read this section before setting it** |

#### `NEXT_PUBLIC_APP_URL` is a build-time value, and getting it wrong is not recoverable

It is read server-side, when a campaign send mints each recipient's booking link:

```ts
const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin
```

But the `NEXT_PUBLIC_` prefix means Next inlines it at build time. Verified against a
production build: the literal value appears in `.next/server/chunks/`. Consequences:

1. **Changing it in the Vercel dashboard does nothing until you redeploy.** There is no
   restart that picks it up.
2. **It must be correct before the first campaign send.** Booking links go out inside
   emails. If the host is wrong, every recipient has a dead link in their inbox and there
   is no way to recall or rewrite it.
3. If it is unset, the send falls back to the request origin — which works locally and
   produces links pointing at an internal Vercel deployment URL in production.

Set it, then deploy, then confirm with `npm run verify:deployment https://<host>` before
approving any campaign.

### Required for the booking funnel

None of these are needed for the CRM itself; without them, the campaign → booking →
payment → scheduling flow stops at the point the missing one is needed.

| Variable | Scope | Without it |
|---|---|---|
| `STRIPE_SECRET_KEY` | **Secret** | Checkout cannot be created |
| `STRIPE_CONSULTATION_PRICE_ID` | **Secret** | No price to charge against |
| `STRIPE_CONSULTATION_COUPON_ID` | **Secret** | The $500 consultation cannot be discounted to $0 |
| `STRIPE_WEBHOOK_SECRET` | **Secret** | Payments never confirm; bookings stay at `checkout_started` |
| `CALENDLY_WEBHOOK_SECRET` | **Secret** | Bookings stay at `paid` forever — nothing marks them scheduled |
| `NEXT_PUBLIC_CALENDLY_SCHEDULING_URL` | Public | Nowhere to send a paid customer to book a time |
| `EMAILOCTOPUS_WEBHOOK_SECRET` | **Secret** | Newsletter subscribe/unsubscribe events are rejected with 401 |

### Optional — the app degrades cleanly

| Variable | Scope | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Secret** | "Write with AI" returns a handled "not configured" error; copy can still be typed by hand |
| `GEOAPIFY_API_KEY` | **Secret** | Address autocomplete returns 503 with a clear message; addresses can still be typed |

### Do **not** set these on Vercel

| Variable | Where it actually lives |
|---|---|
| `EMAILOCTOPUS_API_KEY` | The `credentials` table, entered through the app's own settings screen |
| `EMAILOCTOPUS_LIST_ID` | Same |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Local only, consumed by `npm run db:create-admin` |
| `E2E_EMAIL` / `E2E_PASSWORD` | GitHub Actions secrets, for the signed-in E2E specs |

`.env.local.example` lists the EmailOctopus credentials because the ops scripts
(`db:sync-job-types`) read them from the environment. **The application does not.** Both
`/api/campaigns/[id]/send` and `/api/integrations/emailoctopus/fields` read them from the
`credentials` table. Setting them on Vercel is harmless but has no effect — the app will
still report "not connected" until they are entered in the UI.

### Rotation

Server-only secrets are read at runtime and are **not** baked into the build — verified
by scanning a production build for their literal values. They can be rotated in the
Vercel dashboard without a rebuild. `NEXT_PUBLIC_*` values cannot.

---

## 4. Register the webhooks

Only possible once the host is live. All three paths are exempt from the auth proxy and
authenticate by signature instead (`src/proxy.ts` → `isWebhookPath`).

| Provider | URL to register | Where | Secret goes in |
|---|---|---|---|
| EmailOctopus | `https://<host>/api/integrations/emailoctopus/webhook` | Lists → your list → Settings → Webhooks | `EMAILOCTOPUS_WEBHOOK_SECRET` |
| Stripe | `https://<host>/api/stripe/webhook` | Developers → Webhooks → Add endpoint, event `checkout.session.completed` | `STRIPE_WEBHOOK_SECRET` |
| Calendly | `https://<host>/api/calendly/webhook` | Integrations → Webhooks, events `invitee.created` and `invitee.canceled` | `CALENDLY_WEBHOOK_SECRET` |

**Calendly webhooks require a paid plan (Standard or above).** On a free plan the endpoint
is never called and every paid booking stays at `paid` indefinitely. This is a purchase,
not a configuration step.

Signature schemes differ and are confirmed, not assumed: EmailOctopus sends
`sha256=<hex hmac of the raw body>` in `EmailOctopus-Signature` with no timestamp — replay
defence therefore rests on the idempotency ledger. Stripe and Calendly both use
`t=<unix>,v1=<hex>`.

See `docs/EMAILOCTOPUS_SETUP.md` for the merge fields and the "Started via API"
automation, which are separate from the webhook and equally required before a send.

---

## 5. Verify the deployment

```bash
npm run verify:deployment https://<host>
```

17 checks, exits non-zero on the first failure so it can gate a release. It covers what
the E2E suite structurally cannot, because E2E runs against localhost:

- the six security headers survive the platform, and HSTS actually reaches the browser
- an anonymous request to `/` redirects to sign-in, and that redirect is `no-store` — a
  shared CDN cache must never hand one operator's session to another
- `/api/contacts`, `/api/campaigns` and `/api/segments` answer 401 to an anonymous
  request, not 200
- all three webhook endpoints refuse an unsigned POST with 401 — not 200, and not a 5xx,
  which a provider treats as retryable
- `robots.txt` disallows crawling
- no server secret appears in the built chunks or in anything the host serves

The secret sweep scans the complete build output when run from the build directory, and
refuses to report a pass if it read nothing. An earlier version scanned only the scripts
the sign-in page references and passed confidently while missing the chunk that carries
the Supabase configuration entirely — a sweep that looked nowhere is indistinguishable
from a clean one unless it says so.

Run it against a local production build first:

```bash
npm run build && npx next start -p 3100 &
npm run verify:deployment http://127.0.0.1:3100
```

---

## 6. Order of operations

1. Client creates the Vercel project and points the subdomain at it.
2. Set every variable from §3, `NEXT_PUBLIC_APP_URL` to the final host.
3. Deploy. Confirm TLS and that the subdomain resolves.
4. `npm run verify:deployment https://<host>` — all 17 green before going further.
5. `npm run db:create-admin` if the admin account does not exist yet, and sign in.
6. Enter the EmailOctopus API key and list id in the app's settings screen.
7. Register the three webhooks (§4).
8. `npm run db:sync-job-types -- --dry-run` to confirm the contact book is classified.
9. Only then: create a segment, generate copy, approve, and send to a **test list of two
   or three of your own addresses**. Confirm the booking link in the received email is
   absolute and reachable before sending to anyone real.
