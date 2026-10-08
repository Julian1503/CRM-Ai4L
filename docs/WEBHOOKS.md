# Webhooks, payments and bookings

How the CRM receives provider callbacks (Stripe, Calendly, EmailOctopus), how it makes sure each one is processed exactly once even when a process dies halfway, and what an operator does when something needs a person.

Audit findings: H10 (payment return/webhook race), H11 (claim lost after a process failure), M4 (Calendly rescheduling and event order).
Schema: `supabase/migrations/20261005000000_durable_webhooks_and_bookings.sql`, fixes in `20261008020000_webhook_fixes.sql`.
Verification: `npm run db:verify -- durable` and `src/lib/webhooks/webhooks.integration.test.ts`.

## 1. Authentication

The webhook routes carry no session cookie, so `src/proxy.ts` lets exactly these three paths through (`WEBHOOK_PATHS` in `src/lib/auth/routes.ts`), and each route authenticates the request itself before trusting any byte of it. Every route reads the raw body with `request.text()` first; parsing and re-serialising would change the bytes the signature covers.

| Provider | Route | Signature | Secret |
| --- | --- | --- | --- |
| Stripe | `POST /api/stripe/webhook` | `Stripe-Signature`, checked by `stripe.webhooks.constructEvent` (timestamped, replay window set by Stripe) | `STRIPE_WEBHOOK_SECRET` |
| Calendly | `POST /api/calendly/webhook` | `Calendly-Webhook-Signature: t=<unix>,v1=<hmac-sha256 of "t.body">`, 300 s tolerance (`src/lib/webhooks/verify.ts`) | `CALENDLY_WEBHOOK_SECRET` |
| EmailOctopus | `POST /api/integrations/emailoctopus/webhook` | `EmailOctopus-Signature: sha256=<hmac of body>` (no timestamp; replays are absorbed by the ledger) | `EMAILOCTOPUS_WEBHOOK_SECRET` |

A missing secret fails closed (401). An invalid signature is answered with a terse 401 and logged without detail. Only after verification does a route use the service-role client.

## 2. The idempotency ledger

`public.webhook_events` holds one row per `(provider, event_id)`. The event id is the provider's own id (Stripe event id, the Calendly webhook id header, the EmailOctopus event id); without one, a SHA-256 of the event payload is used (`deriveEventId`), which is stable because a genuine retry replays identical content. EmailOctopus batches many events per request, so each event is claimed on its own.

| Status | Meaning | A redelivery gets |
| --- | --- | --- |
| `processing` | Claimed under a lease (`claim_token`, `lease_expires_at`, default 120 s) | `in_progress` (the route answers 503 so the provider retries) while the lease is live; after it expires the redelivery **takes the event over** |
| `completed` | Processed | `completed` (the route answers 200 "duplicate") |
| `failed_retryable` | Processing failed in a way a retry can fix (database error, payment not recorded yet) | taken over immediately |
| `failed_terminal` | Cannot ever succeed (unexpected checkout, mismatched payment) | `completed` (acknowledged, never reprocessed) |

Functions (service role only): `claim_webhook_event(provider, event_id, type, lease_seconds)` returns `claimed` + token, `completed` or `in_progress`; `complete_webhook_event(provider, event_id, token, status, error)` settles it and returns `false` for a token that no longer owns the event. `attempts` counts claims; `last_error` keeps at most 500 characters and never contains a payload.

**Business change and completion commit together.** `apply_checkout_payment` and `apply_calendly_event` take the claim and complete the event in the same transaction as the booking change, so a crash can never leave a booking changed but the event retryable, or the event completed but the booking untouched. EmailOctopus consent events complete in a second call; that is safe because applying them is idempotent and a lost completion simply expires into a retry.

**A process that dies after its claim** leaves a `processing` row whose lease expires. The provider's next retry takes it over, processes it once, and the dead worker's token can no longer settle it.

### Legacy rows

Rows written before 20261005000000 only proved that an event had been *claimed*, not that it was processed. They were migrated as `status = 'completed'`, `legacy = true`, `completed_at = received_at`, so they are acknowledged as duplicates and never reprocessed automatically. To find ones that may have been lost:

```sql
-- Stripe checkouts claimed before the ledger had outcomes whose booking never got paid.
select w.event_id, w.received_at
  from public.webhook_events w
 where w.legacy and w.provider = 'stripe' and w.event_type = 'checkout.session.completed';
```

For each, look the event up in the Stripe dashboard and compare with the booking (metadata `booking_id`). If the booking is still `pending`/`checkout_started` but Stripe shows the checkout complete, resend the event from the Stripe dashboard **after** setting the legacy row aside (`update public.webhook_events set status = 'failed_retryable', legacy = false where provider = 'stripe' and event_id = '<id>'`), so the redelivery is taken over and applied through the normal path. Calendly legacy events are reconciled the same way from the Calendly dashboard; EmailOctopus consent is reconciled by a manual sync.

## 3. Payment (H10)

The return page (`/book/[token]/scheduled`, browser-first) and the Stripe webhook both call `apply_checkout_payment` — the single payment operation. It locks the booking and:

- refuses a checkout whose id is not the one the booking recorded, a non-zero amount or a currency other than AUD (`mismatch`; the webhook event becomes `failed_terminal`);
- answers `not_ready` when the booking has not recorded its checkout yet (the webhook beat the checkout's own write) — the event stays `failed_retryable` and Stripe's retry applies it;
- marks a `pending`/`checkout_started` booking `paid` (`applied`) and queues one confirmation email in `notification_outbox` with the unique key `booking-paid:<booking id>`;
- treats the same checkout reported again as success without moving anything (`already_applied`), even for a booking that is already `booked` or `cancelled`.

So browser-first, webhook-first, duplicates, delayed deliveries and both at once all end with one paid booking and one logical email, and a different checkout can never claim the booking.

**Confirmation email.** `notification_outbox` is drained by `processNotifications` (inline after a payment, and by the scheduled worker): claimed under a lease, sent with Resend's idempotency key `booking-paid-<id>`, settled as `sent`, `skipped` (nothing to send) or `retry` with exponential backoff (2^attempts minutes, capped at 6 hours). After eight attempts it is `failed` and visible. If Resend is not configured the email stays queued, so enabling it later still sends it. Email failures never touch the payment.

## 4. Calendly (M4)

`apply_calendly_event` applies `invitee.created` and `invitee.canceled` in any order:

- **Create** books the booking that (1) held the old invitee, when Calendly says this is a reschedule; else (2) the booking named by the tracking id, only if the invitee's email is that booking's contact (the id travels through an editable URL) and the booking is still `paid`; else (3) the contact's most recent `paid` booking. A booking that is already `booked` only moves through an explicit reschedule — an unrelated second appointment cannot take it over. A create for an invitee a booking already holds is a duplicate (`ignored`).
- **Cancel** of the invitee a booking holds cancels it; a cancel flagged `rescheduled` instead retires that invitee (`calendly_superseded_invitees`) and keeps the booking booked.
- **Retired invitees** are ignored forever, so an old slot's late create or cancel cannot touch its replacement.
- **Unplaceable events** (cancel before create, create before the payment is recorded) are parked in `booking_reconciliation` with everything needed to replay them, including the reschedule flag, and the scheduled worker (`src/lib/jobs/runJobs.ts`) replays them oldest first for seven days. A replay that applies — or finds nothing left to do — marks the row resolved.

## 5. Retries and leases at a glance

| Work | Lease | Retry | Gives up |
| --- | --- | --- | --- |
| Webhook event | 120 s | the provider's own redelivery | `failed_terminal` only for unfixable input |
| Confirmation email | 120 s | backoff 2, 4, 8 … minutes, max 6 h | after 8 attempts → `failed` |
| Parked Calendly event | — | every scheduled run | after 7 days → left for a person |

## 6. Operator runbook

| Symptom | Check | Action |
| --- | --- | --- |
| Booking stuck at `checkout_started` though the client finished checkout | Stripe dashboard → the event's deliveries; `select status, attempts, last_error from webhook_events where provider='stripe' and event_id='<evt>'` | A `failed_retryable` / expired `processing` event is retried by Stripe automatically; resend it from Stripe to hurry. `failed_terminal` means the checkout did not match the booking — investigate before doing anything. |
| Booking stuck at `paid` | Calendly webhook subscription (requires a paid Calendly plan); unresolved `booking_reconciliation` rows for the client's email | Fix the subscription; parked events replay on the next scheduled run. A row older than a week needs a person: set the booking by hand, then `update booking_reconciliation set resolved_at = now(), resolution = 'manual: <note>' where id = '<id>'`. |
| Confirmation email not received | `select status, attempts, last_error from notification_outbox where booking_id='<id>'` | `pending` = will retry; `failed` = fix the cause (Resend key, domain), then `update notification_outbox set status='pending', attempts=0, next_attempt_at=now() where id='<id>'`. |
| Webhook answers 401 | Secret configured? Clock skew (Calendly 300 s)? Header name? | Rotate/set the secret in the deployment and in the provider. |
| Webhook answers 503 repeatedly | A `processing` event whose lease never expires is impossible (leases are 120 s); repeated 503 means deliveries overlap — wait one lease | None needed; the next retry completes it. |

Nothing here is ever physically deleted; resolve rows instead.
