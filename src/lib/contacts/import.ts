import type { SupabaseClient } from '@supabase/supabase-js'

import type {
  Database,
  ImportContactPayloadRow,
  ImportContactsResult,
} from '@/lib/db/types'
import type { MappedContactRow } from '@/lib/excelParser'

/**
 * Bulk contact import.
 *
 * Goes through the `import_contacts` Postgres function rather than a client-side
 * `.upsert({ onConflict: 'email' })`. Email uniqueness is enforced by a *partial*
 * index (`WHERE deleted_at IS NULL`), and Postgres cannot infer a partial index from
 * a bare `ON CONFLICT (email)` — the index predicate has to be in the statement, which
 * supabase-js has no way to express. See
 * supabase/migrations/20260807000000_soft_delete_and_segmentation.sql.
 *
 * The RPC also resolves organisation and job-type names to ids server-side, replacing
 * the previous per-organisation lookup-then-insert loop (an N+1 with a race window).
 */

/** Adds `key` to `target` only when `value` has content, so the RPC's COALESCE keeps existing data. */
function setIfPresent(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined | null
): void {
  if (typeof value === 'string' && value.trim() !== '') {
    target[key] = value.trim()
  }
}

/** Converts validated spreadsheet rows into the snake_case array `import_contacts` expects. */
export function toImportPayload(rows: MappedContactRow[]): ImportContactPayloadRow[] {
  return rows
    .filter((row): row is MappedContactRow & { data: NonNullable<MappedContactRow['data']> } =>
      Boolean(row.isValid && row.data)
    )
    .map(({ data }) => {
      const payload: Record<string, unknown> = {
        email: data.email.trim(),
        first_name: data.firstName.trim(),
        last_name: data.lastName.trim(),
        // Always sent: on import the spreadsheet is authoritative for these flags.
        is_customer: Boolean(data.isCustomer),
        subscribed_to_newsletter: Boolean(data.subscribedToNewsletter),
      }

      setIfPresent(payload, 'preferred_name', data.preferredName)
      setIfPresent(payload, 'mobile_number', data.mobileNumber)
      setIfPresent(payload, 'work_phone', data.workPhone)
      setIfPresent(payload, 'address', data.address)
      setIfPresent(payload, 'suburb', data.suburb)
      setIfPresent(payload, 'state', data.state)
      setIfPresent(payload, 'postcode', data.postcode)
      setIfPresent(payload, 'country', data.country)
      setIfPresent(payload, 'department', data.department)
      setIfPresent(payload, 'position', data.position)
      setIfPresent(payload, 'organisation_name', data.organisationName)
      setIfPresent(payload, 'job_type_name', data.jobTypeName)

      return payload as unknown as ImportContactPayloadRow
    })
}

/**
 * Sends validated rows to the `import_contacts` RPC.
 *
 * @throws when the RPC reports an error or returns no result.
 */
export async function importContacts(
  db: SupabaseClient<Database>,
  rows: MappedContactRow[]
): Promise<ImportContactsResult> {
  const payload = toImportPayload(rows)

  if (payload.length === 0) {
    // Nothing usable — report it without a pointless round trip.
    return { inserted: 0, updated: 0, skipped: rows.length, total: rows.length }
  }

  const { data, error } = await db.rpc('import_contacts', { payload })

  if (error) {
    throw new Error(`Contact import failed: ${error.message}`)
  }

  if (!data) {
    throw new Error('Contact import failed: the database returned no result.')
  }

  return data as ImportContactsResult
}
