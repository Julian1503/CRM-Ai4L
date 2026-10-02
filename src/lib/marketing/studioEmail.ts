import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { CONTENT_BUCKETS, displayPath, publishAsset, signDownloads, type PublishedAsset } from '@/lib/content-studio/assets'
import { ContentHttpError, throwIfDbError } from '@/lib/content-studio/errors'
import { EmailRenderError, renderEmail } from '@/lib/content-studio/emailRenderer'
import { toRevision } from '@/lib/content-studio/mappers'
import { getDefaultBrand } from '@/lib/content-studio/repository'
import { adaptRevisionToEmail, type EmailAdaptation } from '@/lib/content-studio/toEmailCampaign'
import type { ContentChannel } from '@/lib/content-studio/types'
import type { ContentVariantRevisionRow, Database } from '@/lib/db/types'
import { getAdminClient } from '@/lib/supabase/admin'

import type { EmailPurpose, StudioEmailRequest } from './studioEmailRequest'
import {
  contentPublicPrefix,
  resolveContract,
  STUDIO_NEWSLETTER_V1,
  UnknownContractError,
  validateCopy,
  type TemplateContract,
} from './templateContracts'

/**
 * Content Studio → email (plan §8.5): the proposal the dialog starts from, and the
 * creation of a draft campaign or an HTML export from what the operator confirmed.
 *
 * Reads go through the member's client (RLS). Publishing images and the snapshot RPC use
 * the service role, after the route checked the session and this module validated and
 * rendered the content: a member cannot store HTML the renderer never produced. A post's approval is neither required nor carried
 * over: the email has its own approval in Campaigns.
 */

type Db = SupabaseClient<Database>

export type EmailSourceAsset = { assetId: string; alt: string; previewUrl: string | null; width: number | null; height: number | null; ready: boolean }

export type StudioEmailProposal = {
  variantId: string
  itemId: string
  itemTitle: string
  channel: ContentChannel
  revisionId: string
  adaptation: EmailAdaptation
  assets: EmailSourceAsset[]
}

export type StudioEmailResult = {
  snapshotId: string
  campaignId: string | null
  created: boolean
  contentHash: string
  html: string
  text: string
}

type Source = { variantId: string; itemId: string; channel: ContentChannel; revision: ContentVariantRevisionRow }

async function loadSource(db: Db, variantId: string): Promise<Source> {
  const { data: variant, error } = await db
    .from('content_variants')
    .select('id, item_id, channel, current_revision_id, archived_at')
    .eq('id', variantId)
    .maybeSingle()
  throwIfDbError(error)
  if (!variant) throw new ContentHttpError(404, 'Variant not found.')
  if (!variant.current_revision_id) throw new ContentHttpError(409, 'This variant has no content yet.')

  const { data: revision, error: revisionError } = await db
    .from('content_variant_revisions')
    .select('*')
    .eq('id', variant.current_revision_id)
    .maybeSingle()
  throwIfDbError(revisionError)
  if (!revision) throw new ContentHttpError(404, 'Variant not found.')

  return { variantId: variant.id, itemId: variant.item_id, channel: variant.channel, revision }
}

export async function proposeStudioEmail(db: Db, variantId: string, admin: Db = getAdminClient()): Promise<StudioEmailProposal> {
  const source = await loadSource(db, variantId)
  const revision = toRevision(source.revision, null)

  const { data: item, error: itemError } = await db.from('content_items').select('id, title').eq('id', source.itemId).maybeSingle()
  throwIfDbError(itemError)

  const adaptation = adaptRevisionToEmail(revision, { title: source.channel === 'email' ? undefined : item?.title })

  const ids = adaptation.assets.map((ref) => ref.assetId)
  const rows = ids.length > 0 ? await db.from('content_assets').select('*').in('id', ids) : { data: [], error: null }
  throwIfDbError(rows.error)
  const byId = new Map((rows.data ?? []).map((row) => [row.id, row]))
  const paths = [...byId.values()].map(displayPath).filter((path): path is string => path !== null)
  const urls = await signDownloads(admin, CONTENT_BUCKETS.library, paths)

  return {
    variantId: source.variantId,
    itemId: source.itemId,
    itemTitle: item?.title ?? '',
    channel: source.channel,
    revisionId: source.revision.id,
    adaptation,
    assets: adaptation.assets.map((ref) => {
      const row = byId.get(ref.assetId)
      const path = row ? displayPath(row) : null
      return {
        assetId: ref.assetId,
        alt: ref.alt || row?.alt_text || '',
        previewUrl: path ? (urls.get(path) ?? null) : null,
        width: row?.width ?? null,
        height: row?.height ?? null,
        ready: row?.ingest_status === 'ready',
      }
    }),
  }
}

async function loadContract(db: Db, templateId: string): Promise<TemplateContract> {
  const { data, error } = await db
    .from('campaign_templates')
    .select('id, archived_at, removed_at, contract_id, contract_version')
    .eq('id', templateId)
    .maybeSingle()
  throwIfDbError(error)
  if (!data || data.archived_at || data.removed_at) throw new ContentHttpError(422, 'Choose an active email template.')

  let contract: TemplateContract
  try {
    contract = resolveContract(data)
  } catch (contractError) {
    if (contractError instanceof UnknownContractError) throw new ContentHttpError(422, contractError.message)
    throw contractError
  }
  if (contract.delivery === 'legacy') {
    throw new ContentHttpError(422, 'Studio emails need a Studio template (studio-newsletter-v1 or studio-static-v1).', 'legacy_template')
  }
  return contract
}

function composeFields(request: StudioEmailRequest, image: PublishedAsset | null, alt: string): Record<string, string> {
  const fields: Record<string, string> = {
    Preheader: request.fields.Preheader,
    Headline: request.fields.Headline,
    Intro: request.fields.Intro,
    Body: request.fields.Body,
  }
  if (request.ctaMode !== 'none') fields.CtaLabel = request.fields.CtaLabel
  if (request.ctaMode === 'external_url' && request.ctaUrl) fields.CtaUrl = request.ctaUrl
  if (image) {
    fields.HeroImageUrl = image.publicUrl
    fields.HeroImageAlt = alt
  }
  return fields
}

function invalid(errors: string[]): never {
  throw new ContentHttpError(422, errors.join(' '), 'preflight_failed')
}

export async function createStudioEmail(
  db: Db,
  variantId: string,
  actorId: string,
  request: StudioEmailRequest,
  purpose: EmailPurpose,
  admin: Db = getAdminClient()
): Promise<StudioEmailResult> {
  const source = await loadSource(db, variantId)
  if (source.revision.id !== request.revisionId) {
    throw new ContentHttpError(409, 'The post changed since this email was prepared. Reopen it to use the current version.', 'stale_revision')
  }

  const revisionAssets = new Set(toRevision(source.revision, null).assets.map((ref) => ref.assetId))
  for (const asset of request.assets) {
    if (!revisionAssets.has(asset.assetId)) throw new ContentHttpError(422, 'Only images of this post can be used.', 'asset_mismatch')
  }

  const contract = request.templateId ? await loadContract(db, request.templateId) : STUDIO_NEWSLETTER_V1
  if (!contract.ctaModes.includes(request.ctaMode)) invalid([`This template does not support the "${request.ctaMode}" call to action.`])

  // The content is always checked as a Studio newsletter (text, link, image rules), before
  // anything is published; a static template then carries no per-contact fields at all.
  const imagePrefix = contentPublicPrefix()
  const textCheck = validateCopy(STUDIO_NEWSLETTER_V1, composeFields(request, null, ''), { ctaMode: request.ctaMode, imagePrefix })
  if (!textCheck.ok) invalid(textCheck.errors)

  const first = request.assets[0]
  const image = first ? await publishAsset(admin, first.assetId, 'email', actorId) : null
  const checked = validateCopy(STUDIO_NEWSLETTER_V1, composeFields(request, image, first?.alt ?? ''), { ctaMode: request.ctaMode, imagePrefix })
  if (!checked.ok) invalid(checked.errors)
  const fields = checked.value

  const brand = await getDefaultBrand(db)
  let rendered: { html: string; text: string }
  try {
    rendered = renderEmail(
      {
        subject: request.subject,
        preheader: fields.Preheader,
        headline: fields.Headline,
        intro: fields.Intro,
        body: fields.Body,
        ctaMode: request.ctaMode,
        ctaLabel: fields.CtaLabel ?? null,
        ctaUrl: request.ctaUrl,
        image: image && first ? { url: image.publicUrl, alt: first.alt, width: image.width, height: image.height } : null,
        brandName: brand.name,
      },
      { imagePrefix }
    )
  } catch (error) {
    if (error instanceof EmailRenderError) invalid([error.message])
    throw error
  }

  // Service role only (the SQL refuses members): the HTML stored is exactly what this
  // server rendered and validated. The acting member is recorded as the creator.
  const args = {
    p_actor: actorId,
    p_purpose: purpose,
    p_idempotency_key: request.idempotencyKey,
    p_source_revision_id: source.revision.id,
    p_template_id: request.templateId,
    p_cta_mode: request.ctaMode,
    p_cta_url: request.ctaMode === 'external_url' ? request.ctaUrl : null,
    p_subject: request.subject,
    p_fields: contract.delivery === 'static' ? {} : fields,
    p_assets:
      image && first
        ? [{ assetId: first.assetId, publishedAssetId: image.id, url: image.publicUrl, checksum: image.checksum, alt: first.alt }]
        : [],
    p_rendered_html: rendered.html,
    p_rendered_text: rendered.text,
    p_campaign_name: request.campaignName,
    p_segment_id: request.segmentId,
    p_notes: request.notes,
  }
  const { data, error } = await admin.rpc('create_content_email_snapshot', args)
  throwIfDbError(error)
  if (!data) throw new Error('The email snapshot was not created.')
  if (data.created) return { ...data, ...rendered }

  // A repeated request (double click, timeout retry): answer with what was stored first.
  const { data: stored, error: storedError } = await db
    .from('campaign_content_snapshots')
    .select('rendered_html, rendered_text')
    .eq('id', data.snapshotId)
    .maybeSingle()
  throwIfDbError(storedError)
  return { ...data, html: stored?.rendered_html ?? rendered.html, text: stored?.rendered_text ?? rendered.text }
}
