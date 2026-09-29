/**
 * Approved CRM membership (audit finding C1).
 *
 * A verified Supabase session proves *who* someone is. Whether they may use the CRM is a
 * separate question answered by `public.crm_members`. Everything here fails closed: an
 * error, a missing row, a disabled row or an unknown role all mean "not a member".
 *
 * The role is always read from the database, never from a JWT claim or user_metadata —
 * users can edit their own metadata through the auth API.
 */

export const CRM_ROLES = ['admin', 'operator'] as const

export type CrmRole = (typeof CRM_ROLES)[number]

/** The minimal client surface this module needs, so tests can pass a stub. */
type MembershipReader = {
  from: (table: 'crm_members') => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string
      ) => {
        maybeSingle: () => PromiseLike<{
          data: { role: unknown; active: unknown } | null
          error: unknown
        }>
      }
    }
  }
}

export function isCrmRole(value: unknown): value is CrmRole {
  return typeof value === 'string' && (CRM_ROLES as readonly string[]).includes(value)
}

/**
 * The caller's active CRM role, or null.
 *
 * Reads through the caller's own RLS-scoped client: the `crm_members` policy lets a
 * signed-in user see only their own row, so this cannot be used to enumerate staff.
 */
export async function fetchActiveRole(
  client: unknown,
  userId: string
): Promise<CrmRole | null> {
  try {
    const { data, error } = await (client as MembershipReader)
      .from('crm_members')
      .select('role, active')
      .eq('user_id', userId)
      .maybeSingle()

    if (error || !data || data.active !== true || !isCrmRole(data.role)) {
      return null
    }

    return data.role
  } catch {
    return null
  }
}
