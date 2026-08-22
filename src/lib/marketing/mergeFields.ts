/**
 * The merge-field contract between generated copy and the provider's template.
 *
 * This file exists because of a hard provider constraint recorded in PLAN.md: the
 * EmailOctopus API cannot accept an email body. The template is authored in their UI,
 * and the *only* route content takes into a send is contact custom fields merged into
 * that template. So "AI writes the campaign" cannot mean "AI writes HTML" — it means
 * the model fills a fixed, short, named set of slots the template already references.
 *
 * Declaring those slots as data rather than prose has three payoffs:
 * - the tool schema handed to the model is derived from it, so the prompt and the
 *   validator cannot drift apart;
 * - the length caps are enforced on our side, before anything reaches the provider,
 *   where an over-long value is silently truncated or rejected mid-send;
 * - the list doubles as the setup checklist for the provider's list (see
 *   `docs/EMAILOCTOPUS_SETUP.md`).
 *
 * Adding a field here is a three-place change: this array, the EmailOctopus list, and
 * the template. A field that exists here but not in the template merges to nothing;
 * one that exists in the template but not here merges to the provider's fallback.
 */

/**
 * Merge field carrying each recipient's personal booking link.
 *
 * Declared here rather than beside the send loop that fills it, because this module is
 * the one both halves can import: the send path is server-only (it reaches the booking
 * repository, and through it the service-role client), while the review UI is a client
 * component that needs to know this tag exists so it can refuse to edit it. Keeping the
 * constant in `send.ts` pulled a `server-only` module into the browser bundle and broke
 * the build -- the leak the split now prevents.
 *
 * The EmailOctopus list must carry a field with this tag, and the automation template
 * must point its button at `{{BookingUrl}}`. Without both, the email sends with a dead
 * call to action and nothing reports a problem. See `docs/EMAILOCTOPUS_SETUP.md`.
 */
export const BOOKING_URL_MERGE_FIELD = 'BookingUrl'

export type CampaignCopyField = {
  /** The provider merge tag. Referenced in the template as `{{Tag}}`. */
  readonly tag: string
  /** Human label, used when creating the field on the provider's list. */
  readonly label: string
  /** Written into the tool schema — this is what actually steers the model. */
  readonly description: string
  /**
   * Hard cap, enforced before send.
   *
   * These are deliberately tight. Merge fields land inside a fixed template, so copy
   * that overruns does not wrap gracefully — it breaks the layout.
   */
  readonly maxLength: number
}

export const CAMPAIGN_COPY_FIELDS: readonly CampaignCopyField[] = [
  {
    tag: 'Headline',
    label: 'Campaign headline',
    description:
      'The single most important line in the email. Concrete and specific to this ' +
      'audience — name the outcome, not the offer. No exclamation marks, no ' +
      'all-caps, no "unlock"/"supercharge"/"revolutionise".',
    maxLength: 80,
  },
  {
    tag: 'Preheader',
    label: 'Inbox preview text',
    description:
      'The preview line shown next to the subject in the inbox. It must add ' +
      'information rather than repeat the headline, because the two are read together.',
    maxLength: 120,
  },
  {
    tag: 'Intro',
    label: 'Opening paragraph',
    description:
      'Two or three sentences that say who this is for and why it is worth their ' +
      'time. Address the reader as "you". State the consultation is free without ' +
      'making the discount the headline of the paragraph.',
    maxLength: 320,
  },
  {
    tag: 'Benefit1',
    label: 'Benefit 1',
    description:
      'One concrete thing the reader gets from the consultation. A specific claim, ' +
      'not a category — "a written gap analysis against the current training ' +
      'package", not "expert insights".',
    maxLength: 110,
  },
  {
    tag: 'Benefit2',
    label: 'Benefit 2',
    description: 'A second concrete benefit. Must not restate Benefit1 in other words.',
    maxLength: 110,
  },
  {
    tag: 'Benefit3',
    label: 'Benefit 3',
    description: 'A third concrete benefit, distinct from the first two.',
    maxLength: 110,
  },
  {
    tag: 'CtaLabel',
    label: 'Call-to-action button label',
    description:
      'The text on the booking button. Two to four words, an action the reader ' +
      'takes — "Book your consultation". Never "Click here" or "Learn more".',
    maxLength: 28,
  },
] as const

/**
 * Merge fields the model must never write.
 *
 * `BookingUrl` is minted per recipient at send time and is the entire point of the
 * campaign. If generated copy could set it, a hallucinated URL would replace every
 * recipient's real booking link and the funnel would fail silently — the email sends,
 * the button works, and it goes nowhere. Enforced in `validateCampaignCopy`, not just
 * omitted from the schema, because the schema is a request and the validator is a gate.
 */
export const RESERVED_MERGE_FIELDS: readonly string[] = [BOOKING_URL_MERGE_FIELD]

export type CampaignCopy = Record<string, string>

export type CopyValidation =
  | { ok: true; value: CampaignCopy }
  | { ok: false; errors: string[] }

/**
 * The tool schema handed to the model.
 *
 * Derived from `CAMPAIGN_COPY_FIELDS` so the two cannot disagree. `strict: true` plus
 * `additionalProperties: false` is what makes the model retry at the tool-call layer on
 * a shape mismatch instead of returning prose we would have to parse.
 */
export function buildCopyToolSchema(): {
  type: 'object'
  properties: Record<string, { type: 'string'; description: string; maxLength: number }>
  required: string[]
  additionalProperties: false
} {
  const properties: Record<
    string,
    { type: 'string'; description: string; maxLength: number }
  > = {}

  for (const field of CAMPAIGN_COPY_FIELDS) {
    properties[field.tag] = {
      type: 'string',
      description: field.description,
      maxLength: field.maxLength,
    }
  }

  return {
    type: 'object',
    properties,
    required: CAMPAIGN_COPY_FIELDS.map((field) => field.tag),
    additionalProperties: false,
  }
}

/**
 * Gate between model output and the database.
 *
 * Checks the shape rather than trusting `strict: true` to have held — a schema is an
 * instruction to the model, and this runs on the result. Collects every problem instead
 * of failing on the first, so a retry prompt can name all of them at once.
 */
export function validateCampaignCopy(input: unknown): CopyValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['Generated copy was not an object.'] }
  }

  const source = input as Record<string, unknown>
  const errors: string[] = []
  const value: CampaignCopy = {}

  for (const field of CAMPAIGN_COPY_FIELDS) {
    const raw = source[field.tag]

    if (typeof raw !== 'string') {
      errors.push(`${field.tag} is missing.`)
      continue
    }

    const trimmed = raw.trim()

    if (trimmed.length === 0) {
      errors.push(`${field.tag} is empty.`)
      continue
    }

    if (trimmed.length > field.maxLength) {
      errors.push(
        `${field.tag} is ${trimmed.length} characters; the template allows ${field.maxLength}.`
      )
      continue
    }

    value[field.tag] = trimmed
  }

  const known = new Set<string>(CAMPAIGN_COPY_FIELDS.map((field) => field.tag))

  for (const key of Object.keys(source)) {
    if (known.has(key)) continue

    // Named explicitly: a reserved tag arriving from the model is a different failure
    // from an unrecognised one, and a silent drop would hide it.
    if (RESERVED_MERGE_FIELDS.includes(key)) {
      errors.push(`${key} is set at send time and cannot be generated.`)
      continue
    }

    errors.push(`${key} is not a field this template merges.`)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}

/**
 * Whether a provider list is configured to carry this campaign.
 *
 * A missing tag is invisible at send time — the provider merges its fallback (usually
 * an empty string) and the email goes out with a hole in it. Checking up front turns
 * that into a message before approval instead of a bad send afterwards.
 */
export function findMissingMergeFields(providerTags: readonly string[]): string[] {
  const present = new Set(providerTags.map((tag) => tag.toLowerCase()))
  const required = [
    ...CAMPAIGN_COPY_FIELDS.map((field) => field.tag),
    ...RESERVED_MERGE_FIELDS,
  ]

  return required.filter((tag) => !present.has(tag.toLowerCase()))
}
