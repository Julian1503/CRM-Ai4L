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
| See whether EmailOctopus is configured | ✓ | ✓ |
| Replace or clear EmailOctopus credentials | – | ✓ |
| Grant, change or disable membership | – | ✓ (or `npm run db:member`) |

**Recorded decisions** (plan section 14.1): approval stays available to operators, and the
approver may be the author. Neither restriction existed before this change, and neither was
introduced silently. Changing either is a product decision; the hook is
`requireAdminOr403()` or a new role.

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
- `src/lib/auth/dal.test.ts`, `src/proxy.test.ts`, `src/app/login/actions.test.ts`,
  `src/app/api/integrations/emailoctopus/credentials/route.test.ts`.
