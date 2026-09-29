# Campaign delivery and consent synchronisation

Audit findings H3–H7 (and A2). Migrations `20261003000000_campaign_delivery.sql` and
`20261003010000_consent_outbox.sql`.

## What a send guarantees now

| Guarantee | Mechanism |
| --- | --- |
| Approved content is what is sent (H6) | `campaigns.revision` moves on every content change; approval records `approved_revision`; the database refuses `sending` unless they match. Content cannot change in review/approved/sending/sent. Editing a failed campaign returns it to draft and voids the approval. |
| The whole audience is prepared, once (H7) | `campaign_runs` + keyset-paged materialisation into `campaign_sends`, correct past PostgREST's row cap, resumable from a cursor. The database refuses `sending` until the run is `prepared`. Audiences over 10,000 are refused at approval and at send. |
| No recipient is claimed twice (H3) | `claim_campaign_sends` (`FOR UPDATE SKIP LOCKED`, lease + ownership token). Only the owner records an outcome (`complete_campaign_send`). |
| No automatic resend when the outcome is unknown (H3) | `provider_attempted_at` is written before the provider call. A worker that dies after it, a timeout, a dropped connection or a 5xx on the queue call → `uncertain`. Uncertain rows are never retried automatically. |
| A failed ledger write never reads as success (H3) | Every write is checked; the chunk halts (`LedgerWriteError`); the row becomes `uncertain` when its lease expires. |
| Consent is checked at dispatch (H4) | `begin_campaign_dispatch` re-checks consent for the campaign's stream and the contact's lifecycle atomically, right before the call. Withdrawal/archive also skips pending rows immediately. History is never rewritten. |
| Consent reaches the provider (H5) | A contacts trigger writes `consent_sync_outbox` in the same transaction. Workers push the contact's **current** state, one contact at a time, and settle all older entries — replays converge. Archived and removed contacts are included. |

Sends are driven by the operator's button **and** `/api/cron/jobs`, so a closed tab no
longer stalls a campaign. Both are safe at once.

## Recorded decisions (plan section 14)

1. **Approved audience (14.2).** Approval binds a revision, which includes the segment and
   consent stream; the audience count is checked and returned at approval. The recipient
   snapshot is materialised once per run at the first dispatch step, and after that only
   eligibility removals apply. Changing the segment or stream of a failed campaign starts a
   new run. *Not implemented:* showing the exact recipient list before approval — the count
   is shown; the list is available through "Recipients".
2. **Provider uncertainty (14.3).** EmailOctopus's queue endpoint has no idempotency key
   (checked against its v2 API reference; re-verify at release). Unknown outcomes become
   `uncertain`; an operator checks the automation's activity in EmailOctopus and settles them
   from the send report ("They received it" / "They did not, queue again").
3. **Accepted ≠ delivered.** "Sent" means EmailOctopus accepted the queue request.
4. **Withdrawal after acceptance.** A withdrawal that lands after EmailOctopus accepted a
   send cannot recall that email. The preference page says so.
5. **Sync loops.** Provider-originated changes (EmailOctopus webhooks) are queued too — they
   set the preference link and consent fields — but a write that changes nothing in the CRM
   creates no new version, so an echo terminates.

## Operations

- **Needs a person:** Operations panel → "Waiting on a person" (uncertain sends, expired
  claims, consent changes pending/failed).
- **Retry failed consent syncs** after fixing the cause: `select public.retry_failed_consent_sync();`
- **Cron:** `vercel.json` runs `/api/cron/jobs` daily (Hobby limit). On a plan that allows
  it, schedule it every 5–15 minutes; every job is idempotent.

## Release checklist (plan section 6, "Phase 2 rollout")

1. Inventory: `select id, status, send_run from campaigns where status in ('sending','failed');`
   Finish or deliberately pause active sends before migrating; do not run the old and new
   senders against the same campaign.
2. Apply both migrations. They backfill: existing approvals are bound to their current
   revision, runs with ledger rows are recorded as prepared, and every contact who has
   withdrawn all consent is queued for provider reconciliation (`reconciliation_20261003`).
3. Deploy the application.
4. Review any `pending`/`failed` rows from the old sender whose outcome is unclear before
   retrying them.
5. Run `/api/cron/jobs` once manually and watch the consent backlog drain in Operations.
6. Send to a test list of your own addresses first.

**Recovery:** pause by moving a campaign out of `sending` (dispatch checks it before every
call); the ledger is preserved. Do not roll back to the unclaimed sender against a migrated
ledger.

## Verification

- `npm run db:verify -- delivery` — revision binding, preparation gate, ownership, lease
  recovery to `uncertain`, dispatch-time consent, outbox enqueue.
- `npm run test:integration` (local stack) — real two-worker race, audience above the row
  cap, interrupted preparation, provider success followed by ledger failure, stale worker,
  consent convergence and backoff.
