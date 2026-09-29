# Production audit remediation plan

Date: 2026-09-28  
Status: Implementation in progress — see the tracker in section 15.  
Source: Comprehensive repository and application audit in the accompanying conversation.

## 1. Purpose and scope

Resolve every finding from the production audit through small, reviewable changes. Prioritize access control, data integrity, consent, and reliable external operations before structural refactoring and interface polish.

This plan covers findings C1, H1–H12, M1–M7, L1, P1–P3, A1–A2, and T1–T2. It supplements the historical root `PLAN.md` and `docs/UX_IMPLEMENTATION_PLAN.md`. Their earlier completion labels do not establish that the newly identified failure cases are resolved.

Writing this plan does not change application behavior or authorize production operations. Deployment, credential rotation, provider changes, and data repair remain explicit execution steps when implementation is undertaken.

### Evidence and uncertainty

- **Confirmed:** observed behavior, isolated reproduction, or directly verified configuration/code defect.
- **Likely:** a concrete failure path established from code, without exercising the complete live workflow.
- **Improvement:** an evidenced usability, performance, or maintenance weakness.
- **Idea:** a product change tied to an existing workflow.

Before implementing a likely issue, add a failing regression case or document the exact invariant that is missing. Do not convert an unverified production consequence into a factual incident claim.

### Audit baseline

| Verification | Observed result |
| --- | --- |
| Production build | Passed |
| Typecheck | Passed on rerun after build |
| Lint | Passed with 136 warnings, including non-application files |
| Jest coverage run | 115 suites and 1,794 tests passed |
| Coverage | 93.75% statements; 82.01% branches |
| Public Chromium E2E | 30 passed; 1 skipped |
| Authenticated Chromium E2E | 9 passed; 2 failed on stale interface assumptions |
| Local preflight | 13/13 passed despite missing feature configuration |
| Local deployment verifier | 17/17 passed |
| Production dependency audit | Six affected packages reported |
| Additional reproductions | Duplicate recipient dispatch, ignored ledger-write failure, stale search responses |

These results belong to the snapshots tested during the audit. They must be rerun against the final integrated revision. No real campaign send, payment, public-account creation, or destructive data test was performed during the audit.

## 2. Coordinate with the soft-delete work

Another agent is implementing archive/removal behavior across entities. The working tree continues to change, including contact, archive, template, and marketing interfaces.

- [ ] Record the baseline commit and outstanding changes before implementation starts.
- [ ] Identify which archive/removal changes have landed and which remain in progress.
- [ ] Avoid overwriting unrelated modifications or introducing a competing lifecycle model.
- [ ] Recheck the contact-view refresh and contacts-RLS migrations added during the audit.
- [ ] Replay all migrations in a disposable database and run the archive verification suites.
- [ ] Verify every public/database/API access path against the integrated lifecycle rules.
- [ ] Recheck audit locations after integration; line numbers and implementation details may move.

The earlier contact-view mismatch and anonymous-contact exposure are **verification items**, not assumed outstanding defects. The final anonymous contact read during the audit returned 401. Explicit membership authorization and open signup remain separate concerns.

Lifecycle rules that this plan must preserve:

1. Ineligible, archived, or removed contacts must not become eligible for dispatch through a retry.
2. Consent withdrawal must still reach the provider when the CRM contact leaves active views.
3. Archiving must preserve the evidence needed to explain campaign and booking history.
4. Restoration must not silently grant consent or revive completed external work.
5. New service boundaries must respect the distinction between archive, removal, and restoration established by the concurrent work.

## 3. Delivery sequence

| Phase | Objective | Findings | Dependency / release gate |
| --- | --- | --- | --- |
| 0 | Stable baseline and trustworthy verification | T1, T2; lifecycle verification | Dedicated test data and integrated schema |
| 1 | Approved-user access and secret containment | C1, H1, H2, M7 | Keep legitimate admin access; prove negative access tests |
| 2 | Approved, complete, consent-aware campaign delivery | H3–H7 | Membership policies and durable database operations |
| 3 | Atomic contact edits and safe imports | H8, H9, P3 | Integrated lifecycle schema and authorization |
| 4 | Recoverable payments, webhooks, bookings, and schedules | H10–H12, M4 | Durable work and retry conventions agreed in Phase 2 |
| 5 | Correct everyday interface behavior | M1–M3, M5, L1, P1, P2 | Stable API contracts; shared-file coordination |
| 6 | Smaller bundles and simpler maintenance | M6, A1, A2 | Correct business boundaries before extraction |
| 7 | Integrated release and operational handoff | All | All mandatory acceptance criteria pass |

Do not wait for every Phase 0 improvement before containing unintended signup and credential access. Phases 3 and 4 can proceed independently after their prerequisites are met. Small search/accessibility fixes can land earlier if they do not conflict with active changes.

Every implementation PR should include its finding IDs, changed behavior, regression evidence, migration/configuration impact, and rollback or recovery notes.

## 4. Phase 0 — Establish a reliable baseline

### 4.1 Test environment and authenticated CI — T1

**Locations:** `.github/workflows/ci.yml`, `playwright.config.ts`, `src/e2e/auth.setup.ts`, `src/e2e/smoke.spec.ts`.  
**Effort:** Medium.

Tasks:

- [ ] Use a dedicated Supabase test project or a local stack with deterministic seed data.
- [ ] Remove the mismatch between placeholder Supabase configuration and real E2E login credentials.
- [ ] Seed an approved administrator, approved ordinary operator, authenticated unapproved user, and disabled member.
- [ ] Keep provider operations mocked or in provider test environments. Do not run mutation tests against the linked business database.
- [ ] Update the obsolete `Subscribed` filter expectation to the current user-facing workflow.
- [ ] Open the relevant campaign form before checking automation configuration; assert approval behavior rather than an old placeholder string.
- [ ] Keep sign-out isolated and last so it cannot invalidate concurrent authenticated tests.
- [ ] Distinguish intentionally skipped optional tests from required tests that could not run.

Acceptance:

- [ ] Authenticated CI connects to the intended test environment and fails if required setup is missing.
- [ ] Public and authenticated browser suites pass without weakening meaningful assertions.
- [ ] Test output records which environment and revision were tested without printing secrets.

### 4.2 Database and fault-injection verification — T2

**Locations:** `supabase/tests`, `supabase/migrations`, existing marketing/booking/webhook tests.  
**Effort:** Large, spread across implementation phases.

- [ ] Replay migrations from an empty database and from a representative pre-change schema.
- [ ] Verify view columns, grants, policies, triggers, and lifecycle constraints against the real database engine.
- [ ] Provide isolated adapters for provider success, rejection, timeout, and ambiguous completion.
- [ ] Add barriers for deterministic concurrent-worker tests rather than relying on sleeps.
- [ ] Inject failures at persistence boundaries and process-restart boundaries.
- [ ] Generate database types from the verified test schema and review any generated changes.
- [ ] Add each regression case with its corresponding fix; do not substitute a coverage percentage for behavioral acceptance.

Acceptance: test infrastructure can reproduce a duplicate-send race, a failed post-provider write, and a transaction rollback without contacting real recipients or modifying business records.

## 5. Phase 1 — Access, credentials, dependencies, and configuration

### 5.1 Enforce approved membership — C1

**Evidence:** Supabase email signup was enabled; session validation established identity but not approved CRM membership.  
**Locations:** `src/lib/auth/dal.ts`, authenticated API guards, database policies, account provisioning documentation.  
**Effort:** Medium.

Implementation:

1. Disable public signup for the intended invite-only deployment and verify the setting independently.
2. Inventory operations and define an explicit permission matrix. Proposed starting point: approved operators can perform authorized daily CRM work; administrators manage membership and integration secrets; campaign approval and bulk removal receive explicit permissions.
3. Decide whether approval requires a different person from the author. Do not silently introduce that product restriction.
4. Add a membership record tied to the verified auth user ID, with active/disabled state and the agreed role or permissions.
5. Make server guards fail closed for missing or disabled membership. Never trust client-supplied membership or role claims.
6. Replace broad `authenticated` database access with membership-aware policies. Cover direct REST access, RPCs, views, storage if applicable, and table grants.
7. Audit privileged SQL functions for execution grants, safe search paths, and resource-specific checks.
8. Bootstrap the current legitimate administrator through a controlled migration/provisioning step before enforcing access.
9. Review existing auth accounts; do not automatically promote every existing account to approved staff.
10. Document invitation, removal, permission changes, and session revocation behavior.

Acceptance and tests:

- [ ] Anonymous, self-registered/unapproved, and disabled accounts cannot read or modify CRM data through either APIs or direct Supabase calls.
- [ ] Approved users can perform only their assigned operations.
- [ ] Changing a resource ID cannot bypass the applicable permission check.
- [ ] Removing membership blocks subsequent protected operations, including with an existing session.
- [ ] The administrator retains a verified recovery/provisioning path.

Rollout: stage membership and bootstrap first, deploy compatible guards, then enforce policies and grants. A rollback must retain the restrictive security boundary; never restore broad public/authenticated access as a recovery shortcut.

### 5.2 Keep integration credentials server-only — H1

**Locations:** `src/app/page.tsx` credential loading/saving, `credentials` policies, provider configuration readers.  
**Effort:** Medium. **Dependency:** 5.1 permission matrix.

- [ ] Remove raw credential values from browser queries, state, responses, rendered HTML, and client logs.
- [ ] Restrict the credential store to approved server-side access. Choose the existing secured store or deployment secret storage based on whether runtime administrator replacement is required.
- [ ] Return only configuration status and safe metadata to the settings UI.
- [ ] Add an administrator-only replacement operation. Never return the saved value; distinguish unchanged, replaced, and intentionally cleared inputs.
- [ ] Ensure ordinary contact loading never fetches secrets.
- [ ] Audit provider-key logging and error serialization.
- [ ] After closure, review available access evidence and rotate the exposed EmailOctopus credential. Do not claim exfiltration without evidence.

Acceptance: no authenticated browser role can select the raw key; authorized replacement works; the provider continues working after rotation; tests inspect network responses as well as built assets.

### 5.3 Patch affected dependencies — H2

**Locations:** `package.json`, lockfile, spreadsheet parsing, Next.js configuration.  
**Effort:** Medium.

- [ ] Re-run the production dependency audit and check current official advisories when implementation begins.
- [ ] Select supported patched Next.js and matching tooling versions; read the installed Next.js guides and release notes before changing code.
- [ ] Update SheetJS using its maintained distribution; verify provenance and lockfile integrity.
- [ ] Resolve affected transitive dependencies through supported parent updates where possible.
- [ ] Record applicability for any remaining advisory, including the hosting-OS condition of the Windows-specific Next.js advisory.
- [ ] Retest login/server actions, routing, production build, CSV/XLS/XLSX handling, malformed files, and file limits.

Acceptance: no unaddressed applicable critical/high production advisory; any exception includes exposure analysis and a dated follow-up. Do not replace libraries merely to change style.

### 5.4 Make readiness checks feature-aware — M7

**Locations:** `scripts/preflight.mjs`, `scripts/verify-deployment.mjs`, `.env.local.example`, `docs/DEPLOYMENT.md`.  
**Effort:** Small–Medium.

- [ ] Validate preference signing, cron authentication, and enabled email-delivery configuration.
- [ ] Represent each feature as ready, intentionally disabled, or misconfigured.
- [ ] Check current schema/view contracts and membership enforcement, not just table existence.
- [ ] Verify signup configuration using a suitable read-only administrative check.
- [ ] Document build-time public configuration versus runtime private secrets.
- [ ] Separate local, preview/test, and production targets in the runbook; ensure tests cannot silently use production credentials.
- [ ] Keep secret values out of diagnostics.

Acceptance: deleting a required setting makes its enabled feature fail readiness; intentionally disabled features are explicit; the previous all-green/missing-secret case becomes a regression test.

## 6. Phase 2 — Campaign delivery and consent

### 6.1 Bind approval to immutable campaign content — H6

**Locations:** campaign update, approve, reopen, and send routes; campaign state triggers.  
**Effort:** Medium–Large.

- [ ] Define a campaign revision containing the approved content, provider automation, consent stream, and audience definition.
- [ ] Record who approved which revision and when.
- [ ] Prevent changes to an approved/sending revision through both API and direct database operations.
- [ ] Use expected revision/status conditions for edits and state transitions; return a conflict when another operator has changed the campaign.
- [ ] Allow retry only against the original approved revision and original run semantics.
- [ ] Editing a failed campaign creates or returns to a reviewable draft and invalidates approval.
- [ ] Define whether review approves an audience rule or an exact snapshot. Recommended: prepare and show the run snapshot before final approval, then allow only eligibility removals at dispatch.
- [ ] Preserve historical ledger/revision associations when reopening a campaign for a new run.

Acceptance: edit-versus-approve races cannot alter approved content; changed failed campaigns cannot send without renewed approval; retry never substitutes a new segment for an old recipient ledger.

### 6.2 Prepare the complete audience — H7

**Locations:** `src/lib/marketing/segments.ts`, campaign preflight/send/audience endpoints.  
**Effort:** Medium. **Dependency:** agreed revision and audience semantics.

- [ ] Replace a single large range request with bounded, stable pagination or a database operation that materializes the run audience.
- [ ] Account for database API response caps rather than assuming requested page size equals returned size.
- [ ] Ensure audience preparation has a durable completion state; dispatch cannot begin from a partially prepared run.
- [ ] Compare expected and materialized counts using snapshot-consistent semantics. A changing live audience must not make this comparison meaningless.
- [ ] Preserve uniqueness per campaign run and contact across resumed preparation.
- [ ] If a business cap remains, block and explain it before approval/sending.

Acceptance: datasets above the API row limit and above 10,000 members are either fully prepared or explicitly rejected; no successful run silently omits a suffix; interrupted preparation resumes without duplicates.

### 6.3 Claim recipients atomically and persist outcomes — H3

**Locations:** `src/lib/marketing/send.ts`, campaign send route, campaign-send schema and summaries.  
**Effort:** Large. **Dependencies:** 6.1 and 6.2.

Implementation:

1. Introduce a database claim operation that selects eligible pending recipients and assigns a lease atomically, using row locks or an equivalent conditional update.
2. Give each claim an ownership token and expiration. Updates from stale workers must not overwrite a newer claim.
3. Distinguish pending, processing, successful queueing, failed, skipped, and uncertain outcomes. Map these to existing public statuses deliberately.
4. Check every database write result, including deferred/error annotations.
5. Keep provider calls outside long-running database transactions.
6. Verify whether the provider supports idempotency or querying a stable action identity. Use it where supported.
7. Treat a provider timeout after possible acceptance as uncertain. Do not blindly resend when the external outcome is unknown.
8. Recover expired claims through reconciliation; an expired lease alone is not proof that no email was queued.
9. Bound processing work to the hosting runtime. Use resumable durable jobs rather than relying on a browser staying open.
10. Keep provider acceptance separate from actual delivery; UI summaries must describe what is known.

Acceptance and fault tests:

- [ ] Two workers claiming one pending recipient produce one active owner and one provider action in the successful deterministic case.
- [ ] A stale worker cannot commit a result over a replacement worker.
- [ ] Failure before the provider call is safely retryable.
- [ ] Provider success followed by ledger failure becomes recoverable/uncertain, never falsely complete.
- [ ] Process termination after a provider request does not trigger an unqualified duplicate resend.
- [ ] Counts reconcile with the ledger and distinguish skipped/uncertain recipients.

Do not promise exactly-once email delivery without provider support. The system must make uncertainty visible and prevent unsafe automatic retries.

### 6.4 Enforce consent at dispatch — H4

**Locations:** recipient claim/dispatch logic, consent mutation operations, lifecycle transitions.  
**Effort:** Medium. **Dependencies:** 6.3 and integrated soft-delete rules.

- [ ] Check the current consent stream and lifecycle eligibility when claiming a recipient and immediately before dispatch.
- [ ] Mark ineligible recipients skipped with a durable reason.
- [ ] Invalidate pending work when consent is withdrawn, while retaining the dispatch check for races.
- [ ] Apply the same rule to resumed chunks, failed retries, and reopened runs.
- [ ] Define and document the boundary for a withdrawal that arrives after the provider has already accepted a send. Do not imply that an accepted external email can always be recalled.

Acceptance: withdrawing consent or archiving a contact after preparation but before dispatch suppresses that recipient; a change to one stream does not incorrectly alter the other; historical outcomes remain intact.

### 6.5 Synchronize consent durably — H5

**Locations:** preferences route, `apply_contact_consent`, manual edits/imports, EmailOctopus sync.  
**Effort:** Medium. **Dependencies:** lifecycle semantics and durable work conventions.

- [ ] Write an outbox entry in the same transaction as every relevant consent change.
- [ ] Include contact identity, consent version, desired provider state, and retry metadata without copying unnecessary personal data.
- [ ] Process changes with retry/backoff and visible failure status.
- [ ] Ignore or supersede stale versions so delayed work cannot re-enable a withdrawn subscription.
- [ ] Include archived/removed records when provider suppression is still required; do not rely on `active_contacts` for this work.
- [ ] Reuse the same durable path for preferences, manual contact edits, imports, and provider-originated changes where applicable; prevent synchronization loops.
- [ ] Distinguish “preferences saved in CRM” from “provider synchronization pending/failed.”

Acceptance: provider failure does not lose the update; archive does not prevent suppression; replayed old work cannot override newer consent; duplicate outbox processing converges on the same desired state.

### Phase 2 rollout

- [ ] Inventory active campaign runs before migrating send states.
- [ ] Add compatible schema first, then deploy the new worker/claim logic.
- [ ] Drain or deliberately suspend old workers; do not allow old and new dispatch paths to compete.
- [ ] Preserve all existing successful-send evidence.
- [ ] Review pending/failed records with uncertain provider outcomes before retrying them.
- [ ] Reconcile provider consent from authoritative CRM evidence, especially contacts excluded from active views.
- [ ] Release using test recipients first, then a controlled real run when authorized.

Recovery: disable dispatch while preserving the ledger if correctness is uncertain. Do not roll back to the unclaimed sender against partially migrated work.

## 7. Phase 3 — Contact and import integrity

### 7.1 Save contacts and relationships atomically — H8

**Locations:** `src/app/page.tsx` save handler, contact API/repository, contact-service relationships.  
**Effort:** Medium. **Dependencies:** membership authorization and lifecycle integration.

- [ ] Move contact, organisation resolution, and service relationship updates into a validated transactional operation.
- [ ] Match organisation identity using the same normalization as its unique constraint.
- [ ] Validate referenced services, organisation, and permitted lifecycle transitions on the server/database boundary.
- [ ] Include the expected contact revision or timestamp and return a clear edit-conflict response.
- [ ] Enqueue provider synchronization transactionally where required.
- [ ] Keep the drawer open with the user's draft after validation, conflict, or network failure.
- [ ] Disable duplicate submission while saving; make retried create requests safe where needed.

Acceptance: any failure rolls back the whole contact edit; invalid service IDs do not delete existing relationships; conflicting editors cannot silently overwrite one another; success refreshes the canonical saved state.

Data review: inspect available history for suspicious missing service relationships. Repair only when prior state is supported by evidence; do not infer services from guesswork.

### 7.2 Preserve omitted import fields — H9

**Locations:** `src/lib/excelParser.ts`, `src/lib/contacts/import.ts`, bulk-import database function.  
**Effort:** Small–Medium.

- [ ] Represent unmapped, explicitly empty, and explicitly false values separately.
- [ ] Preserve existing customer status when its column is not mapped.
- [ ] Apply deliberate defaults only to newly created contacts.
- [ ] Extend field-presence semantics through validation, payload serialization, and SQL upsert logic.
- [ ] Verify other optional fields follow their intended preserve/clear behavior.
- [ ] Preserve current consent and lifecycle protections when handling existing and removed contacts.
- [ ] Test repeated import of the same file and define duplicate rows within one file.

Acceptance: importing a customer's name/email without a customer column preserves customer status; mapped false remains an intentional supported change; validation and SQL agree on omission semantics.

### 7.3 Show an import change preview — P3

**Locations:** importer mapping/review UI and preview endpoint.  
**Effort:** Medium. **Dependency:** 7.2.

- [ ] Show new, changed, unchanged, and rejected record counts.
- [ ] Highlight customer-status and consent changes and explain unmapped-field behavior.
- [ ] Provide representative row-level differences and downloadable validation errors when useful.
- [ ] Revalidate at commit. If affected records changed after preview, report conflicts rather than silently applying an obsolete preview.
- [ ] Preserve the upload/mapping state after a recoverable failure.

Acceptance: the operator can determine material consequences before import; the committed result reports actual outcomes and disagreements with the preview.

## 8. Phase 4 — External event and schedule recovery

### 8.1 Separate webhook receipt from completion — H11

**Locations:** `src/lib/webhooks/idempotency.ts`, Stripe/Calendly/EmailOctopus handlers, event schema.  
**Effort:** Medium–Large.

- [ ] Persist received, processing, completed, retryable-failure, and terminal-failure outcomes or equivalent states.
- [ ] Add claim ownership, attempt metadata, and an expiring processing lease.
- [ ] A duplicate completed event is successful; a duplicate incomplete event must remain recoverable.
- [ ] Couple database business changes with completion in one transaction where possible.
- [ ] Use durable outbox jobs for external side effects triggered by a webhook.
- [ ] Preserve signature verification on the raw request body before trusting payload data.
- [ ] Keep payload retention minimal and redact sensitive diagnostics.
- [ ] Define reconciliation for historical claimed events: prior rows do not necessarily prove processing completed.

Acceptance: terminate after claim, restart, and redeliver; the event completes once without losing business work. Also test duplicate delivery, expired ownership, and database failure before completion.

### 8.2 Make payment confirmation idempotent — H10

**Locations:** booking scheduled page, `markBookingPaid`, Stripe webhook, paid-email work.  
**Effort:** Medium. **Dependency:** 8.1.

- [ ] Share a single payment-application operation between return-page reconciliation and webhook handling.
- [ ] Verify checkout session identity, booking association, expected amount/currency, and supported zero-payment discount behavior.
- [ ] Treat an already-applied matching checkout as success without moving a booked/cancelled record backward.
- [ ] Reject a conflicting checkout identity rather than accepting every already-paid record.
- [ ] Enqueue the confirmation email durably with a unique business identity.
- [ ] Retry email failure independently of payment state.

Acceptance: browser-first, webhook-first, duplicate webhook, and delayed delivery all converge to the correct booking state and one logical confirmation job. A different checkout cannot claim the booking.

### 8.3 Reconcile Calendly rescheduling and delivery order — M4

**Locations:** Calendly webhook, booking repository and status rules.  
**Effort:** Medium. **Dependency:** 8.1.

- [ ] Preserve provider event/invitee identities and explicit rescheduling relationships where available.
- [ ] Distinguish replacement of an appointment from final cancellation.
- [ ] Retain unmatched relevant events for bounded reconciliation rather than permanently discarding them.
- [ ] Ensure cancellation for an old appointment cannot cancel its replacement.
- [ ] Verify tracking identifiers against the intended booking/contact; do not treat client-controlled tracking content as authorization.
- [ ] Keep operations staff informed when a booking requires reconciliation.

Acceptance: create-then-cancel, cancel-then-create, duplicated events, and replacement-before-original events converge correctly. Unrelated appointment events cannot modify another booking.

### 8.4 Persist scheduled occurrences before advancing — H12

**Locations:** `src/lib/marketing/schedules/runDue.ts`, schedule/campaign schema, cron route.  
**Effort:** Medium.

- [ ] Create a unique durable occurrence keyed by schedule and intended occurrence time.
- [ ] Advance `next_run_at` atomically with occurrence creation, or use an equivalent operation that cannot lose the occurrence.
- [ ] Process drafting/generation as resumable work with explicit attempt and failure states.
- [ ] Make campaign creation, topic allocation, and review submission safe to retry.
- [ ] Define catch-up behavior after downtime: process missed occurrences, coalesce them, or skip with an explicit recorded reason.
- [ ] Verify schedule timezone and daylight-saving transitions and disclose the actual execution window imposed by cron frequency.
- [ ] Show failed occurrences with a retry action and useful diagnostics.

Acceptance: failures after claiming, template loading, generation, draft creation, or topic selection cannot silently skip or duplicate an occurrence. Two scheduler workers cannot create two campaigns for the same occurrence.

Data review: identify schedules whose next run advanced without a corresponding campaign. Restore missed work only after checking for existing drafts and operator intent.

## 9. Phase 5 — Interface correctness and usability

### 9.1 Prevent stale contact results — M1

**Location:** `src/app/page.tsx` contact loader. **Effort:** Small.

- [ ] Cancel obsolete requests and protect all related state updates with a current-request identity.
- [ ] Debounce free-text search without delaying explicit filter/page changes unnecessarily.
- [ ] Keep loading, errors, counts, selected rows, and export context consistent with the displayed query.
- [ ] Reset selection deliberately when its meaning changes.

Acceptance: a delayed older response cannot overwrite a newer search; export criteria match the visible result context; aborts do not appear as user-facing failures.

### 9.2 Distinguish errors from empty data — M2

**Locations:** marketing loaders, dashboard counts, reference-data loaders. **Effort:** Small–Medium.

- [ ] Handle every non-success HTTP response and Supabase error result.
- [ ] Use explicit initial loading, loaded-empty, stale-with-error, and failed states.
- [ ] Preserve usable previous data and provide targeted retry actions.
- [ ] Do not report failed count queries as zero or leave success-looking controls dependent on unavailable data.
- [ ] Announce meaningful status changes accessibly without excessive live-region noise.

Acceptance: injected endpoint failures produce visible, actionable feedback; retry recovers the affected section; successful empty responses display genuine empty states.

### 9.3 Correct ordering and page boundaries — M3

**Locations:** contact query/repository, CSV exports. **Effort:** Small–Medium.

- [ ] Order organisations by their displayed name with documented null/case behavior.
- [ ] Append a unique contact ID tie-breaker to every paginated order.
- [ ] Use the same ordering semantics in the table and exports.
- [ ] Define consistency for multi-page exports during concurrent edits; stable ties alone do not solve offset shifts caused by mutations.

Acceptance: alphabetical organisation ordering works; equal status/name values paginate deterministically; export tests include ties and concurrent-change handling.

### 9.4 Correct contrast and field naming — M5, L1

**Locations:** `src/app/globals.css`, `src/components/ContactDrawer.tsx`. **Effort:** Small.

- [ ] Adjust semantic color pairs for normal text, large text, controls, hover, and disabled states as applicable.
- [ ] Preserve the established cyan/light visual direction.
- [ ] Associate the Notes textarea with a visible label or heading.
- [ ] Recheck focus visibility, drawer focus trapping, Escape dismissal, and return focus after these changes.

Acceptance: normal text combinations meet 8.5:1 and applicable large-text combinations meet 3:1; Notes has a useful accessible name; keyboard behavior remains intact. Verify actual rendered combinations, not only isolated token values.

### 9.5 Prioritize mobile contact work — P1

**Locations:** dashboard summary and contact layout. **Effort:** Small–Medium.

- [ ] Compact or collapse the five statistics on narrow screens.
- [ ] Bring search and primary contact actions into the opening task area.
- [ ] Prioritize useful contact columns and preserve access to secondary fields.
- [ ] Prevent bottom navigation from covering controls or the final table rows.
- [ ] Check 320px, 390px, tablet, and desktop layouts with long real-world names and text zoom.

Acceptance: users can begin finding a contact without scrolling past five full cards; no page-level horizontal overflow; table scrolling and actions remain keyboard/touch usable.

### 9.6 Preserve workspace and filter context — P2

**Locations:** application navigation, workspace state, contact filter/page controls. **Effort:** Medium.

- [ ] Choose routes or validated search parameters for workspace, filters, sort, and pagination.
- [ ] Support browser back/forward and refresh without losing the selected workspace.
- [ ] Normalize invalid parameters and avoid request loops when synchronizing state.
- [ ] Keep secrets, transient form contents, and unnecessary personal information out of URLs.
- [ ] Preserve useful list context when closing contact details.

Acceptance: a shared/bookmarked URL opens the intended workspace and filters; refresh preserves context; browser history works; invalid parameters fail safely.

## 10. Phase 6 — Performance and maintainability

### 10.1 Remove workbook parsing from the initial dashboard — M6

**Locations:** `src/lib/excelParser.ts`, importer modules, `src/app/page.tsx`. **Effort:** Small–Medium.

- [ ] Separate pure row mapping/validation from workbook parsing.
- [ ] Keep parser code on the server where that matches the current upload flow.
- [ ] Load import-only UI when the imports workspace is opened.
- [ ] Record initial transferred and decoded JavaScript before/after using the same production-build setup.

Acceptance: the ordinary dashboard no longer downloads SheetJS because of the mapper import; supported file imports behave identically; no parsing behavior is duplicated between client and server.

### 10.2 Extract around corrected business boundaries — A1

**Locations:** `src/app/page.tsx`, contact services, workspace components. **Effort:** Large, incremental.

- [ ] First complete transactional contact operations and server-only credential handling.
- [ ] Extract workspace-specific state/loading and presentation in small changes.
- [ ] Keep shared business rules in server/database operations; keep UI hooks focused on presentation and interaction.
- [ ] Consolidate repeated response/error handling when it has the same actual contract.
- [ ] Remove obsolete paths only after callers and tests demonstrate they are unused.
- [ ] Retain current frameworks and state-management approach unless a concrete remaining limitation justifies change.

Acceptance: the shell coordinates navigation and composition; it does not implement multi-step business writes. Existing behavioral tests pass without large assertion rewrites that hide regressions.

### 10.3 Batch campaign summaries — A2

**Locations:** `MarketingView.tsx` report loading, campaign list/report endpoints. **Effort:** Medium.

- [ ] Include lightweight run aggregates in the list response or add a bounded batch endpoint.
- [ ] Keep recipient-level details on demand.
- [ ] Enforce authorization and pagination on the aggregate path.
- [ ] Invalidate/refresh summaries after sends and retries without unnecessary full-page reloads.

Acceptance: loading a campaign page uses a bounded number of summary requests independent of the number of rows; counts match the ledger; compare database work and network requests before/after.

## 11. Suggested PR breakdown

Each PR should remain independently reviewable. Split migrations and application deployment when compatibility requires it.

| PR | Scope | Depends on |
| --- | --- | --- |
| 01 | Baseline reconciliation, isolated test environment, authenticated CI | Integrated lifecycle baseline |
| 02 | Membership schema, bootstrap, API/RLS enforcement, signup runbook | 01; immediate signup containment can occur earlier |
| 03 | Server-only credential access and replacement UI | 02 |
| 04 | Dependency updates and parser regression checks | 01 |
| 05 | Feature-aware preflight and deployment checks | 02–03 |
| 06 | Campaign revision and approval invariants | 02 |
| 07 | Complete and resumable audience preparation | 06 |
| 08 | Recipient claiming, outcomes, recovery, consent dispatch checks | 07 |
| 09 | Transactional consent outbox and provider convergence | 02, lifecycle integration; compatible with 08 |
| 10 | Transactional contact save and edit conflicts | 02, 09 contracts |
| 11 | Import field-presence semantics and change preview | 10 contracts |
| 12 | Durable webhook processing and reconciliation | 02; reuse 08–09 work conventions |
| 13 | Idempotent payment application and confirmation outbox | 12 |
| 14 | Calendly event ordering/rescheduling | 12 |
| 15 | Durable schedule occurrences and retry UI | 06; durable work conventions |
| 16 | Search races, loader errors, ordering/export consistency | Stable API contracts |
| 17 | Contrast, labeling, mobile contact layout | Shared UI work coordinated |
| 18 | URL-backed navigation and filter state | 16 |
| 19 | Mapper/parser split and batch campaign summaries | 08; UI state stable |
| 20 | Incremental page decomposition and runbook cleanup | Correct business boundaries in place |
| 21 | Integrated acceptance, data reconciliation, controlled rollout | All release-required work |

## 12. Verification commands and execution rules

Use scripts actually present in `package.json`. On this Windows workspace, use `npm.cmd` to avoid PowerShell execution-policy conflicts. Equivalent `npm` commands apply in Linux CI.

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run typecheck
npm.cmd run test:coverage -- --maxWorkers=2
npm.cmd run preflight
npm.cmd audit --omit=dev
```

Run build and typecheck sequentially when they share generated Next.js types. Before release, also prove the intended clean-checkout CI command sequence works; a warm local `.next` directory must not hide a setup requirement.

Browser verification against a deliberately started local production server:

```powershell
npm.cmd run start -- --hostname 127.0.0.1 --port 3100
```

In a separate shell, with the dedicated test environment configured:

```powershell
$env:E2E_SKIP_BUILD = 'true'
$env:E2E_REUSE_EXISTING_SERVER = 'true'
$env:E2E_BROWSERS = 'chromium'
npm.cmd run test:e2e -- --project=public-chromium
npm.cmd run test:e2e -- --project=authenticated-chromium
npm.cmd run verify:deployment -- http://127.0.0.1:3100
```

Provide E2E credentials through the test environment; never commit them. Run sign-out tests after other authenticated work. Expand critical browser journeys to the other configured engines before release and manually check mobile, keyboard, and screen-reader naming.

`npm.cmd run db:verify` currently uses `--linked` database commands. Do not run it until the link is verified as the intended isolated database. Add an explicit target guard during Phase 0. Migration replay and mutation tests must not default to the business database.

`npm.cmd run db:types` writes the generated types file. Run it deliberately against the verified schema and review the resulting diff.

For each phase, run targeted regression tests first, then the appropriate integration suite. Run the full release gate after integration; repeated full runs are unnecessary when no relevant code or environment changed.

## 13. Release, migration, and recovery checklist

### Before release

- [ ] Record the exact commit, migration set, deployment environment, and test results.
- [ ] Confirm the other agent's lifecycle work is integrated and verified.
- [ ] Recheck each likely finding and update its disposition with evidence.
- [ ] Verify a recoverable backup and restore procedure before production schema/data changes.
- [ ] Inventory active sends, pending webhook work, due schedules, and unresolved provider operations.
- [ ] Rehearse schema changes and data reconciliation against a representative isolated dataset.
- [ ] Verify additive migrations support the intended deployment sequence.
- [ ] Confirm who will execute production configuration changes and monitor the release.

### During release

- [ ] Apply schema and application changes in their documented compatible order.
- [ ] Prevent overlapping legacy/new workers where their claim semantics differ.
- [ ] Backfill only from supported evidence; report ambiguous historical records for review.
- [ ] Verify approved-user access, denied access, configuration status, and provider connectivity.
- [ ] Use controlled recipient/payment/booking test cases before broad operation.

### Recovery

- [ ] Prefer a forward fix for security and ledger schema changes that cannot be safely reversed.
- [ ] Pause affected send/job processing without deleting evidence.
- [ ] Preserve restrictive RLS and credential isolation during application rollback.
- [ ] Never repeat an external action merely because its database record is incomplete.
- [ ] Reconcile uncertain sends/payments against provider evidence before retrying.
- [ ] Avoid restoring database backups over later legitimate activity without a specific recovery plan.

### Operational visibility

Expose actionable counts/statuses for expired claims, uncertain sends, consent-sync failures, webhook retries, unmatched bookings, and failed schedule occurrences. Link each to the relevant record and recovery action. Use correlation identifiers and redacted diagnostics; do not log raw credentials or unnecessary contact data.

Define alert thresholds from expected traffic and scheduling cadence during rollout. A test alert/recovery exercise must establish that someone can detect and resolve stuck work.

## 14. Decisions to settle during implementation

These do not block writing the plan, but the dependent implementation must record its chosen behavior:

1. **Permissions:** which operations require an administrator or campaign approver, and whether author/approver separation is required.
2. **Approved audience:** exact prepared recipient snapshot versus a reviewed live rule. Make changes after approval visible and deliberate.
3. **Provider uncertainty:** available idempotency/reconciliation capabilities and the operator action when queue acceptance cannot be determined.
4. **Scheduling catch-up:** create every missed occurrence, coalesce, or skip explicitly.
5. **Import semantics:** which mapped empty values clear fields and which are invalid, separately for new and existing contacts.
6. **Historical repair:** which records have enough evidence to reconcile automatically and which require operator review.

Use the recommendations in this document as implementation defaults where appropriate, but do not silently impose new business restrictions.

## 15. Finding coverage and completion tracker

All items start pending. Mark an item complete only with merged implementation, passing acceptance evidence, and deployment verification where applicable. If concurrent work already resolves it, record the resolving change and verification rather than duplicating it.

| ID | Finding | Plan section | Status |
| --- | --- | --- | --- |
| C1 | Public signup and missing approved membership | 5.1 | Implemented; locally verified (`db:verify -- membership`, E2E). Deploy: disable signup, bootstrap admin — docs/ACCESS_CONTROL.md |
| H1 | Browser-readable integration credentials | 5.2 | Implemented; locally verified. Deploy: rotate EmailOctopus key after release |
| H2 | Vulnerable production dependencies | 5.3 | Implemented: Next.js 16.3.6, SheetJS 0.20.3 (CDN, lockfile integrity); `npm audit --omit=dev` = 0 |
| H3 | Duplicate sends and ignored ledger failures | 6.3 | Implemented: atomic leased claims, owner-only outcomes, `uncertain` state, checked writes, cron-driven resume — docs/CAMPAIGN_DELIVERY.md |
| H4 | Missing dispatch-time consent check | 6.4 | Implemented: eligibility re-checked atomically at dispatch; withdrawal/archive skips queued rows |
| H5 | Consent/provider synchronization gap | 6.5 | Implemented: transactional consent outbox, current-state convergence, inline + cron workers; backfill queues withdrawn contacts |
| H6 | Failed campaign edits bypass renewed approval | 6.1 | Implemented: content revisions, revision-bound approval, optimistic edits, failed-edit → draft |
| H7 | Audience truncation | 6.2 | Implemented: resumable keyset materialisation past the row cap; >10k refused at approval and send |
| H8 | Non-atomic contact edits | 7.1 | Implemented: transactional validated `save_contact`, revision conflicts, drawer keeps draft — docs/IMPORTS.md. Deploy: manual service-link review |
| H9 | Unmapped import status overwrites customers | 7.2 | Implemented: tri-state yes/no parsing, presence-aware `is_customer`/status, blank never clears, duplicates reported |
| H10 | Payment return/webhook race | 8.2 | Pending |
| H11 | Webhook claim lost after process failure | 8.1 | Pending |
| H12 | Schedule advances before durable work | 8.4 | Pending |
| M1 | Stale search responses | 9.1 | Pending |
| M2 | Failures presented as empty/stale data | 9.2 | Pending |
| M3 | Organisation ordering and unstable pagination | 9.3 | Pending |
| M4 | Calendly rescheduling/event ordering | 8.3 | Pending |
| M5 | Insufficient contrast | 9.4 | Pending |
| M6 | Spreadsheet parser in initial bundle | 10.1 | Pending |
| M7 | Incomplete readiness checks | 5.4 | Implemented: feature-aware preflight + online access/contract checks; `npm run test:scripts` |
| L1 | Unnamed Notes field | 9.4 | Pending |
| P1 | Mobile task controls below statistics | 9.5 | Pending |
| P2 | Workspace/filter state lost on refresh | 9.6 | Pending |
| P3 | Import change preview | 7.3 | Implemented: database-computed change preview, rejected-rows CSV, token-checked commit |
| A1 | Business writes in oversized client shell | 10.2 | Pending |
| A2 | Per-campaign report requests | 10.3 | Implemented: SQL batch summaries in the list response + bounded batch endpoint |
| T1 | Authenticated CI and obsolete smoke tests | 4.1 | Implemented: CI `integration` job on local Supabase; seeded identities; smoke specs updated |
| T2 | Missing concurrency/integration protection | 4.2 and phase acceptance tests | In progress: migration replay, guarded `db:verify`, membership + delivery suites, Postgres integration tests (race, row cap, fault injection) |

### Definition of done

- [ ] Every finding has a verified resolution or a documented, justified disposition.
- [ ] No confirmed critical/high issue remains without an explicit release decision and containment.
- [ ] Regression tests cover the identified failure mechanisms, not just successful UI rendering.
- [ ] A clean database replay and an upgrade-path rehearsal pass.
- [ ] Build, typecheck, lint, unit, public E2E, and authenticated E2E pass on the integrated revision.
- [ ] Production readiness verifies membership, secrets, required feature configuration, and schema compatibility.
- [ ] UI behavior is checked on desktop/mobile and with keyboard navigation.
- [ ] Operations staff can recognize and recover uncertain or failed external work.
- [ ] Deployment and product documentation describe the behavior that actually shipped.

## 16. Reference documents

- `PRODUCT.md` — product purpose and operating context.
- `DESIGN.md` — existing design direction; reconcile contradictory guidance when touching tokens.
- `docs/DEPLOYMENT.md` — deployment runbook to update with the new readiness/recovery checks.
- `docs/UX_IMPLEMENTATION_PLAN.md` — existing UX work; reuse compatible changes.
- `PLAN.md` — historical implementation record, not evidence that audit findings are closed.
- Next.js advisory: https://github.com/vercel/next.js/security/advisories/GHSA-m99w-x7hq-7vfj
- Next.js Windows advisory: https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36
- SheetJS supported installation: https://docs.sheetjs.com/docs/getting-started/installation/nodejs/

Recheck external advisories and package availability at implementation time; the plan deliberately does not pin a future patch target.
