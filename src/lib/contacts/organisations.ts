import type { SupabaseClient } from '@supabase/supabase-js'

import { ORGANISATION_INDUSTRY_MAX_LENGTH, type Database } from '@/lib/db/types'
import { getPageRange, type PageParams } from '@/lib/pagination'

import { escapeLikePattern } from './query'

/**
 * Organisation reads for the contact filters, and the one organisation write the CRM
 * exposes: its industry (sector).
 *
 * An organisation's industry is shared by every contact in it, so changing it changes
 * what the industry filter returns for all of them. The update is conditional on the
 * value the editor loaded, so two people editing the same organisation cannot silently
 * overwrite each other.
 */

export type OrganisationSummary = { id: string; name: string; industry: string | null }

/** Most distinct industries one facet request returns; the database caps it too. */
export const MAX_INDUSTRY_OPTIONS = 200

/** Search terms are bounded: no organisation name is useful to search beyond this. */
const MAX_SEARCH_LENGTH = 200

/**
 * Normalises an industry for storage: trimmed, inner whitespace collapsed, empty as
 * null. Returns an error message for a value that is not a string, null or too long.
 */
export function parseIndustry(value: unknown): { ok: true; industry: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, industry: null }
  if (typeof value !== 'string') return { ok: false, error: 'industry must be text or null.' }

  const industry = value.trim().replace(/\s+/g, ' ')
  if (industry === '') return { ok: true, industry: null }
  if (industry.length > ORGANISATION_INDUSTRY_MAX_LENGTH) {
    return { ok: false, error: `industry can be at most ${ORGANISATION_INDUSTRY_MAX_LENGTH} characters.` }
  }

  return { ok: true, industry }
}

/** Trims and bounds a search term; null when there is nothing to search for. */
export function normaliseSearchTerm(value: string | null): string | null {
  const term = value?.trim().slice(0, MAX_SEARCH_LENGTH) ?? ''
  return term === '' ? null : term
}

/** One page of organisations, by name, optionally narrowed by a name substring. */
export async function listOrganisations(
  db: SupabaseClient<Database>,
  params: PageParams & { q: string | null }
): Promise<{ organisations: OrganisationSummary[]; total: number }> {
  const { from, to } = getPageRange(params)
  let query = db.from('organisations').select('id, name, industry', { count: 'exact' })

  if (params.q) {
    query = query.ilike('name', `%${escapeLikePattern(params.q)}%`)
  }

  const { data, error, count } = await query.order('name', { ascending: true }).range(from, to)

  if (error) throw new Error(`Could not load organisations: ${error.message}`)

  return {
    organisations: (data ?? []).map((row) => ({ id: row.id, name: row.name, industry: row.industry ?? null })),
    total: count ?? 0,
  }
}

/**
 * Distinct industries for the filter options, one per comparison key (case and outer
 * spaces ignored), sorted. Read through organisation_industries() because PostgREST has
 * no DISTINCT; see 20261006000000_contact_tags.sql.
 */
export async function listIndustries(db: SupabaseClient<Database>, q: string | null): Promise<string[]> {
  const { data, error } = await db.rpc('organisation_industries', {
    p_q: q,
    p_limit: MAX_INDUSTRY_OPTIONS,
  })

  if (error) throw new Error(`Could not load industries: ${error.message}`)

  return Array.isArray(data) ? data.filter((value): value is string => typeof value === 'string') : []
}

export type UpdateIndustryResult =
  | { kind: 'updated'; organisation: OrganisationSummary }
  | { kind: 'not_found' }
  | { kind: 'conflict'; current: OrganisationSummary }

/**
 * Sets an organisation's industry only if it still holds `expectedIndustry`.
 *
 * The condition travels with the UPDATE (`industry = expected`, or `industry IS NULL`),
 * so the check and the write are one statement: there is no window in which another
 * editor's change could slip between them. When nothing was updated, a follow-up read
 * tells "gone" (404) from "changed by someone else" (409).
 */
export async function updateOrganisationIndustry(
  db: SupabaseClient<Database>,
  params: { id: string; industry: string | null; expectedIndustry: string | null }
): Promise<UpdateIndustryResult> {
  let update = db.from('organisations').update({ industry: params.industry }).eq('id', params.id)
  update =
    params.expectedIndustry === null
      ? update.is('industry', null)
      : update.eq('industry', params.expectedIndustry)

  const { data, error } = await update.select('id, name, industry')

  if (error) throw new Error(`Could not update the organisation: ${error.message}`)

  const [updated] = data ?? []
  if (updated) {
    return { kind: 'updated', organisation: { id: updated.id, name: updated.name, industry: updated.industry ?? null } }
  }

  const { data: current, error: readError } = await db
    .from('organisations')
    .select('id, name, industry')
    .eq('id', params.id)
    .maybeSingle()

  if (readError) throw new Error(`Could not read the organisation: ${readError.message}`)
  if (!current) return { kind: 'not_found' }

  return { kind: 'conflict', current: { id: current.id, name: current.name, industry: current.industry ?? null } }
}
