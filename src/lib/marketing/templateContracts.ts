/**
 * Versioned template contracts — what a template's merge fields are, per version.
 *
 * `campaign_templates.contract_id`/`contract_version` pin one of these per template, and
 * the database refuses to change the pin once a campaign uses the template
 * (20261007010000_campaign_content_snapshots.sql). Generation, validation, the editor,
 * preflight, the sender and the provider field check all read the same contract, so a
 * slot added here reaches every one of them at once.
 *
 *   legacy-v1             the seven fixed fields every existing campaign was written for.
 *                         Always a booking CTA. Behaviour is unchanged.
 *   studio-newsletter-v1  dynamic, field-based Automation for Content Studio emails:
 *                         text, one hero image (URL + alt) and a CTA per `CtaMode`.
 *                         Switched off unless CONTENT_EMAIL_DYNAMIC_ENABLED (plan §8.2).
 *   studio-static-v1      a static, versioned Automation whose HTML lives in EmailOctopus.
 *                         No content fields travel per contact; the CTA is external or none.
 *
 * Reserved, system-owned fields (BookingUrl, PrefsUrl, Newsletter, Courses) are never
 * slots of any contract. BookingUrl is set only by the sender, and only in booking mode.
 *
 * This module is imported by client components: it must stay free of server-only code.
 */

import {
  BOOKING_URL_MERGE_FIELD,
  CAMPAIGN_COPY_FIELDS,
  CONSENT_STATE_MERGE_FIELDS,
  PREFERENCES_URL_MERGE_FIELD,
  RESERVED_MERGE_FIELDS,
  type CampaignCopy,
  type CopyValidation,
} from './mergeFields'

export type CtaMode = 'booking' | 'external_url' | 'none'
export const CTA_MODES: readonly CtaMode[] = ['booking', 'external_url', 'none']

export type SlotKind = 'text' | 'url' | 'image'

/** What a slot means to the renderer and the editor, independent of its merge tag. */
export type SlotRole =
  | 'headline'
  | 'preheader'
  | 'intro'
  | 'body'
  | 'benefit'
  | 'cta_label'
  | 'cta_url'
  | 'image'
  | 'image_alt'

export type ContractSlot = {
  readonly tag: string
  readonly label: string
  readonly description: string
  readonly kind: SlotKind
  readonly maxLength: number
  /** Required regardless of CTA mode. CTA slots are governed by `ctaModes` instead. */
  readonly required: boolean
  readonly role: SlotRole
  readonly multiline?: boolean
}

/**
 * How the provider carries content.
 *   fields  the template merges contact fields written per recipient (legacy, dynamic)
 *   static  the Automation's HTML is fixed per version; nothing is written per recipient
 */
export type ContractDelivery = 'legacy' | 'dynamic-fields' | 'static'

export type TemplateContract = {
  readonly id: string
  readonly version: number
  readonly label: string
  readonly description: string
  readonly delivery: ContractDelivery
  /** CTA modes a campaign on this contract may use. The first is the default. */
  readonly ctaModes: readonly CtaMode[]
  readonly slots: readonly ContractSlot[]
}

export const LEGACY_V1: TemplateContract = {
  id: 'legacy-v1',
  version: 1,
  label: 'Classic campaign (7 fields, booking button)',
  description: 'Headline, preview, intro, three benefits and a booking button.',
  delivery: 'legacy',
  ctaModes: ['booking'],
  slots: CAMPAIGN_COPY_FIELDS.map((field) => ({
    tag: field.tag,
    label: field.label,
    description: field.description,
    kind: 'text' as const,
    maxLength: field.maxLength,
    required: true,
    role: legacyRole(field.tag),
    multiline: field.tag === 'Intro',
  })),
}

function legacyRole(tag: string): SlotRole {
  if (tag === 'Headline') return 'headline'
  if (tag === 'Preheader') return 'preheader'
  if (tag === 'Intro') return 'intro'
  if (tag === 'CtaLabel') return 'cta_label'
  return 'benefit'
}

/** Limits match the content engine's email draft (services/content-engine … EMAIL_FIELD_LIMITS). */
export const STUDIO_NEWSLETTER_V1: TemplateContract = {
  id: 'studio-newsletter-v1',
  version: 1,
  label: 'Studio newsletter (dynamic fields)',
  description: 'Text, one hero image and a button, written per contact into EmailOctopus fields.',
  delivery: 'dynamic-fields',
  ctaModes: ['external_url', 'none', 'booking'],
  slots: [
    { tag: 'Preheader', label: 'Inbox preview text', description: 'Adds to the subject; never repeats it.', kind: 'text', maxLength: 120, required: true, role: 'preheader' },
    { tag: 'Headline', label: 'Headline', description: 'The main line of the email.', kind: 'text', maxLength: 80, required: true, role: 'headline' },
    { tag: 'Intro', label: 'Opening paragraph', description: 'Who this is for and why it matters.', kind: 'text', maxLength: 320, required: true, role: 'intro', multiline: true },
    { tag: 'Body', label: 'Body', description: 'The substance. Plain text; blank lines separate paragraphs.', kind: 'text', maxLength: 1200, required: true, role: 'body', multiline: true },
    { tag: 'HeroImageUrl', label: 'Hero image', description: 'A published Content Studio image.', kind: 'image', maxLength: 500, required: false, role: 'image' },
    { tag: 'HeroImageAlt', label: 'Hero image description', description: 'Read aloud, and shown when images are blocked.', kind: 'text', maxLength: 200, required: false, role: 'image_alt' },
    { tag: 'CtaLabel', label: 'Button label', description: 'Two to four words, an action.', kind: 'text', maxLength: 28, required: false, role: 'cta_label' },
    { tag: 'CtaUrl', label: 'Button link', description: 'An approved https destination.', kind: 'url', maxLength: 500, required: false, role: 'cta_url' },
  ],
}

export const STUDIO_STATIC_V1: TemplateContract = {
  id: 'studio-static-v1',
  version: 1,
  label: 'Studio static Automation (fixed HTML)',
  description:
    'A versioned EmailOctopus Automation whose HTML is fixed. Nothing is written per contact; ' +
    'the CRM only starts it. The snapshot keeps the reference HTML.',
  delivery: 'static',
  ctaModes: ['external_url', 'none'],
  slots: [],
}

export const TEMPLATE_CONTRACTS: readonly TemplateContract[] = [LEGACY_V1, STUDIO_NEWSLETTER_V1, STUDIO_STATIC_V1]

/** Contracts a Content Studio email may use (never legacy-v1). */
export const STUDIO_CONTRACTS: readonly TemplateContract[] = [STUDIO_NEWSLETTER_V1, STUDIO_STATIC_V1]

export function findContract(id: string | null | undefined, version: number | null | undefined = 1): TemplateContract | null {
  const wantedId = id ?? LEGACY_V1.id
  const wantedVersion = version ?? 1
  return TEMPLATE_CONTRACTS.find((contract) => contract.id === wantedId && contract.version === wantedVersion) ?? null
}

export class UnknownContractError extends Error {
  constructor(id: string, version: number) {
    super(`This template uses contract "${id}" v${version}, which this version of the CRM does not know.`)
    this.name = 'UnknownContractError'
  }
}

/** The contract a template pins; no template (or a row from before contracts) is legacy-v1. */
export function resolveContract(
  template: { contract_id?: string | null; contract_version?: number | null } | null | undefined
): TemplateContract {
  const id = template?.contract_id ?? LEGACY_V1.id
  const version = template?.contract_version ?? 1
  const contract = findContract(id, version)
  if (!contract) throw new UnknownContractError(id, version)
  return contract
}

export function isStudioContract(contract: TemplateContract): boolean {
  return contract.delivery !== 'legacy'
}

export function isCtaMode(value: unknown): value is CtaMode {
  return typeof value === 'string' && (CTA_MODES as readonly string[]).includes(value)
}

/** Whether a slot must be filled for a campaign in this CTA mode. */
export function isSlotRequired(slot: ContractSlot, ctaMode: CtaMode): boolean {
  if (slot.role === 'cta_label') return slot.required || ctaMode !== 'none'
  if (slot.role === 'cta_url') return ctaMode === 'external_url'
  return slot.required
}

/** Whether a slot may carry a value at all in this CTA mode. */
export function isSlotAllowed(slot: ContractSlot, ctaMode: CtaMode): boolean {
  if (slot.role === 'cta_label') return ctaMode !== 'none' || slot.required
  if (slot.role === 'cta_url') return ctaMode === 'external_url'
  return true
}

// ---------------------------------------------------------------------------
// URL rules
// ---------------------------------------------------------------------------

/** Path under a Supabase origin where published (immutable) Studio images live. */
export const CONTENT_PUBLIC_PATH = '/storage/v1/object/public/content-public/p/'

/** The configured prefix every email image must start with, or null when unknown. */
export function contentPublicPrefix(supabaseUrl: string | null | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  const origin = supabaseUrl?.trim().replace(/\/+$/, '')
  return origin ? `${origin}${CONTENT_PUBLIC_PATH}` : null
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[::1\]|\[f[cd][0-9a-f]*:.*\])$/i

/** A public https link a recipient can open: no credentials, no private or local host. */
export function linkProblem(value: string): string | null {
  if (/\s/.test(value)) return 'must not contain spaces.'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'is not a valid link.'
  }
  if (url.protocol !== 'https:') return 'must be an https link.'
  if (url.username || url.password) return 'must not contain credentials.'
  if (PRIVATE_HOST.test(url.hostname)) return 'must point at a public website.'
  return null
}

/**
 * An email image must be an immutable published copy in `content-public` on our own
 * Supabase origin — never a signed preview, a remote URL, `blob:` or `data:`. The prefix
 * is trusted configuration, so a local stack's http origin is accepted only as itself.
 */
export function imageProblem(value: string, prefix: string | null): string | null {
  if (!prefix) return 'cannot be checked: NEXT_PUBLIC_SUPABASE_URL is not set.'
  if (/\s/.test(value)) return 'must not contain spaces.'
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    return 'must be a published Content Studio image.'
  }
  if (/[?#]|\.\.|\/\//.test(value.slice(prefix.length))) return 'must be a published Content Studio image.'
  return null
}

/**
 * Studio text is merged by the provider into HTML (and exported as HTML): a `{{Tag}}` in
 * it would be expanded as another contact's field, and markup would become markup. The
 * renderer escapes, but the provider's merge does not, so both are refused at the gate.
 * (legacy-v1 keeps its long-standing rules unchanged.)
 */
export function textProblem(value: string): string | null {
  return /\{\{|\}\}|[<>]/.test(value) ? 'must not contain {{, }}, < or >.' : null
}

// ---------------------------------------------------------------------------
// Validation and schemas
// ---------------------------------------------------------------------------

export type ValidateOptions = {
  /** Defaults to the contract's first mode. */
  ctaMode?: CtaMode
  /** Allow missing required slots (a draft with no copy yet). Shape rules still apply. */
  partial?: boolean
  /** Overrides the configured content-public prefix (tests, the browser). */
  imagePrefix?: string | null
}

/**
 * The gate between content and a campaign, for every contract.
 *
 * For legacy-v1 the checks, order and messages are exactly those `validateCampaignCopy`
 * has always produced. Collects every problem rather than failing on the first.
 */
export function validateCopy(contract: TemplateContract, input: unknown, options: ValidateOptions = {}): CopyValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['Generated copy was not an object.'] }
  }

  const ctaMode = options.ctaMode ?? contract.ctaModes[0]
  const source = input as Record<string, unknown>
  const errors: string[] = []
  const value: CampaignCopy = {}

  if (!contract.ctaModes.includes(ctaMode)) {
    errors.push(`This template does not support the "${ctaMode}" call to action.`)
  }

  const prefix = options.imagePrefix === undefined ? contentPublicPrefix() : options.imagePrefix

  for (const slot of contract.slots) {
    const raw = source[slot.tag]
    const required = isSlotRequired(slot, ctaMode) && !options.partial

    if (typeof raw !== 'string') {
      if (raw === undefined || raw === null) {
        if (required) errors.push(`${slot.tag} is missing.`)
      } else {
        errors.push(required ? `${slot.tag} is missing.` : `${slot.tag} must be text.`)
      }
      continue
    }

    const trimmed = raw.trim()

    if (trimmed.length === 0) {
      if (required) errors.push(`${slot.tag} is empty.`)
      continue
    }

    if (!isSlotAllowed(slot, ctaMode)) {
      errors.push(`${slot.tag} is not used with this call to action.`)
      continue
    }

    if (trimmed.length > slot.maxLength) {
      errors.push(`${slot.tag} is ${trimmed.length} characters; the template allows ${slot.maxLength}.`)
      continue
    }

    const problem =
      slot.kind === 'url'
        ? linkProblem(trimmed)
        : slot.kind === 'image'
          ? imageProblem(trimmed, prefix)
          : contract.delivery !== 'legacy'
            ? textProblem(trimmed)
            : null
    if (problem) {
      errors.push(`${slot.tag} ${problem}`)
      continue
    }

    value[slot.tag] = trimmed
  }

  const imageSlot = contract.slots.find((slot) => slot.role === 'image')
  const altSlot = contract.slots.find((slot) => slot.role === 'image_alt')
  if (imageSlot && altSlot && value[imageSlot.tag] && !value[altSlot.tag]) {
    errors.push(`${altSlot.tag} is required with an image, so the email reads with images blocked.`)
  }

  const known = new Set<string>(contract.slots.map((slot) => slot.tag))

  for (const key of Object.keys(source)) {
    if (known.has(key)) continue

    if (RESERVED_MERGE_FIELDS.includes(key)) {
      errors.push(`${key} is set at send time and cannot be generated.`)
      continue
    }

    errors.push(`${key} is not a field this template merges.`)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}

export type CopyToolSchema = {
  type: 'object'
  properties: Record<string, { type: 'string'; description: string; maxLength: number }>
  required: string[]
  additionalProperties: false
}

/** Text slots the model writes. URLs and images are never the model's business. */
export function generatedSlots(contract: TemplateContract, ctaMode: CtaMode = contract.ctaModes[0]): ContractSlot[] {
  return contract.slots.filter((slot) => slot.kind === 'text' && slot.role !== 'image_alt' && isSlotAllowed(slot, ctaMode))
}

export function buildToolSchema(contract: TemplateContract, ctaMode: CtaMode = contract.ctaModes[0]): CopyToolSchema {
  const slots = generatedSlots(contract, ctaMode)
  const properties: CopyToolSchema['properties'] = {}

  for (const slot of slots) {
    properties[slot.tag] = { type: 'string', description: slot.description, maxLength: slot.maxLength }
  }

  return {
    type: 'object',
    properties,
    required: slots.map((slot) => slot.tag),
    additionalProperties: false,
  }
}

/**
 * Fields the provider list must carry for a campaign on this contract.
 *
 * With a CTA mode, BookingUrl is required only for booking. Without one (a template-level
 * check), it is required when the contract can book at all.
 */
export function requiredProviderFields(contract: TemplateContract, ctaMode?: CtaMode): string[] {
  const books = ctaMode ? ctaMode === 'booking' : contract.ctaModes.includes('booking')
  return [
    ...contract.slots.map((slot) => slot.tag),
    ...(books ? [BOOKING_URL_MERGE_FIELD] : []),
    PREFERENCES_URL_MERGE_FIELD,
    ...CONSENT_STATE_MERGE_FIELDS,
  ]
}

/** Tags a list is missing for this contract, compared case-insensitively. */
export function findMissingContractFields(contract: TemplateContract, providerTags: readonly string[], ctaMode?: CtaMode): string[] {
  const present = new Set(providerTags.map((tag) => tag.toLowerCase()))
  return requiredProviderFields(contract, ctaMode).filter((tag) => !present.has(tag.toLowerCase()))
}

/** Content fields with every reserved, system-owned key removed. */
export function stripReservedFields(fields: Record<string, unknown> | null | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value !== 'string') continue
    if (RESERVED_MERGE_FIELDS.some((reserved) => reserved.toLowerCase() === key.toLowerCase())) continue
    result[key] = value
  }
  return result
}

/**
 * Why a campaign on this contract cannot be approved or sent right now, or null.
 *
 * Dynamic field-based Automations stay off until the provider validation passes
 * (docs/CONTENT_STUDIO_PROVIDER_VALIDATION.md, EO-4/EO-5): two campaigns writing the
 * same contact's fields could swap content. Static Automations carry nothing per contact
 * and are allowed with an external or no CTA; a booking link is itself per-contact.
 */
export function deliveryProblem(contract: TemplateContract, ctaMode: CtaMode, options: { dynamicEnabled: boolean }): string | null {
  if (contract.delivery === 'legacy') return null
  if (!contract.ctaModes.includes(ctaMode)) return `This template does not support the "${ctaMode}" call to action.`
  if (contract.delivery === 'static') {
    return ctaMode === 'booking' ? 'A static Automation cannot carry a per-recipient booking link.' : null
  }
  if (!options.dynamicEnabled) {
    return (
      'Field-based Studio emails are switched off until the EmailOctopus validation passes ' +
      '(CONTENT_EMAIL_DYNAMIC_ENABLED). Use a static Automation template or export the HTML.'
    )
  }
  return null
}

/** Manual checks the API cannot verify (EmailOctopus does not expose Automation HTML). */
export function templateChecklist(contract: TemplateContract, ctaMode: CtaMode): string[] {
  const items: string[] = []
  if (ctaMode !== 'booking' && contract.delivery !== 'legacy') {
    items.push('The Automation template must not reference {{BookingUrl}}: this email carries no booking link, and a stale one from an earlier campaign would otherwise show.')
  }
  if (contract.delivery === 'static') {
    items.push('The Automation is the registered static version: its HTML matches this snapshot\'s reference HTML and has not been edited since.')
  }
  items.push('The template footer carries {{PrefsUrl}} (one preferences link).')
  return items
}
