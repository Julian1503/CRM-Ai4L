# Access control

Audit findings C1 (open signup, no approved membership) and H1 (browser-readable
integration credentials). Implemented by `supabase/migrations/20261002000000_crm_membership.sql` (store) and
`20261002000100_crm_membership_enforce.sql` (enforcement).

## Model

A Supabase account proves identity only. CRM access additionally requires an **active row in
`public.crm_members`**. Anonymous, self-registered, never-approved and disabled accounts are
treated identically: they read and write nothing.

| Layer | Enforcement |
| --- | --- |
| Database | A `RESTRICTIVE` policy `Approved CRM members only` on every public table, ANDed with the existing permissive policies. `is_crm_member()` / `is_crm_admin()` are evaluated per query. |
| Server | `getSession()` (`src/lib/auth/dal.ts`) returns null without active membership; every API route calls it. `requireAdminOr403()` gates administrator operations. |
| Proxy | Optimistic check; redirects unapproved users to `/login?reason=not-approved`, 403 for API paths. |
| Login | A correct password without membership is signed straight back out. |

Roles are read from the database on every request, never from JWT claims or
`user_metadata` (which users can edit themselves).

## Permission matrix

| Operation | Operator | Admin |
| --- | --- | --- |
| Contacts, imports, exports, segments, templates, schedules, bookings | ✓ | ✓ |
| Campaign drafting, review, **approval** and sending | ✓ | ✓ |
| Archive / remove records | ✓ | ✓ |
| Contact tags: create tags, tag/untag contacts one by one or in bulk (`/api/tags`, `/api/contacts/tags`) | ✓ | ✓ |
| Organisation industry: read options, edit (`/api/organisations`, `PATCH /api/organisations/[id]`) | ✓ | ✓ |
| See whether EmailOctopus is configured | ✓ | ✓ |
| Replace or clear EmailOctopus credentials | – | ✓ |
| Grant, change or disable membership | – | ✓ (or `npm run db:member`) |
| Content Studio: create, generate, edit, review/approve, publish to a connected account, create email drafts and exports | ✓ | ✓ |
| Content Studio: connect or disconnect social accounts (`/api/social/oauth/*`, `PATCH /api/social/accounts/[id]`) | – | ✓ |
| Content Studio: edit the brand profile — tone, approved facts, channel rules, allowed link origins (`PATCH /api/content-studio/brand`, `update_content_brand_profile`) | – (read only) | ✓ |

**Recorded decisions** (plan section 14.1): approval stays available to operators, and the
approver may be the author. Neither restriction existed before this change, and neither was
introduced silently. Changing either is a product decision; the hook is
`requireAdminOr403()` or a new role.

## Contact tags and organisation industry (20261006000000)

`tags` and `contact_tags` follow the same model as every other table: permissive policies
for the operations each allows, ANDed with the restrictive `Approved CRM members only`
policy; `anon` has no grant. `authenticated` may read and insert tags (no update, no
delete: tags are never physically deleted by the application) and read, insert and delete
tag links (relationship rows, like `contact_services`). `create_tag`, `apply_contact_tags`,
`save_contact` and `organisation_industries` are SECURITY INVOKER, so RLS applies inside
them; `apply_contact_tags` also checks `is_crm_member()` first (service role excepted) to
answer a non-member with 42501 instead of a misleading "contacts missing". Editing an
organisation's industry uses the existing organisation update policy, conditional on the
value the editor loaded. Restricting any of this to administrators means changing the API
guard (`requireAdminOr403()`) and these policies together.

## Content Studio (20261007000000, 20261007010000)

- Every new table carries the restrictive membership policy; members read the editorial
  tables and write only through the SECURITY DEFINER functions that enforce the rules
  (stale-revision refusal, current-revision-only review, idempotency, publication checks).
- `social_account_secrets` and `social_oauth_states` have no permissive policy and no grant
  to browser roles: only the server reads them with the service role, after checking the
  caller. Tokens are AES-256-GCM encrypted (`src/lib/crypto/secretBox.ts`).
- Storage: no `storage.objects` policy for `anon`/`authenticated`. Uploads use signed URLs for
  paths the server chose; previews use short-lived signed URLs; only immutable copies in
  `content-public` are readable by URL, and nothing can be listed.
- The content worker has no session. `/api/internal/content-worker/v1/*` is an exact
  allowlist in `src/lib/auth/routes.ts`; every request is HMAC-signed with
  `CONTENT_WORKER_SECRET` and every mutation also needs the job's claim token. Worker
  functions are executable by `service_role` only.
- Approving a social post does not authorise an email: an email draft goes through the
  campaign approval above, bound to its snapshot hash.

## Integration credentials

No browser role can select, insert or update `public.credentials`. The server reads it with
the service role **after** verifying membership (`src/lib/marketing/providers/credentials.ts`).
The settings screen receives `{ apiKeyConfigured, listId, configured, canEdit }` — never the
key, not even masked. The key field is write-only: blank keeps it, a value replaces it, and
clearing is a separate explicit action.

## Provisioning

```powershell
npm.cmd run db:member -- list
npm.cmd run db:member -- grant person@example.com operator
npm.cmd run db:member -- grant person@example.com admin
npm.cmd run db:member -- disable person@example.com
```

1. Invite the account from the Supabase dashboard (Authentication → Users → Invite).
2. Grant membership with the script. Until then the account can sign in to nothing.
3. Disabling takes effect on the **next request**, including for an existing session: the
   server and every RLS policy re-check membership each time. No session revocation step is
   required for CRM data; revoke sessions in the dashboard too if the person should also lose
   the Supabase account.
4. The database refuses to disable or demote the last active administrator.

## Rollout order (production)

1. **Disable public signup now** — Supabase dashboard → Authentication → Sign In / Providers →
   *Allow new users to sign up* = off. Verify with a signup attempt (expect
   `signup_disabled`). `npm run preflight` checks this.
2. Review existing auth accounts (`npm run db:member -- list` after step 3 lists accounts
   without membership). Do **not** promote every existing account.
3. Apply the migrations. `20261002000000_crm_membership` only creates the membership store
   and changes nobody's access. `20261002000100_crm_membership_enforce` refuses to run while
   accounts exist but no active administrator does, so the first push stops there. Then:
   `npm run db:member -- grant <admin email> admin`, and push again.
4. Deploy the application (DAL, proxy and login checks).
5. Grant the remaining legitimate staff.
6. **Rotate the EmailOctopus API key**: it was readable by any authenticated browser session
   before this change. Replace it in EmailOctopus, save the new one in Settings as an
   administrator, and confirm a test sync. There is no evidence of exfiltration; rotation is
   precautionary.

Rollback must keep the restrictive boundary. Never restore `to authenticated using (true)`
policies or browser access to `credentials` as a recovery shortcut.

## Verification

- `npm run db:verify -- membership` — anonymous, unapproved, disabled, operator and admin
  paths against the real database engine.
- `npm run db:verify -- tags` — tags and bulk tagging for anonymous, unapproved and operator
  callers, plus save/import behaviour.
- `src/lib/auth/dal.test.ts`, `src/proxy.test.ts`, `src/app/login/actions.test.ts`,
  `src/app/api/integrations/emailoctopus/credentials/route.test.ts`.
