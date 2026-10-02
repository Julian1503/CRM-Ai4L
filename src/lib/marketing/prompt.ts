import type { ConsentStream } from '@/lib/db/types'

import { generatedSlots, LEGACY_V1, type CtaMode, type TemplateContract } from './templateContracts'

/**
 * Prompt construction for campaign copy generation.
 *
 * Kept separate from the SDK call so the interesting half is testable without mocking
 * a network client: what the model is told, and what it is *not* told.
 *
 * The second part matters more. Generation is per *segment*, never per contact — the
 * model writes one set of merge-field values that every recipient receives, and
 * personalisation happens at send time through the provider's own merge tags. So no
 * contact record has any reason to reach the model, and `redactPii` enforces that on
 * the one field where a human could smuggle one in: a segment's free-text search term,
 * which is frequently an email address someone was hunting for.
 */

/**
 * Voice and constraints applied to every campaign.
 *
 * Edit this to change how all generated copy reads. It is deliberately a plain string
 * rather than a template: the client will want to tune it, and a constant they can read
 * top to bottom is more useful to them than a composition of fragments.
 */
export const DEFAULT_BRAND_VOICE = `Professional, reliable and precise. Write plainly, in
Australian English, for busy people who will skim on a phone. Prefer concrete nouns and
specific claims over adjectives. No exclamation marks, no emoji, no hype verbs
("unlock", "supercharge", "revolutionise", "game-changing"), no manufactured urgency,
and no invented statistics, testimonials, names or credentials.`

/**
 * The one thing every campaign must do.
 *
 * Requirement 3.3 is that the email routes recipients to book a consultation. The
 * button URL is not the model's business — it is minted per recipient at send time —
 * but the copy has to earn the click, so the requirement is stated rather than assumed.
 */
export const BOOKING_CTA_REQUIREMENT = `Every campaign drives one action: booking a free
30-minute consultation. The booking button's link is generated per recipient at send
time, so write the label and the surrounding copy, never a URL. The consultation is
genuinely free — say so once, plainly, and do not dress it up as a limited offer or a
discount that expires.`

/** The action for an email whose button links to an approved page, not a booking. */
export const EXTERNAL_CTA_REQUIREMENT = `The email has one button that links to a page chosen
by the operator. Write its label and the copy that earns the click, never a URL. Do not
promise a consultation, a booking or a discount unless the notes say so.`

/** The action for an email with no button at all. */
export const NO_CTA_REQUIREMENT = `This email has no button. It informs; it does not ask
the reader to book or click anything. Do not write a call to action or a URL.`

/** What the copy must drive, by the template's call-to-action mode. */
export function ctaRequirement(ctaMode: CtaMode): string {
  if (ctaMode === 'external_url') return EXTERNAL_CTA_REQUIREMENT
  if (ctaMode === 'none') return NO_CTA_REQUIREMENT
  return BOOKING_CTA_REQUIREMENT
}

/**
 * Australian Spam Act 2003 framing.
 *
 * Sends are already restricted to opted-in contacts in `segments.ts`. This is here so
 * the *copy* does not undercut that — a line implying the reader signed up for
 * something they did not is a compliance problem regardless of how the list was built.
 */
export const COMPLIANCE_REQUIREMENT = `This is a commercial electronic message under the
Australian Spam Act 2003. Do not claim the reader requested this, do not reference a
prior conversation, purchase or relationship that has not been established, and do not
imply consent beyond what the AUDIENCE section says the readers opted in to.`

export type AudienceBrief = {
  /** Segment name, as the operator wrote it. */
  segmentName: string
  segmentDescription?: string | null
  /** How many contacts the segment currently resolves to. */
  size: number
  jobType?: string | null
  /** Organisation name, when the segment targets one. */
  organisation?: string | null
  /** Service name, when the segment targets contacts who use one. */
  service?: string | null
  state?: string | null
  status?: string | null
  /** The segment's free-text filter, if it has one. Redacted before use. */
  search?: string | null
}

export type CampaignBrief = {
  campaignName: string
  audience: AudienceBrief
  /** Operator instructions for this specific campaign. Redacted before use. */
  notes?: string | null
  /** Overrides `DEFAULT_BRAND_VOICE` when the client has tuned it. */
  brandVoice?: string | null
  /** Which consent the audience holds. Defaults to the newsletter. */
  consentStream?: ConsentStream
  /** Present only for an issue drafted by a newsletter schedule. */
  schedule?: ScheduleBrief
}

/**
 * What an operator wrote on a newsletter schedule, plus the recent subjects the runner
 * looked up. Everything but the goal is optional; all of it is redacted before use.
 */
export type ScheduleBrief = {
  goal: string
  tone?: string | null
  /** The next unused topic in the queue, or absent when the queue is empty. */
  topic?: { title: string; details?: string | null } | null
  cta?: string | null
  mustInclude?: string | null
  avoid?: string | null
  /** Subjects of this schedule's latest issues, newest first. */
  recentSubjects: string[]
}

function scheduleLines(schedule: ScheduleBrief): string[] {
  const lines = ['', 'NEWSLETTER BRIEF', `- Goal: ${redactPii(schedule.goal.trim())}`]
  const optional: Array<[string, string | null | undefined]> = [
    ['Tone', schedule.tone],
    ['Call to action', schedule.cta],
    ['Must include', schedule.mustInclude],
    ['Avoid', schedule.avoid],
  ]

  if (schedule.topic?.title.trim()) {
    lines.push(`- Topic: ${redactPii(schedule.topic.title.trim())}`)

    if (schedule.topic.details?.trim()) {
      lines.push(`  ${redactPii(schedule.topic.details.trim())}`)
    }
  } else {
    lines.push('- No topic queued: choose a fresh topic that serves the goal.')
  }

  for (const [label, value] of optional) {
    if (value?.trim()) lines.push(`- ${label}: ${redactPii(value.trim())}`)
  }

  if (schedule.recentSubjects.length > 0) {
    lines.push('', 'RECENT ISSUES (do not repeat these subjects or angles)')
    for (const subject of schedule.recentSubjects) {
      lines.push(`- ${redactPii(subject)}`)
    }
  }

  return lines
}

/** What each stream's audience actually agreed to, in the words the model is given. */
const CONSENT_DESCRIPTION: Record<ConsentStream, string> = {
  newsletter: 'all subscribed to the newsletter',
  programs: 'all opted in to emails about courses and training',
}

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g
/** AU mobile and landline shapes, plus any bare run of 8+ digits. */
const PHONE_PATTERN = /(?:\+?61[\s-]?)?(?:\(?0\d\)?[\s-]?)?\d[\d\s-]{6,}\d/g

export const REDACTED = '[redacted]'

/**
 * Strips anything that identifies an individual before it reaches the model.
 *
 * Applied to operator free text, not to model output. It is a coarse filter and does
 * not try to catch names — a name in a campaign note is usually the *sender's*, which
 * is legitimate. What it does catch is the case that actually occurs: a segment saved
 * from a contact search, whose filter is one person's email address or phone number.
 */
export function redactPii(text: string): string {
  return text.replace(EMAIL_PATTERN, REDACTED).replace(PHONE_PATTERN, REDACTED)
}

/**
 * The system prompt. Stable across campaigns, which also makes it the cacheable prefix.
 */
export function buildSystemPrompt(
  brandVoice: string = DEFAULT_BRAND_VOICE,
  contract: TemplateContract = LEGACY_V1,
  ctaMode: CtaMode = contract.ctaModes[0]
): string {
  const slots = generatedSlots(contract, ctaMode).map(
    (field) => `- ${field.tag} (max ${field.maxLength} characters): ${field.description}`
  ).join('\n')

  return [
    'You write email marketing copy for a business-to-business consultancy that sells',
    'to Australian registered training organisations and learning-and-development teams.',
    '',
    'VOICE',
    brandVoice.trim(),
    '',
    'THE ACTION',
    ctaRequirement(ctaMode).trim(),
    '',
    'COMPLIANCE',
    COMPLIANCE_REQUIREMENT.trim(),
    '',
    'FORMAT',
    'You do not write the email. The template already exists and is authored elsewhere;',
    'you fill named slots in it. Return your copy through the write_campaign_copy tool,',
    'one value per slot, plain text only — no HTML, no markdown, no surrounding quotes.',
    'Every value must respect its character limit; going over means the layout breaks.',
    '',
    slots,
    '',
    'You are writing to a whole audience segment, not to one person. You will not be',
    'given any individual contact details, and you must not invent any.',
  ].join('\n')
}

/**
 * The per-campaign brief.
 *
 * Only describes the audience in aggregate — the filters that define it and how many
 * people it currently contains. Every free-text value passes through `redactPii`.
 */
export function buildUserPrompt(brief: CampaignBrief): string {
  const { audience } = brief
  const lines: string[] = [
    `Campaign: ${redactPii(brief.campaignName)}`,
    '',
    'AUDIENCE',
    `- Segment: ${redactPii(audience.segmentName)}`,
    `- Size: ${audience.size} contacts, ${CONSENT_DESCRIPTION[brief.consentStream ?? 'newsletter']}`,
  ]

  if (audience.segmentDescription?.trim()) {
    lines.push(`- Description: ${redactPii(audience.segmentDescription.trim())}`)
  }
  if (audience.jobType?.trim()) {
    lines.push(`- Job type: ${redactPii(audience.jobType.trim())}`)
  }
  if (audience.organisation?.trim()) {
    lines.push(`- Organisation: ${redactPii(audience.organisation.trim())}`)
  }
  if (audience.service?.trim()) {
    lines.push(`- Uses the service: ${redactPii(audience.service.trim())}`)
  }
  if (audience.state?.trim()) {
    lines.push(`- Australian state: ${audience.state.trim()}`)
  }
  if (audience.status?.trim()) {
    lines.push(`- Relationship: ${audience.status.trim()}`)
  }
  if (audience.search?.trim()) {
    lines.push(`- Matches the term: ${redactPii(audience.search.trim())}`)
  }

  if (brief.notes?.trim()) {
    lines.push('', 'CAMPAIGN NOTES', redactPii(brief.notes.trim()))
  }

  if (brief.schedule) {
    lines.push(...scheduleLines(brief.schedule))
  }

  lines.push(
    '',
    'Write the copy for this campaign. Call write_campaign_copy exactly once.'
  )

  return lines.join('\n')
}

/**
 * Feedback for a retry after validation rejected the model's first attempt.
 *
 * Naming the specific failures is what makes the retry worth making — a bare "try
 * again" tends to reproduce the same overrun.
 */
export function buildRetryPrompt(errors: readonly string[]): string {
  return [
    'That copy was rejected:',
    ...errors.map((error) => `- ${error}`),
    '',
    'Call write_campaign_copy again with every slot fixed. Shorten by cutting words,',
    'not by truncating mid-sentence.',
  ].join('\n')
}
