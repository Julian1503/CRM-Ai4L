/**
 * Adapting a Content Studio revision into email content (plan §8.5 step 2).
 *
 * A social post is not an email: hashtags, "link in bio" and platform prompts are
 * removed, and the email's own subject and preview line are drafted when the revision
 * has none. Facts are kept — the text is trimmed and re-cut, never rewritten, so nothing
 * appears in the email that the reviewed post did not say. An `email` variant already
 * carries structured fields from generation (subject, preheader, headline, intro, body,
 * ctaLabel); those are used as they are.
 *
 * Pure and client-safe: the dialog runs it for the first draft, the server re-validates
 * whatever the operator sends back against the template contract.
 */

import type { CtaMode } from '@/lib/marketing/templateContracts'

import type { RevisionAssetRef, RevisionContent } from './types'

/** Engine limits for email drafts (services/content-engine … EMAIL_FIELD_LIMITS). */
export const EMAIL_LIMITS = {
  subject: 90,
  preheader: 120,
  headline: 80,
  intro: 320,
  body: 1200,
  ctaLabel: 28,
} as const

/** The editable email draft, keyed by the studio-newsletter-v1 merge tags. */
export type EmailDraftFields = {
  Preheader: string
  Headline: string
  Intro: string
  Body: string
  CtaLabel: string
}

export type EmailAdaptation = {
  subject: string
  fields: EmailDraftFields
  /** An https link from the revision, if it had one. */
  ctaUrl: string | null
  ctaMode: CtaMode
  /** The revision's images in order, with their alt text. */
  assets: RevisionAssetRef[]
  /** What was changed on the way, so the operator can check it. */
  notes: string[]
}

const SOCIAL_PHRASES: RegExp[] = [
  /\b(?:click|tap|see|check)?\s*(?:the\s+)?link\s+in\s+(?:our\s+|my\s+)?(?:bio|profile|comments?)\b[.!]?/gi,
  /\blink\s+below\b[.!]?/gi,
  /\b(?:swipe|scroll)\s+(?:up|left|right)\b[^.!?\n]*[.!]?/gi,
  /\b(?:like|share|comment|follow)(?:\s*(?:,|and|&)\s*(?:like|share|comment|follow))+\b[^.!?\n]*[.!]?/gi,
  /\bDM\s+(?:us|me)\b[^.!?\n]*[.!]?/gi,
]

/** Removes hashtags, social-only prompts and stray whitespace. Keeps every sentence of substance. */
export function cleanSocialText(text: string): string {
  let result = text.replace(/\r\n?/g, '\n')
  for (const pattern of SOCIAL_PHRASES) result = result.replace(pattern, '')
  result = result
    // Hashtags: a trailing block goes entirely; an inline one keeps its word.
    .replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, '')
    .replace(/#([\p{L}\p{N}_]+)/gu, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +([.,!?;:])/g, '$1')
  return result.trim()
}

/**
 * Cuts text to a limit at the last sentence end that fits, else the last word, with an
 * ellipsis. Never mid-word.
 */
export function clip(text: string, limit: number): string {
  const clean = text.trim()
  if (clean.length <= limit) return clean

  const window = clean.slice(0, limit)
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n'))
  if (sentenceEnd >= limit * 0.5) return window.slice(0, sentenceEnd + 1).trim()

  const wordEnd = window.slice(0, limit - 1).lastIndexOf(' ')
  const cut = wordEnd > 0 ? window.slice(0, wordEnd) : window.slice(0, limit - 1)
  return `${cut.replace(/[\s,;:.-]+$/, '')}…`
}

function firstSentence(text: string): string {
  const match = text.match(/^[^\n]*?[.!?](?=\s|$)/)
  return (match ? match[0] : text.split('\n')[0]).trim()
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
}

function httpsOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function fromEmailFields(fields: Record<string, string>): Omit<EmailDraftFields, 'CtaLabel'> & { subject: string; ctaLabel: string } {
  return {
    subject: fields.subject ?? '',
    Preheader: fields.preheader ?? '',
    Headline: fields.headline ?? '',
    Intro: fields.intro ?? '',
    Body: fields.body ?? '',
    ctaLabel: fields.ctaLabel ?? '',
  }
}

export function adaptRevisionToEmail(revision: RevisionContent, options: { title?: string } = {}): EmailAdaptation {
  const notes: string[] = []
  const hasEmailFields = Boolean(revision.fields?.headline || revision.fields?.body)
  const source = hasEmailFields ? fromEmailFields(revision.fields) : null

  const cleanedBody = cleanSocialText(source?.Body || revision.body || '')
  if (!hasEmailFields && cleanedBody !== (revision.body ?? '').trim()) {
    notes.push('Hashtags and social-only phrases (such as "link in bio") were removed.')
  }

  const parts = paragraphs(cleanedBody)
  const headline = clip(cleanSocialText(source?.Headline || options.title || firstSentence(cleanedBody)), EMAIL_LIMITS.headline)

  let intro = cleanSocialText(source?.Intro || '')
  let rest = parts
  if (!intro) {
    intro = parts[0] ?? ''
    rest = parts.slice(1)
    // A single-paragraph post: the intro is its opening sentence, the body the rest.
    const opening = firstSentence(intro)
    if (rest.length === 0 && opening.length < intro.length) {
      rest = [intro.slice(opening.length).trim()]
      intro = opening
    }
  }
  const body = clip(hasEmailFields ? cleanedBody : rest.join('\n\n') || intro, EMAIL_LIMITS.body)

  let preheader = cleanSocialText(source?.Preheader || '')
  if (!preheader) {
    const candidate = firstSentence(intro)
    preheader = candidate && candidate !== headline ? candidate : firstSentence(body)
    notes.push('The inbox preview line was drafted from the opening; check it adds to the subject.')
  }

  let subject = cleanSocialText(source?.subject || '')
  if (!subject) {
    subject = options.title?.trim() || headline
    notes.push('The subject was drafted from the headline.')
  }

  const ctaUrl = httpsOrNull(revision.linkUrl)
  const ctaLabel = clip(cleanSocialText(source?.ctaLabel || revision.callToAction || ''), EMAIL_LIMITS.ctaLabel)
  if (revision.linkUrl && !ctaUrl) notes.push('The post link is not an https link, so it was not used for the button.')

  return {
    subject: clip(subject, EMAIL_LIMITS.subject),
    fields: {
      Preheader: clip(preheader, EMAIL_LIMITS.preheader),
      Headline: headline,
      Intro: clip(intro, EMAIL_LIMITS.intro),
      Body: body,
      CtaLabel: ctaUrl ? ctaLabel : '',
    },
    ctaUrl,
    ctaMode: ctaUrl ? 'external_url' : 'none',
    assets: [...(revision.assets ?? [])].sort((a, b) => a.order - b.order),
    notes,
  }
}
