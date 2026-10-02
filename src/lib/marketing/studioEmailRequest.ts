import type { EmailDraftFields } from '@/lib/content-studio/toEmailCampaign'

import { isCtaMode, textProblem, type CtaMode } from './templateContracts'

/**
 * The body of POST /api/content-studio/variants/[id]/email-draft and …/email-export.
 *
 * Shape only: the values are validated against the template contract by the service,
 * after the template is known. Everything is re-derived on the server — the CTA mode is
 * checked against the template, image URLs are never accepted from the browser (only
 * asset ids, which are published server-side), and the stream and automation come from
 * the template in the database function.
 */

export type EmailPurpose = 'campaign' | 'export'

export type StudioEmailAssetInput = { assetId: string; alt: string }

export type StudioEmailRequest = {
  idempotencyKey: string
  /** The revision the operator adapted; refused if the variant has moved on. */
  revisionId: string
  subject: string
  fields: EmailDraftFields
  ctaMode: CtaMode
  ctaUrl: string | null
  assets: StudioEmailAssetInput[]
  templateId: string | null
  segmentId: string | null
  campaignName: string | null
  notes: string | null
}

type Parsed = { ok: true; value: StudioEmailRequest } | { ok: false; error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIELD_KEYS: readonly (keyof EmailDraftFields)[] = ['Preheader', 'Headline', 'Intro', 'Body', 'CtaLabel']
export const MAX_EMAIL_IMAGES = 1

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function optionalId(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' && UUID.test(value) ? value : 'invalid'
}

function parseAssets(value: unknown): StudioEmailAssetInput[] | string {
  if (value === undefined) return []
  if (!Array.isArray(value)) return 'assets must be a list.'
  if (value.length > MAX_EMAIL_IMAGES) return `An email carries at most ${MAX_EMAIL_IMAGES} image.`
  const assets: StudioEmailAssetInput[] = []
  for (const entry of value) {
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null
    const assetId = text(record?.assetId)
    if (!assetId || !UUID.test(assetId)) return 'Each image needs an assetId.'
    const alt = text(record?.alt)?.trim() ?? ''
    if (!alt) return 'Each image needs a description (alt text), so the email reads with images blocked.'
    if (alt.length > 200) return 'Image descriptions are limited to 200 characters.'
    assets.push({ assetId, alt })
  }
  return assets
}

export function parseStudioEmailRequest(body: Record<string, unknown>, purpose: EmailPurpose): Parsed {
  const idempotencyKey = text(body.idempotencyKey)?.trim() ?? ''
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) return { ok: false, error: 'An idempotency key is required.' }

  const revisionId = text(body.revisionId) ?? ''
  if (!UUID.test(revisionId)) return { ok: false, error: 'Say which revision this email was made from.' }

  if (!isCtaMode(body.ctaMode)) return { ok: false, error: 'Choose a call to action: booking, external_url or none.' }
  if (purpose === 'export' && body.ctaMode === 'booking') {
    return { ok: false, error: 'An exported email cannot carry a per-recipient booking link. Use a link or no button.' }
  }

  const rawFields = typeof body.fields === 'object' && body.fields !== null && !Array.isArray(body.fields) ? (body.fields as Record<string, unknown>) : null
  if (!rawFields) return { ok: false, error: 'fields must be an object.' }
  const fields = Object.fromEntries(FIELD_KEYS.map((key) => [key, text(rawFields[key]) ?? ''])) as EmailDraftFields

  const assets = parseAssets(body.assets)
  if (typeof assets === 'string') return { ok: false, error: assets }

  const templateId = optionalId(body.templateId)
  const segmentId = optionalId(body.segmentId)
  if (templateId === 'invalid' || segmentId === 'invalid') return { ok: false, error: 'Unknown template or segment.' }

  const campaignName = text(body.campaignName)?.trim() || null
  if (purpose === 'campaign') {
    if (!templateId) return { ok: false, error: 'Choose an email template.' }
    if (!campaignName) return { ok: false, error: 'A campaign name is required.' }
    if (campaignName.length > 200) return { ok: false, error: 'Campaign names are limited to 200 characters.' }
  }

  const subject = text(body.subject)?.trim() ?? ''
  if (!subject) return { ok: false, error: 'A subject is required.' }
  if (subject.length > 90) return { ok: false, error: 'The subject is limited to 90 characters.' }
  if (textProblem(subject)) return { ok: false, error: `The subject ${textProblem(subject)}` }

  return {
    ok: true,
    value: {
      idempotencyKey,
      revisionId,
      subject,
      fields,
      ctaMode: body.ctaMode,
      ctaUrl: text(body.ctaUrl)?.trim() || null,
      assets,
      templateId: purpose === 'campaign' ? templateId : null,
      segmentId: purpose === 'campaign' ? segmentId : null,
      campaignName: purpose === 'campaign' ? campaignName : null,
      notes: text(body.notes)?.trim() || null,
    },
  }
}
