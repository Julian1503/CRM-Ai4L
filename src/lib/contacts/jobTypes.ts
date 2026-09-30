/**
 * Shared rules for the job-type catalogue (Settings > Job Types).
 *
 * Uniqueness lives in the database: `job_types_name_ci_idx` is a unique index on
 * `lower(btrim(name))` (20260807000000_soft_delete_and_segmentation.sql). The helpers
 * here mirror that normalisation so the UI and the routes can explain a duplicate
 * before the insert, but the index stays the authority: a concurrent create that slips
 * past a client-side check still fails with 23505, which the routes turn into a 409.
 *
 * Renaming keeps the row id. Contacts (`contacts.job_type_id`) and segment definitions
 * reference the id, so they follow the new name without being touched.
 */

export const JOB_TYPE_NAME_MAX_LENGTH = 80

export type JobTypeOption = { id: string; name: string }

export type JobTypeNameResult = { ok: true; name: string } | { ok: false; error: string }

/**
 * Cleans a job-type name for storage: trims the ends and collapses inner whitespace
 * runs, so "Learning  and Development" cannot sit beside "Learning and Development"
 * looking like a duplicate the index does not recognise.
 */
export function cleanJobTypeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** The comparison key the unique index uses: `lower(btrim(name))`. */
export function normaliseJobTypeName(value: string): string {
  return cleanJobTypeName(value).toLowerCase()
}

/** Validates a submitted name. Over-long names are refused rather than truncated. */
export function validateJobTypeName(value: unknown): JobTypeNameResult {
  if (typeof value !== 'string') {
    return { ok: false, error: 'A job type name is required.' }
  }

  const name = cleanJobTypeName(value)

  if (!name) return { ok: false, error: 'A job type name is required.' }

  if (name.length > JOB_TYPE_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Job type names can be at most ${JOB_TYPE_NAME_MAX_LENGTH} characters.`,
    }
  }

  return { ok: true, name }
}

/** Finds an existing option that the database would treat as the same name. */
export function findDuplicateJobType(
  name: string,
  options: readonly JobTypeOption[],
  exceptId?: string
): JobTypeOption | null {
  const key = normaliseJobTypeName(name)

  return (
    options.find((option) => option.id !== exceptId && normaliseJobTypeName(option.name) === key) ??
    null
  )
}

export function duplicateJobTypeMessage(name: string): string {
  return `A job type named "${name}" already exists. Names are compared ignoring case and surrounding spaces.`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}
