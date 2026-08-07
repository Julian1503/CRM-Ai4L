import { toCsv, type CsvColumn } from '@/lib/csv'
import type { ContactRow } from '@/lib/db/types'

/**
 * Contact CSV export shapes.
 *
 * Two formats, because the two jobs are different:
 * - `emailoctopus` matches what EmailOctopus expects on import, and deliberately
 *   carries nothing else. Exporting internal ids and job titles to a third-party
 *   mailing tool is data the client never agreed to share with it.
 * - `full` is the operational backup / spreadsheet view.
 */

export const EXPORT_FORMATS = ['emailoctopus', 'full'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** Upper bound on a single export, so one request cannot stream the whole table. */
export const EXPORT_MAX_ROWS = 10_000

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value)
}

const EMAILOCTOPUS_COLUMNS: CsvColumn[] = [
  { key: 'email', header: 'EmailAddress' },
  { key: 'first_name', header: 'FirstName' },
  { key: 'last_name', header: 'LastName' },
]

const FULL_COLUMNS: CsvColumn[] = [
  { key: 'first_name', header: 'First Name' },
  { key: 'last_name', header: 'Last Name' },
  { key: 'preferred_name', header: 'Preferred Name' },
  { key: 'email', header: 'Email' },
  { key: 'mobile_number', header: 'Mobile' },
  { key: 'work_phone', header: 'Work Phone' },
  { key: 'organisation', header: 'Organisation' },
  { key: 'job_type', header: 'Job Type' },
  { key: 'position', header: 'Position' },
  { key: 'department', header: 'Department' },
  { key: 'address', header: 'Address' },
  { key: 'suburb', header: 'Suburb' },
  { key: 'state', header: 'State' },
  { key: 'postcode', header: 'Postcode' },
  { key: 'country', header: 'Country' },
  { key: 'status', header: 'Status' },
  { key: 'subscribed_to_newsletter', header: 'Subscribed' },
  { key: 'created_at', header: 'Created' },
]

const COLUMNS: Record<ExportFormat, CsvColumn[]> = {
  emailoctopus: EMAILOCTOPUS_COLUMNS,
  full: FULL_COLUMNS,
}

/** A contact row with its joined lookups, as returned by fetchContacts. */
type JoinedContactRow = ContactRow & {
  organisation?: { name: string } | null
  job_type?: { name: string } | null
}

/** Flattens joins and renders values for human consumption. */
export function toExportRows(rows: JoinedContactRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    ...row,
    organisation: row.organisation?.name ?? '',
    job_type: row.job_type?.name ?? '',
    subscribed_to_newsletter: row.subscribed_to_newsletter ? 'Yes' : 'No',
  }))
}

/** Serialises contacts to a CSV body (no BOM — the route prepends it). */
export function buildContactCsv(rows: JoinedContactRow[], format: ExportFormat): string {
  return toCsv(toExportRows(rows), COLUMNS[format])
}

/** Filename for the download, stamped by the caller so this stays deterministic. */
export function buildExportFilename(format: ExportFormat, isoDate: string): string {
  return `contacts-${format}-${isoDate.slice(0, 10)}.csv`
}
