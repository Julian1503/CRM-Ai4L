import { MAX_TAGS_PER_CONTACT, TAG_NAME_MAX_LENGTH, TAG_SEPARATOR } from '@/lib/db/types'

/**
 * Tag name rules shared by the import parser, the tag API and the contact save path.
 *
 * The database is the final authority: `tags` has a unique index on lower(btrim(name))
 * and a length check, and apply_contact_tags / import_contacts re-validate. These
 * helpers apply the same rules earlier so a user sees the problem before anything is
 * sent, and so every caller compares names the way the index does.
 *
 * Limits are rejected, never truncated: silently shortening "Workshop 2026 — Sydney
 * (morning)" could merge it into a different, existing tag.
 */

export { MAX_TAGS_PER_CONTACT, TAG_NAME_MAX_LENGTH, TAG_SEPARATOR }

/**
 * Display form of a tag name: trimmed, with inner whitespace runs collapsed to one
 * space. Case is preserved; it is what the catalog shows.
 */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

/**
 * Comparison key for a tag name. Two names with the same key are the same tag.
 *
 * Lower-cased after normalisation. The database index compares lower(btrim(name)), and
 * a check constraint keeps every stored name in this same normalised form
 * (public.normalize_tag_name), so the two comparisons agree.
 */
export function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase()
}

export type TagNameError =
  | { kind: 'too_long'; name: string; maxLength: number }
  | { kind: 'too_many'; count: number; max: number }

/** Returns the validation problem with one name, or null when it is usable. Empty is the caller's concern. */
export function validateTagName(name: string): TagNameError | null {
  const normalized = normalizeTagName(name)

  if (normalized.length > TAG_NAME_MAX_LENGTH) {
    return { kind: 'too_long', name: normalized, maxLength: TAG_NAME_MAX_LENGTH }
  }

  return null
}

/** Human-readable message for a tag validation error, for row errors and API responses. */
export function describeTagError(error: TagNameError): string {
  if (error.kind === 'too_long') {
    return `Tag "${error.name.slice(0, 30)}…" is longer than ${error.maxLength} characters.`
  }

  return `${error.count} tags given; a contact can have at most ${error.max}.`
}

export type TagListResult = {
  /** Normalised display names, first spelling wins, in input order. */
  names: string[]
  errors: TagNameError[]
}

/**
 * Deduplicates a list of tag names case-insensitively and checks the limits.
 *
 * Blank entries are dropped (a trailing `;` is not an error). The first spelling of a
 * name is kept, so `VIP; vip` yields `["VIP"]`. When there are errors, `names` still
 * holds the valid names so callers can show everything that is wrong at once, but they
 * must not import a row that has errors.
 */
export function dedupeTagNames(values: readonly string[]): TagListResult {
  const byKey = new Map<string, string>()
  const errors: TagNameError[] = []

  for (const value of values) {
    const name = normalizeTagName(value)
    if (name === '') continue

    const error = validateTagName(name)
    if (error) {
      errors.push(error)
      continue
    }

    const key = name.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, name)
  }

  if (byKey.size > MAX_TAGS_PER_CONTACT) {
    errors.push({ kind: 'too_many', count: byKey.size, max: MAX_TAGS_PER_CONTACT })
  }

  return { names: [...byKey.values()], errors }
}

/**
 * Parses one `Tags` cell, e.g. `VIP; Workshop 2026`.
 *
 * The separator is `;` (TAG_SEPARATOR) rather than `,` because tag names such as
 * "Sydney, NSW" are plausible and a comma is what spreadsheets most often contain.
 * An empty or blank cell yields no names — which on import means "keep what the
 * contact has", never "remove its tags".
 */
export function parseTagList(cell: string | null | undefined): TagListResult {
  if (cell === null || cell === undefined || cell.trim() === '') {
    return { names: [], errors: [] }
  }

  return dedupeTagNames(cell.split(TAG_SEPARATOR))
}

/**
 * Merges per-row tags with the import's common tags (row tags first), deduplicated and
 * validated as one list, since both end up on the same contact.
 */
export function mergeTagNames(rowTags: readonly string[], commonTags: readonly string[]): TagListResult {
  return dedupeTagNames([...rowTags, ...commonTags])
}

/** Formats tag names for the CSV export / a `Tags` cell; the inverse of parseTagList. */
export function formatTagList(names: readonly string[]): string {
  return names.join(`${TAG_SEPARATOR} `)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a canonical UUID string, the only id shape tags and contacts have. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
