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

## Content Studio emails (20261007010000)

Campaigns can also be created from a Content Studio post (`Create email` on a variant).
The rules above all still apply; these are added.

| Guarantee | Mechanism |
| --- | --- |
| The approved content is an immutable snapshot | `campaign_content_snapshots` holds the fields, CTA mode and link, subject, published images (asset, published copy, checksum, alt, order) and the rendered HTML/text, with a SQL-computed `content_hash`. Rows cannot be updated or deleted. The campaign's `merge_fields`/`subject` mirror it and are locked (`CRM07 snapshot_content_locked`); new content means a new email from the Studio. |
| Approval binds to the snapshot | Approval records `approved_content_hash`; `begin_campaign_dispatch` refuses a send whose snapshot hash no longer matches. The approve route re-validates the snapshot against its template contract first (`assessContent`). |
| Each run keeps its evidence | `campaign_runs` is stamped (by trigger) with the snapshot, hash, automation and CTA mode it sent. |
| A run never mixes two versions | Editing the content of a failed campaign whose run already has `sent`/`uncertain` rows starts a new run and needs a new approval. Recipients already accepted stay visible in the old run's ledger. |
| Creation is idempotent and always a draft | `create_content_email_snapshot` creates snapshot + draft campaign in one transaction, keyed by the request's idempotency key. Stream, automation and contract come from the template only. Approving the post never approves the email. |
| Booking only when the email books | `executeCampaignSends` creates a booking and writes `BookingUrl` only in `booking` mode. `external_url` and `none` never do, and reserved fields (`BookingUrl`, `PrefsUrl`, `Newsletter`, `Courses`) are stripped from any content before it reaches the provider. The cron sends Studio campaigns without `NEXT_PUBLIC_APP_URL`; booking campaigns still need it. |

### Template contracts and delivery modes

`src/lib/marketing/templateContracts.ts`; the template pins one (`contract_id`/`version`),
frozen once a campaign uses it (`CRM06 template_in_use` → 409).

| Contract | What travels per contact | CTA modes | Sendable |
| --- | --- | --- | --- |
| `legacy-v1` | The seven fields + `BookingUrl` | booking | Always (unchanged) |
| `studio-static-v1` | Nothing (fixed HTML in a versioned Automation) | external_url, none | Always |
| `studio-newsletter-v1` | Preheader, Headline, Intro, Body, HeroImageUrl/Alt, CtaLabel, CtaUrl | external_url, none, booking | Only with `CONTENT_EMAIL_DYNAMIC_ENABLED=true` |

**Why dynamic is off.** Contact fields are shared: two campaigns writing the same
contact's fields can swap content before EmailOctopus renders the email (plan §8.2). Until
the provider matrix in `CONTENT_STUDIO_PROVIDER_VALIDATION.md` (EO-4, EO-5) proves the
content is fixed per delivery, a dynamic Studio draft can be created and reviewed but is
refused at approval, at preflight and at every send step. Switching the flag off stops
new deliveries of already-approved dynamic campaigns at the next chunk.

**HTML export** (`email-export`) renders the same email for a campaign managed in the
EmailOctopus dashboard. It is recorded as an export snapshot and is never reported as a
delivery.

### Preflight for Studio campaigns

`GET /api/campaigns/[id]/preflight` adds `studio`: contract problems, images that are not
the source revision's, provider fields missing for the contract, and a manual checklist
(the API cannot read Automation HTML): the template must not reference `{{BookingUrl}}`
for `external_url`/`none`; a static Automation must be the registered version.
`ready` is false while any problem remains.
