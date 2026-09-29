/**
 * Stub for the `crm_members` lookup made by src/lib/auth/membership.ts.
 *
 * Returns an object with just the `from(...).select(...).eq(...).maybeSingle()` chain,
 * to be spread into whichever Supabase client mock a test already builds.
 */
export type MembershipRow = { role: string; active: boolean } | null

export function membershipFrom(row: MembershipRow, error: unknown = null) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: row, error })
  const eq = jest.fn(() => ({ maybeSingle }))
  const select = jest.fn(() => ({ eq }))

  return jest.fn((table: string) => {
    if (table !== 'crm_members') {
      throw new Error(`membershipFrom stub only answers crm_members, got ${table}`)
    }
    return { select }
  })
}

export const ACTIVE_OPERATOR: MembershipRow = { role: 'operator', active: true }
export const ACTIVE_ADMIN: MembershipRow = { role: 'admin', active: true }
