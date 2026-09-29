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
| Subdomain (e.g. `crm-ai4-l.vercel.app`) | `NEXT_PUBLIC_APP_URL` is baked into the build — see §3 | **Open** |
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
example changes — and refuses to push the ones that must never be set on Vercel at all,
naming each and why. The dashboard works too; the script exists because fifteen variables
done by hand is how a deployment ends up with a placeholder Stripe secret and a green
checkmark.

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
| `RESEND_API_KEY` | **Secret** | No confirmation email after checkout; the lead only has the redirect to reach the calendar |
| `BOOKING_EMAIL_FROM` | Server | Same as above. Must be a sender on a domain verified in Resend |
| `NEXT_PUBLIC_CALENDLY_SCHEDULING_URL` | Public | Nowhere to send a paid customer to book a time |
| `EMAILOCTOPUS_WEBHOOK_SECRET` | **Secret** | Newsletter subscribe/unsubscribe events are rejected with 401 |
| `PREFERENCES_SECRET` | **Secret** | Preference links cannot be signed: `PrefsUrl` is left off the contact and every email ships without a working unsubscribe |

#### `PREFERENCES_SECRET` signs every unsubscribe link, and rotating it breaks the old ones

Generate one, once, and keep it:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The signature is what stops somebody editing the contact id inside their own preference
link and unsubscribing the rest of the database one id at a time. It is deterministic on
purpose — the same contact always gets the same URL, so the sync can store it on the
EmailOctopus contact and every template, including newsletters sent from their dashboard,
carries the same working link.

Rotating the secret **invalidates every link already in somebody's inbox**. The token
format carries a `v1.` prefix so a future rotation can verify both, but until that is
built, treat rotation as a deliberate migration and not a routine hygiene step. If it
leaks, rotate anyway: a forged link changes consent, which is worse.

Without it the sync still runs and still pushes consent state; it just omits the link
field, and `GET /api/integrations/emailoctopus/fields` reports `PrefsUrl` as missing.

### Optional — the app degrades cleanly

| Variable | Scope | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Secret** | "Write with AI" returns a handled "not configured" error; copy can still be typed by hand |
| `GEOAPIFY_API_KEY` | **Secret** | Address autocomplete returns 503 with a clear message; addresses can still be typed |
| `CRON_SECRET` | **Secret** | `/api/cron/newsletters` refuses every call, so recurring newsletters are never drafted. "Generate now" still works |
| `CAMPAIGN_REVIEW_EMAILS` | Server | Scheduled newsletters still land in review with a badge on Campaigns, but nobody is emailed |
| `NOTIFY_EMAIL_FROM` | Server | Review notices are sent from `BOOKING_EMAIL_FROM` instead |

#### Recurring newsletters

The daily cron (`vercel.json`, 22:00 UTC ≈ 08:00–09:00 Sydney) drafts one campaign per
due schedule, writes its copy and moves it to review. It never sends. On the Hobby plan
Vercel runs it once a day at some point within that hour, which is all a weekly or
monthly newsletter needs. Test it after deploying with
`curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/newsletters` —
a second call must not create a second campaign for the same day.

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

Before deploying, validate configuration without making any provider changes:

```bash
npm run preflight
npm run preflight -- --online
```

Each feature is reported as **ready**, **intentionally disabled** (listed in
`CRM_DISABLED_FEATURES`), or **misconfigured**; only misconfigured fails. `core` and
`email-consent` (preference-link signing, consent webhooks) cannot be disabled. A missing
`PREFERENCES_SECRET` or `CRON_SECRET` used to pass silently; it now fails its feature.
Diagnostics name variables, never their values.

The online mode also proves the access boundary: public signup is disabled
(`/auth/v1/settings`), anonymous reads of `contacts`, `credentials` and `crm_members` are
refused, membership enforcement is installed, and an active administrator exists. It checks
the `active_contacts` column contract rather than just table existence.

The online mode confirms every required table and aggregate exists, the EmailOctopus list
is reachable, the Stripe Price is active at $500 AUD, the coupon is valid at 100% off for
one use, and the Calendly scheduling page resolves. It is read-only. After deployment,
include the final host to also prove `NEXT_PUBLIC_APP_URL` matches what was built:

```bash
npm run preflight -- --online https://<host>
```

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

## 5a. Environments

| Target | Supabase | Used by |
| --- | --- | --- |
| Local | `npx supabase start` (Docker), `supabase/config.toml`, signup disabled | development, `npm run db:verify`, E2E |
| CI | same local stack inside the runner | `.github/workflows/ci.yml` |
| Preview / production | hosted projects | deployment only |

`NEXT_PUBLIC_*` values are inlined at **build** time; server secrets are read at
**runtime**. Tests never read `.env.local` credentials for mutation: `scripts/seed-e2e.mjs`
refuses any non-local Supabase URL, and `npm run db:verify` refuses the linked project
without explicit confirmation.

## 6. Order of operations

1. Client creates the Vercel project and points the subdomain at it.
2. Disable public signup (docs/ACCESS_CONTROL.md). Apply migrations with
   `npx supabase db push`; it stops at `20261002000100_crm_membership_enforce` until an
   administrator is bootstrapped with `npm run db:member -- grant <email> admin`, then push
   again. Run the verification scripts against an isolated rehearsal database —
   `npm run db:verify` targets the local stack by default and refuses the linked project
   unless `DB_VERIFY_TARGET=linked DB_VERIFY_LINKED_REF=<ref>` confirms it.
3. Set every variable from §3, `NEXT_PUBLIC_APP_URL` to the final host.
4. Run `npm run preflight -- --online`; provider or schema failures block deployment.
5. Deploy. Confirm TLS and that the subdomain resolves.
6. Run both `npm run preflight -- --online https://<host>` and
   `npm run verify:deployment https://<host>` before going further.
7. `npm run db:create-admin` if the admin account does not exist yet (it also grants admin
   membership), and sign in. Grant other staff with `npm run db:member`.
8. As an administrator, enter the EmailOctopus API key and list id in the settings screen.
   The key is write-only and is never shown again.
9. Register the three webhooks (§4), then run the newsletter canary.
10. `npm run db:sync-job-types -- --dry-run` to confirm the contact book is classified.
11. Only then: create a segment, generate copy, approve, and send to a **test list of two
   or three of your own addresses**. Confirm the booking link in the received email is
   absolute and reachable before sending to anyone real.
