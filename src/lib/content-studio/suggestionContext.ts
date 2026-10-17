import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

import { ContentHttpError, throwIfDbError } from './errors'
import { findItemRow, getItem, hydrateVariants } from './repository'
import type { SuggestionRequest } from './suggestionTypes'
import { CONTENT_CHANNELS, type ContentRevision, type ContentVariant } from './types'

/**
 * The context the engine writes suggestions from, built here from the database with the
 * member's own client (RLS applies) — the browser names only ids and its own typing.
 *
 * Only content and brand reach the model: no contact, email or booking data. Every
 * string is clipped to the engine's limits (services/content-engine/app/suggestions/
 * models.py) so a long draft narrows the context instead of failing the request.
 */

type Db = SupabaseClient<Database>

const MAX_IMAGE_TEXTS = 3
const MAX_USED_PROMPTS = 10
const MAX_RECENT_TITLES = 30
const MAX_PLANNED_TOPICS = 10

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** The revision's own copy: the post body, or an email's body field. */
function revisionText(revision: ContentRevision): string {
  return revision.body.trim() || revision.fields.body?.trim() || ''
}

async function rewriteContext(db: Db, variantId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db.from('content_variants').select('*').eq('id', variantId).maybeSingle()
  throwIfDbError(error)
  if (!data || data.archived_at || !(await findItemRow(db, data.item_id))) {
    throw new ContentHttpError(404, 'Variant not found.')
  }

  const [variant] = await hydrateVariants(db, [data])
  const revision = variant.current
  if (!revision) throw new ContentHttpError(409, 'This variant has no text to improve yet.', 'no_revision')

  return {
    channel: variant.channel,
    body: clip(revision.body, 10000),
    hashtags: revision.hashtags.slice(0, 60).map((tag) => clip(tag, 100)),
    callToAction: revision.callToAction ? clip(revision.callToAction, 1000) : null,
    fields: Object.fromEntries(Object.entries(revision.fields).slice(0, 30).map(([key, value]) => [key, clip(value, 4000)])),
    violations: revision.violations.slice(0, 50).map((violation) => clip(violation, 600)),
    reviewReason: revision.review === 'rejected' && revision.reviewReason ? clip(revision.reviewReason, 2000) : null,
  }
}

/** Approved copy first, then the rest; at most three, so the prompt stays small. */
function illustrativeTexts(variants: ContentVariant[]): string[] {
  const current = variants.filter((variant) => !variant.archivedAt && variant.current).map((variant) => variant.current!)
  const ordered = [...current.filter((revision) => revision.review === 'approved'), ...current.filter((revision) => revision.review !== 'approved')]
  return ordered
    .map(revisionText)
    .filter((text) => text.length > 0)
    .slice(0, MAX_IMAGE_TEXTS)
    .map((text) => clip(text, 4000))
}

async function imagePromptsContext(db: Db, itemId: string): Promise<Record<string, unknown>> {
  const item = await getItem(db, itemId)
  if (!item) throw new ContentHttpError(404, 'Content item not found.')

  const { data, error } = await db
    .from('content_assets')
    .select('generation_prompt')
    .eq('item_id', itemId)
    .not('generation_prompt', 'is', null)
    .is('removed_at', null)
    .order('created_at', { ascending: false })
    .limit(MAX_USED_PROMPTS)
  throwIfDbError(error)

  const usedPrompts = (data ?? []).map((row) => row.generation_prompt).filter((prompt): prompt is string => Boolean(prompt))
  return {
    title: clip(item.title, 200),
    brief: {
      topic: clip(item.brief.topic, 4000),
      audience: item.brief.audience ? clip(item.brief.audience, 1000) : undefined,
      objective: item.brief.objective ? clip(item.brief.objective, 1000) : undefined,
    },
    texts: illustrativeTexts(item.variants),
    usedPrompts: [...new Set(usedPrompts)].map((prompt) => clip(prompt, 4000)),
  }
}

async function contentIdeasContext(db: Db): Promise<Record<string, unknown>> {
  const [items, topics] = await Promise.all([
    db
      .from('content_items')
      .select('title')
      .is('removed_at', null)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(MAX_RECENT_TITLES),
    db
      .from('newsletter_topics')
      .select('title, details')
      .is('used_at', null)
      .is('removed_at', null)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(MAX_PLANNED_TOPICS),
  ])
  throwIfDbError(items.error)
  throwIfDbError(topics.error)

  return {
    recentTitles: (items.data ?? []).map((row) => clip(row.title, 200)),
    plannedTopics: (topics.data ?? []).map((row) => ({
      title: clip(row.title, 500),
      details: row.details ? clip(row.details, 2000) : null,
    })),
    channels: [...CONTENT_CHANNELS],
  }
}

/** The kind-specific part of the engine request (brand and `avoid` are added by the caller). */
export async function buildSuggestionContext(db: Db, request: SuggestionRequest): Promise<Record<string, unknown>> {
  switch (request.kind) {
    case 'rewrite_instructions':
      return rewriteContext(db, request.variantId)
    case 'image_prompts':
      return imagePromptsContext(db, request.itemId)
    case 'brief_completion':
      return { topic: request.topic, ...request.draft, channels: [...CONTENT_CHANNELS] }
    case 'content_ideas':
      return contentIdeasContext(db)
  }
}
