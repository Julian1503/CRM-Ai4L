import 'server-only'

import { createHash } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

import { getBrandProfile } from './brand'
import { EngineError, isEngineConfigured, postToEngine, type Env } from './engineHttp'
import { ContentHttpError, throwIfDbError } from './errors'
import { buildSuggestionContext, clip } from './suggestionContext'
import type {
  BriefCompletion,
  ContentIdea,
  ImagePromptSuggestion,
  RewriteSuggestion,
  SuggestionKind,
  SuggestionRequest,
  SuggestionResponse,
} from './suggestionTypes'
import { CONTENT_CHANNELS, type BrandProfile, type ContentChannel } from './types'

/**
 * One suggestion request (docs/CONTENT_STUDIO_SUGGESTIONS_PLAN.md):
 *   1. the context is built from the database and hashed with the brand;
 *   2. a result for the same hash from the last 24 h is returned as is, unless `fresh`;
 *   3. otherwise claim_content_suggestion() takes one of the member's 50 per minute
 *      (CRM10 → 429) and the engine is asked, with the cached suggestions as "avoid";
 *   4. the answer is checked again here — it is external data — then stored and returned.
 *
 * The cache is shared by every member and is read through the same checks as a live
 * answer: a member could store a result of their own through the two functions, so a
 * cached row is never trusted further than the engine's output is.
 */

type Db = SupabaseClient<Database>

const CACHE_HOURS = 24
/** Above the engine's own deadline (SUGGEST_DEADLINE_SECONDS, 25 s), so it answers first. */
const ENGINE_TIMEOUT_MS = 30_000
const MAX_AVOID = 20

type Result =
  | { suggestions: RewriteSuggestion[] }
  | { suggestions: ImagePromptSuggestion[] }
  | { completion: BriefCompletion }
  | { suggestions: ContentIdea[] }

function hashContext(kind: SuggestionKind, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ kind, payload })).digest('hex')
}

/** Mirrors the engine's sanitiser (app/suggestions/sanitize.py): suggestions never carry a link. */
const LINK = /https?:\/\/|www\.|mailto:|javascript:|data:/i

function strings(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text !== '' && text.length <= max && !LINK.test(text) ? text : null
}

function channels(value: unknown): ContentChannel[] {
  if (!Array.isArray(value)) return []
  return CONTENT_CHANNELS.filter((channel) => value.includes(channel))
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null).slice(0, 10)
    : []
}

/** The engine's answer narrowed to the contract, or null when nothing usable is left. */
export function parseEngineResult(kind: SuggestionKind, data: Record<string, unknown>, brand: BrandProfile): Result | null {
  switch (kind) {
    case 'rewrite_instructions': {
      const suggestions = entries(data.suggestions)
        .map((entry) => strings(entry.text, 200))
        .filter((text): text is string => text !== null)
        .map((text) => ({ text }))
      return suggestions.length > 0 ? { suggestions } : null
    }
    case 'image_prompts': {
      const suggestions = entries(data.suggestions).flatMap((entry) => {
        const prompt = strings(entry.prompt, 1000)
        return prompt ? [{ label: strings(entry.label, 80) ?? clip(prompt, 60), prompt }] : []
      })
      return suggestions.length > 0 ? { suggestions } : null
    }
    case 'brief_completion': {
      const raw = typeof data.completion === 'object' && data.completion !== null ? (data.completion as Record<string, unknown>) : {}
      const factIds = new Set(brand.approvedFacts.map((fact) => fact.id))
      const completion: BriefCompletion = {
        factIds: Array.isArray(raw.factIds) ? [...new Set(raw.factIds.filter((id): id is string => typeof id === 'string' && factIds.has(id)))] : [],
        channels: channels(raw.channels),
      }
      for (const [field, max] of [['title', 200], ['audience', 1000], ['objective', 1000], ['notes', 4000]] as const) {
        const value = strings(raw[field], max)
        if (value) completion[field] = value
      }
      return completion.title || completion.audience || completion.objective || completion.notes ? { completion } : null
    }
    case 'content_ideas': {
      const suggestions = entries(data.suggestions).flatMap((entry) => {
        const title = strings(entry.title, 200)
        const topic = strings(entry.topic, 4000)
        if (!title || !topic) return []
        const picked = channels(entry.channels)
        return picked.length > 0 ? [{ title, topic, angle: strings(entry.angle, 500) ?? '', channels: picked }] : []
      })
      return suggestions.length > 0 ? { suggestions } : null
    }
  }
}

/** What a fresh request asks the engine not to repeat: the cached suggestions. */
export function avoidList(result: Result | null): string[] {
  if (!result) return []
  const texts =
    'completion' in result
      ? [result.completion.title ?? '']
      : result.suggestions.map((entry) => ('text' in entry ? entry.text : 'prompt' in entry ? entry.prompt : entry.title))
  return texts.filter(Boolean).slice(0, MAX_AVOID).map((text) => clip(text, 600))
}

async function readCached(db: Db, kind: SuggestionKind, hash: string, brand: BrandProfile): Promise<Result | null> {
  const since = new Date(Date.now() - CACHE_HOURS * 3600_000).toISOString()
  const { data, error } = await db
    .from('content_suggestion_requests')
    .select('result')
    .eq('kind', kind)
    .eq('context_hash', hash)
    .eq('status', 'succeeded')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  throwIfDbError(error)
  return data?.result && typeof data.result === 'object' ? parseEngineResult(kind, data.result as Record<string, unknown>, brand) : null
}

function usageOf(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, number] => /^[A-Za-z]{1,40}$/.test(entry[0]) && Number.isInteger(entry[1]) && (entry[1] as number) >= 0)
      .slice(0, 10)
  )
}

const NOT_CONFIGURED = () => new ContentHttpError(503, 'Suggestions are not configured.', 'suggestions_not_configured')

function engineFailure(error: unknown): ContentHttpError {
  if (error instanceof EngineError && error.code === 'engine_not_configured') return NOT_CONFIGURED()
  // The engine refused the request itself (4xx): retrying the same request cannot help.
  if (error instanceof EngineError && error.code === 'engine_refused') {
    return new ContentHttpError(502, 'Suggestions could not be made for this content.', 'suggestions_rejected')
  }
  const code = error instanceof EngineError && error.engineCode ? error.engineCode : 'suggestions_unavailable'
  return new ContentHttpError(503, 'Suggestions are unavailable right now. Try again in a moment.', code)
}

async function finish(db: Db, id: string, args: Omit<Database['public']['Functions']['finish_content_suggestion']['Args'], 'p_id'>) {
  const { error } = await db.rpc('finish_content_suggestion', { p_id: id, ...args })
  // The person already has their answer (or their error); a lost usage row is logged, not raised.
  if (error) console.error('Could not record the suggestion request', error.message)
}

export async function getSuggestions(db: Db, request: SuggestionRequest, env: Env = process.env): Promise<SuggestionResponse> {
  const { kind } = request
  const [brand, context] = await Promise.all([getBrandProfile(db), buildSuggestionContext(db, request)])
  const payload = { brand, ...context }
  const hash = hashContext(kind, payload)

  const cached = await readCached(db, kind, hash, brand)
  if (cached && !request.fresh) return { kind, cached: true, ...cached } as SuggestionResponse
  // Checked before the claim, so a missing setting does not spend the member's rate limit.
  if (!isEngineConfigured(env)) throw NOT_CONFIGURED()

  const { data: id, error } = await db.rpc('claim_content_suggestion', { p_kind: kind, p_context_hash: hash })
  throwIfDbError(error)

  const started = Date.now()
  let data: Record<string, unknown>
  try {
    data = await postToEngine(`/v1/suggest/${kind}`, { ...payload, avoid: avoidList(cached) }, env, ENGINE_TIMEOUT_MS)
  } catch (engineError) {
    const failure = engineFailure(engineError)
    await finish(db, id as string, {
      p_status: 'failed',
      p_result: null,
      p_model: null,
      p_prompt_version: null,
      p_usage: null,
      p_latency_ms: Date.now() - started,
      p_error_code: failure.code ?? 'suggestions_unavailable',
    })
    throw failure
  }

  const result = parseEngineResult(kind, data, brand)
  await finish(db, id as string, {
    p_status: result ? 'succeeded' : 'failed',
    p_result: result,
    p_model: typeof data.model === 'string' ? clip(data.model, 100) : null,
    p_prompt_version: typeof data.promptVersion === 'string' ? clip(data.promptVersion, 100) : null,
    p_usage: usageOf(data.usage),
    p_latency_ms: Date.now() - started,
    p_error_code: result ? null : 'suggestions_invalid',
  })
  if (!result) throw new ContentHttpError(502, 'The suggestions came back empty. Try again.', 'suggestions_invalid')
  return { kind, cached: false, ...result } as SuggestionResponse
}
