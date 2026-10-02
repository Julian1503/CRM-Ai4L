import type { SupabaseClient } from '@supabase/supabase-js'

import { escapeLikePattern } from '@/lib/contacts/query'
import type {
  ContentBrandProfileRow,
  ContentItemRow,
  ContentReviewRow,
  ContentVariantRevisionRow,
  ContentVariantRow,
  Database,
} from '@/lib/db/types'
import { getPageRange, type PageParams } from '@/lib/pagination'

import { recordAudit } from './audit'
import { ContentHttpError, throwIfDbError } from './errors'
import { CONTENT_JOB_MEMBER_COLUMNS, latestReviews, type MemberJobRow, toItem, toItemSummary, toJob, toPublication, toRevision, toVariant, type ItemCounts } from './mappers'
import type { ContentItem, ContentVariant, CreateItemRequest, ListItemsResponse, UpdateItemRequest } from './types'

/**
 * Reads and direct writes of Content Studio items, through the member's own client so
 * RLS (approved members only) applies. Every list is bounded; nested reads are batched
 * per request, never per row.
 */

type Db = SupabaseClient<Database>

export const DEFAULT_BRAND_SLUG = 'ai4l'
const MAX_VARIANTS_PER_ITEM = 200
const MAX_JOBS_PER_ITEM = 50
const MAX_PUBLICATIONS_PER_ITEM = 100
const MAX_SUMMARY_ROWS = 5000

export type ListItemsParams = PageParams & { search: string | null; status: 'active' | 'archived' }

export async function getDefaultBrand(db: Db): Promise<ContentBrandProfileRow> {
  const { data, error } = await db
    .from('content_brand_profiles')
    .select('*')
    .eq('slug', DEFAULT_BRAND_SLUG)
    .is('archived_at', null)
    .maybeSingle()
  throwIfDbError(error)
  if (!data) throw new ContentHttpError(500, 'The AI4L brand profile is missing.')
  return data
}

export async function getBrand(db: Db, id: string): Promise<ContentBrandProfileRow> {
  const { data, error } = await db.from('content_brand_profiles').select('*').eq('id', id).maybeSingle()
  throwIfDbError(error)
  if (!data) throw new ContentHttpError(500, 'The brand profile of this item is missing.')
  return data
}

function reviewedCounts(
  variants: Pick<ContentVariantRow, 'item_id' | 'current_revision_id'>[],
  reviews: Map<string, ContentReviewRow>,
  itemId: string
): Omit<ItemCounts, 'activeJobCount'> {
  const own = variants.filter((variant) => variant.item_id === itemId)
  const decisions = own.map((variant) => reviews.get(variant.current_revision_id ?? '')?.decision ?? 'pending')

  return {
    variantCount: own.length,
    approvedCount: decisions.filter((decision) => decision === 'approved').length,
    pendingReviewCount: own.filter((variant, index) => variant.current_revision_id && decisions[index] === 'pending').length,
  }
}

async function summaryCounts(db: Db, itemIds: string[]): Promise<Map<string, ItemCounts>> {
  if (itemIds.length === 0) return new Map()

  const [variantsResult, jobsResult] = await Promise.all([
    db.from('content_variants').select('item_id, current_revision_id').in('item_id', itemIds).is('archived_at', null).limit(MAX_SUMMARY_ROWS),
    db.from('content_jobs').select('item_id').in('item_id', itemIds).in('status', ['queued', 'running']).limit(MAX_SUMMARY_ROWS),
  ])
  throwIfDbError(variantsResult.error)
  throwIfDbError(jobsResult.error)

  const variants = variantsResult.data ?? []
  const revisionIds = variants.map((variant) => variant.current_revision_id).filter((id): id is string => Boolean(id))
  const reviews = await readReviews(db, revisionIds)
  const jobs = jobsResult.data ?? []

  return new Map(
    itemIds.map((itemId) => [
      itemId,
      { ...reviewedCounts(variants, reviews, itemId), activeJobCount: jobs.filter((job) => job.item_id === itemId).length },
    ])
  )
}

async function readReviews(db: Db, revisionIds: string[]): Promise<Map<string, ContentReviewRow>> {
  if (revisionIds.length === 0) return new Map()
  const { data, error } = await db.from('content_reviews').select('*').in('revision_id', revisionIds).limit(MAX_SUMMARY_ROWS)
  throwIfDbError(error)
  return latestReviews(data ?? [])
}

export async function listItems(db: Db, params: ListItemsParams): Promise<ListItemsResponse> {
  const { from, to } = getPageRange(params)
  const base = db.from('content_items').select('*', { count: 'exact' }).is('removed_at', null)
  const byStatus = params.status === 'archived' ? base.not('archived_at', 'is', null) : base.is('archived_at', null)
  const query = params.search ? byStatus.ilike('title', `%${escapeLikePattern(params.search)}%`) : byStatus

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to)
  throwIfDbError(error)

  const rows = data ?? []
  const counts = await summaryCounts(db, rows.map((row) => row.id))
  const empty: ItemCounts = { variantCount: 0, approvedCount: 0, pendingReviewCount: 0, activeJobCount: 0 }

  return {
    items: rows.map((row) => toItemSummary(row, counts.get(row.id) ?? empty)),
    total: count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  }
}

/** The item row, or null when it does not exist or was removed. */
export async function findItemRow(db: Db, id: string): Promise<ContentItemRow | null> {
  const { data, error } = await db.from('content_items').select('*').eq('id', id).is('removed_at', null).maybeSingle()
  throwIfDbError(error)
  return data ?? null
}

/** Variant rows with their current revision and its derived review state. */
export async function hydrateVariants(db: Db, rows: ContentVariantRow[]): Promise<ContentVariant[]> {
  const revisionIds = rows.map((row) => row.current_revision_id).filter((id): id is string => Boolean(id))
  if (revisionIds.length === 0) return rows.map((row) => toVariant(row, null))

  const [revisionsResult, reviews] = await Promise.all([
    db.from('content_variant_revisions').select('*').in('id', revisionIds),
    readReviews(db, revisionIds),
  ])
  throwIfDbError(revisionsResult.error)

  const revisions = new Map((revisionsResult.data ?? []).map((row: ContentVariantRevisionRow) => [row.id, row]))
  return rows.map((row) => {
    const revision = row.current_revision_id ? revisions.get(row.current_revision_id) : undefined
    return toVariant(row, revision ? toRevision(revision, reviews.get(revision.id)) : null)
  })
}

export async function getItem(db: Db, id: string): Promise<ContentItem | null> {
  const row = await findItemRow(db, id)
  if (!row) return null

  const [variantsResult, jobsResult] = await Promise.all([
    db.from('content_variants').select('*').eq('item_id', id).order('created_at', { ascending: true }).limit(MAX_VARIANTS_PER_ITEM),
    db.from('content_jobs').select(CONTENT_JOB_MEMBER_COLUMNS).eq('item_id', id).order('created_at', { ascending: false }).limit(MAX_JOBS_PER_ITEM),
  ])
  throwIfDbError(variantsResult.error)
  throwIfDbError(jobsResult.error)

  const variantRows = variantsResult.data ?? []
  const [variants, publications] = await Promise.all([
    hydrateVariants(db, variantRows),
    readPublications(db, variantRows.map((variant) => variant.id)),
  ])

  const jobs = ((jobsResult.data ?? []) as unknown as MemberJobRow[]).map(toJob)
  return toItem(row, { variants, jobs, publications })
}

async function readPublications(db: Db, variantIds: string[]) {
  if (variantIds.length === 0) return []
  const { data, error } = await db
    .from('social_publications')
    .select('*')
    .in('variant_id', variantIds)
    .order('created_at', { ascending: false })
    .limit(MAX_PUBLICATIONS_PER_ITEM)
  throwIfDbError(error)
  return (data ?? []).map(toPublication)
}

export async function createItem(db: Db, actorId: string, request: CreateItemRequest): Promise<ContentItem> {
  const brand = await getDefaultBrand(db)
  const { data, error } = await db
    .from('content_items')
    .insert({ brand_id: brand.id, title: request.title, brief: request.brief, channels: request.channels, created_by: actorId })
    .select('*')
    .single()
  throwIfDbError(error)

  const row = data as ContentItemRow
  await recordAudit(db, { actorId, action: 'item.created', subjectType: 'content_item', subjectId: row.id, details: { title: row.title } })
  return toItem(row, { variants: [], jobs: [], publications: [] })
}

function itemPatch(current: ContentItemRow, request: UpdateItemRequest): Partial<ContentItemRow> {
  const archiving = request.archived === true && current.archived_at === null
  const restoring = request.archived === false && current.archived_at !== null

  return {
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.brief !== undefined ? { brief: request.brief } : {}),
    ...(request.channels !== undefined ? { channels: request.channels } : {}),
    ...(archiving ? { archived_at: new Date().toISOString() } : {}),
    ...(restoring ? { archived_at: null } : {}),
    updated_at: new Date().toISOString(),
  }
}

function auditActionFor(current: ContentItemRow, request: UpdateItemRequest) {
  if (request.archived === true && current.archived_at === null) return 'item.archived' as const
  if (request.archived === false && current.archived_at !== null) return 'item.restored' as const
  return 'item.updated' as const
}

/** Applies an edit or archive/restore. Null when the item does not exist (or was removed). */
export async function updateItem(db: Db, id: string, actorId: string, request: UpdateItemRequest): Promise<ContentItem | null> {
  const current = await findItemRow(db, id)
  if (!current) return null

  const { error } = await db.from('content_items').update(itemPatch(current, request)).eq('id', id)
  throwIfDbError(error)

  await recordAudit(db, {
    actorId,
    action: auditActionFor(current, request),
    subjectType: 'content_item',
    subjectId: id,
    details: { fields: Object.keys(request) },
  })
  return getItem(db, id)
}
