import type { SupabaseClient } from '@supabase/supabase-js'

import type {
  Database,
  ImportContactPayloadRow,
  ImportContactsResult,
  ImportPreview,
} from '@/lib/db/types'
import type { MappedContactRow } from '@/lib/excelParser'

import { normaliseAuState } from './states'

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

/**
 * Adds a consent flag only when the spreadsheet actually carried one.
 *
 * An absent key is what tells the RPC to leave an existing contact's consent alone and
 * to grant it to a new one. Sending `false` for an unmapped column — which is what this
 * function used to do — is an assertion the spreadsheet never made.
 */
function setConsentIfPresent(
  target: Record<string, unknown>,
  key: string,
  value: boolean | undefined
): void {
  if (typeof value === 'boolean') {
    target[key] = value
  }
}

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
      }

      // Only when the spreadsheet actually said yes or no. Sending `false` for an
      // unmapped column demoted every existing customer in the file (audit H9).
      if (typeof data.isCustomer === 'boolean') payload.is_customer = data.isCustomer

      setConsentIfPresent(payload, 'subscribed_to_newsletter', data.subscribedToNewsletter)
      setConsentIfPresent(payload, 'subscribed_to_programs', data.subscribedToPrograms)

      setIfPresent(payload, 'preferred_name', data.preferredName)
      setIfPresent(payload, 'mobile_number', data.mobileNumber)
      setIfPresent(payload, 'work_phone', data.workPhone)
      setIfPresent(payload, 'address', data.address)
      setIfPresent(payload, 'suburb', data.suburb)
      // Folded to a state code here, at the only door bulk data comes through. See
      // normaliseAuState: an unfolded "New South Wales" matches no segment.
      setIfPresent(payload, 'state', normaliseAuState(data.state))
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
/** Thrown when contacts matched by a preview changed before the import committed. */
export class ImportPreviewStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportPreviewStaleError'
  }
}

/**
 * What importing these rows would change, computed by the database with the same rules
 * the import uses, without writing anything (audit P3).
 */
export async function previewContactImport(
  db: SupabaseClient<Database>,
  rows: MappedContactRow[]
): Promise<ImportPreview> {
  const payload = toImportPayload(rows)
  const { data, error } = await db.rpc('preview_import_contacts', { payload })

  if (error) throw new Error(`Could not preview the import: ${error.message}`)
  if (!data) throw new Error('The import preview returned nothing.')

  return data as ImportPreview
}

export async function importContacts(
  db: SupabaseClient<Database>,
  rows: MappedContactRow[],
  /** From previewContactImport: the import refuses if the preview has gone stale. */
  previewToken: string | null = null
): Promise<ImportContactsResult> {
  const payload = toImportPayload(rows)

  if (payload.length === 0) {
    // Nothing usable — report it without a pointless round trip.
    return {
      inserted: 0,
      updated: 0,
      skipped: rows.length,
      archived_collisions: 0,
      total: rows.length,
    }
  }

  const { data, error } = await db.rpc('import_contacts', { payload, p_preview_token: previewToken })

  if (error?.code === 'CRM08') throw new ImportPreviewStaleError(error.message)
  if (error) {
    throw new Error(`Contact import failed: ${error.message}`)
  }

  if (!data) {
    throw new Error('Contact import failed: the database returned no result.')
  }

  return data as ImportContactsResult
}
