import type {
  ContentAssetRow,
  ContentBrandProfileRow,
  ContentItemRow,
  ContentJobRow,
  ContentReviewRow,
  ContentVariantRevisionRow,
  ContentVariantRow,
  SocialAccountRow,
  SocialPublicationRow,
} from '@/lib/db/types'

import type {
  ApprovedFact,
  BrandProfile,
  ChannelRule,
  ContentAsset,
  ContentBrief,
  ContentChannel,
  ContentItem,
  ContentItemSummary,
  ContentJob,
  ContentRevision,
  ContentVariant,
  GenerationFailure,
  SocialAccount,
  SocialPublication,
} from './types'

/**
 * Database rows (snake_case) to API DTOs (camelCase, src/lib/content-studio/types.ts).
 * Pure: no I/O, and a malformed JSON column degrades to an empty value rather than
 * throwing, because a display must not fail on one odd historic row.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string')
}

export function toBrandProfile(row: ContentBrandProfileRow): BrandProfile {
  const facts = asArray(row.approved_facts)
    .filter(isObject)
    .filter((fact) => typeof fact.text === 'string')
    .map((fact, index): ApprovedFact => ({
      id: typeof fact.id === 'string' ? fact.id : `fact-${index + 1}`,
      text: fact.text as string,
      ...(typeof fact.source === 'string' ? { source: fact.source } : {}),
    }))

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tone: row.tone,
    audience: row.audience,
    region: row.region,
    approvedFacts: facts,
    channelRules: (isObject(row.channel_rules) ? row.channel_rules : {}) as Partial<Record<ContentChannel, ChannelRule>>,
    hashtagSeeds: row.hashtag_seeds ?? [],
    imageDirection: row.image_direction,
    allowedLinkOrigins: row.allowed_link_origins ?? [],
  }
}

/** The latest review of each revision: newest created_at, ties broken by id (as SQL does). */
export function latestReviews(reviews: readonly ContentReviewRow[]): Map<string, ContentReviewRow> {
  return reviews.reduce((latest, review) => {
    const current = latest.get(review.revision_id)
    const newer =
      !current ||
      review.created_at > current.created_at ||
      (review.created_at === current.created_at && review.id > current.id)
    return newer ? new Map(latest).set(review.revision_id, review) : latest
  }, new Map<string, ContentReviewRow>())
}

export function toRevision(row: ContentVariantRevisionRow, review: ContentReviewRow | null | undefined): ContentRevision {
  return {
    id: row.id,
    variantId: row.variant_id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    origin: row.origin,
    body: row.body,
    hashtags: row.hashtags ?? [],
    callToAction: row.call_to_action,
    linkUrl: row.link_url,
    fields: isObject(row.fields) ? (row.fields as Record<string, string>) : {},
    assets: asArray(row.assets).filter(isObject).map((ref, index) => ({
      assetId: String(ref.assetId),
      alt: typeof ref.alt === 'string' ? ref.alt : '',
      order: typeof ref.order === 'number' ? ref.order : index,
    })),
    facts: asArray(row.facts),
    sources: asArray(row.sources),
    violations: asStrings(row.violations),
    promptVersion: row.prompt_version,
    jobId: row.job_id,
    checksum: row.checksum,
    createdBy: row.created_by,
    createdAt: row.created_at,
    review: review?.decision ?? 'pending',
    reviewedAt: review?.created_at ?? null,
    reviewReason: review?.reason ?? null,
  }
}

export function toVariant(row: ContentVariantRow, current: ContentRevision | null): ContentVariant {
  return {
    id: row.id,
    itemId: row.item_id,
    channel: row.channel,
    style: row.style,
    currentRevisionId: row.current_revision_id,
    conflictOfRevisionId: row.conflict_of_revision_id,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    current,
  }
}

function toFailures(result: unknown): GenerationFailure[] {
  if (!isObject(result)) return []
  return asArray(result.failures)
    .filter(isObject)
    .map((failure) => ({
      channel: failure.channel as ContentChannel,
      errorCode: typeof failure.errorCode === 'string' ? failure.errorCode : 'unknown',
      message: typeof failure.message === 'string' ? failure.message : '',
    }))
}

/**
 * Every content_jobs column a member may read: all but claim_token, which only the
 * service role sees (column-level grant). Session-client reads must list these instead
 * of `*`, or PostgREST refuses the whole query.
 */
export const CONTENT_JOB_MEMBER_COLUMNS = [
  'id', 'kind', 'status', 'idempotency_key', 'item_id', 'variant_id', 'base_revision_id', 'asset_id',
  'publication_id', 'input', 'attempts', 'max_attempts', 'next_attempt_at', 'worker_id', 'lease_expires_at',
  'heartbeat_at', 'checkpoint', 'dispatch_started_at', 'cancel_requested_at', 'result', 'error_code',
  'error_message', 'provider_request_id', 'usage', 'created_by', 'created_at', 'started_at', 'finished_at',
  'resolved_by', 'resolution_note',
].join(', ')

export type MemberJobRow = Omit<ContentJobRow, 'claim_token'>

export function toJob(row: MemberJobRow): ContentJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    itemId: row.item_id,
    variantId: row.variant_id,
    assetId: row.asset_id,
    publicationId: row.publication_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failures: toFailures(row.result),
    warnings: isObject(row.result) ? asStrings(row.result.warnings) : [],
  }
}

export function toPublication(row: SocialPublicationRow): SocialPublication {
  return {
    id: row.id,
    revisionId: row.revision_id,
    variantId: row.variant_id,
    accountId: row.account_id,
    jobId: row.job_id,
    status: row.status,
    externalId: row.external_id,
    permalink: row.permalink,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    dispatchStartedAt: row.dispatch_started_at,
    finishedAt: row.finished_at,
    resolutionNote: row.resolution_note,
  }
}

export function toAsset(row: ContentAssetRow, previewUrl: string | null, activeJobId: string | null = null): ContentAsset {
  return {
    id: row.id,
    itemId: row.item_id,
    origin: row.origin,
    ingestStatus: row.ingest_status,
    rejectionReason: row.rejection_reason,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    checksum: row.checksum,
    altText: row.alt_text,
    originalFilename: row.original_filename,
    generationPrompt: row.generation_prompt,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    previewUrl,
    activeJobId,
  }
}

export function toSocialAccount(row: SocialAccountRow): SocialAccount {
  return {
    id: row.id,
    platform: row.platform,
    provider: row.provider,
    externalId: row.external_id,
    displayName: row.display_name,
    authorKind: row.author_kind,
    scopes: row.scopes ?? [],
    status: row.status,
    lastError: row.last_error,
    healthCheckedAt: row.health_checked_at,
    createdAt: row.created_at,
  }
}

export function toBrief(value: unknown): ContentBrief {
  return isObject(value) && typeof value.topic === 'string' ? (value as unknown as ContentBrief) : { topic: '' }
}

export type ItemCounts = Pick<ContentItemSummary, 'variantCount' | 'approvedCount' | 'pendingReviewCount' | 'activeJobCount'>

export function toItemSummary(row: ContentItemRow, counts: ItemCounts): ContentItemSummary {
  return {
    id: row.id,
    title: row.title,
    channels: row.channels,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    ...counts,
  }
}

export function toItem(
  row: ContentItemRow,
  related: { variants: ContentVariant[]; jobs: ContentJob[]; publications: SocialPublication[] }
): ContentItem {
  return {
    id: row.id,
    brandId: row.brand_id,
    title: row.title,
    brief: toBrief(row.brief),
    channels: row.channels,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    ...related,
  }
}
