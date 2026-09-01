/**
 * Email templates — the named registry over EmailOctopus automation ids.
 *
 * The provider has no way to list its automations. Verified against the live v2 API on
 * 2026-08-31: `GET /automations`, `GET /automations?limit=n` and
 * `GET /lists/{id}/automations` all answer 404, and the published v2 spec documents
 * exactly one automation endpoint, `POST /automations/{id}/queue`. A dropdown populated
 * from EmailOctopus is therefore impossible, and the CRM asked operators to paste a
 * raw UUID into every campaign instead.
 *
 * So the names live here. `campaign_templates` stores a human name against an
 * automation id once, and campaigns pick the name — which is also what the table was
 * created for (see 20260825020000_campaign_templates.sql).
 *
 * `slots` is the merge-field contract the automation's template references. Registering
 * a template does not yet let an operator design a new set of slots, so a new row takes
 * the built-in seven; the column exists so that stays a data change rather than a
 * schema one.
 */

import { CAMPAIGN_COPY_FIELDS } from './mergeFields'

export type TemplateSlot = {
  /** The provider merge tag, referenced in the template as `{{Tag}}`. */
  tag: string
  label: string
  description: string
  maxLength: number
}

/**
 * The slots every template starts with.
 *
 * Derived from `CAMPAIGN_COPY_FIELDS` rather than copied, so a row created today cannot
 * disagree with the copy generator, the validator, or the list setup checklist.
 */
export const BUILT_IN_TEMPLATE_SLOTS: TemplateSlot[] = CAMPAIGN_COPY_FIELDS.map(
  (field) => ({
    tag: field.tag,
    label: field.label,
    description: field.description,
    maxLength: field.maxLength,
  })
)

/**
 * Validates the `slots` jsonb on the way in and on the way back out.
 *
 * The database checks only that the array is non-empty; a row whose entries were the
 * wrong shape would reach the copy generator as an unusable tool schema, far from here.
 * Returns null rather than throwing so a caller can answer 400 with its own wording.
 */
export function parseTemplateSlots(input: unknown): TemplateSlot[] | null {
  if (!Array.isArray(input) || input.length === 0) return null

  const slots: TemplateSlot[] = []
  const seen = new Set<string>()

  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null

    const { tag, label, description, maxLength } = entry as Record<string, unknown>

    if (typeof tag !== 'string' || tag.trim() === '') return null
    if (typeof label !== 'string' || label.trim() === '') return null
    if (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength <= 0) {
      return null
    }

    const cleanTag = tag.trim()

    // A duplicate tag would silently overwrite the first slot's copy in the tool
    // schema, which is keyed by tag.
    if (seen.has(cleanTag.toLowerCase())) return null
    seen.add(cleanTag.toLowerCase())

    slots.push({
      tag: cleanTag,
      label: label.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      maxLength,
    })
  }

  return slots
}
