import type { SupabaseClient } from '@supabase/supabase-js'

import { buildSearchOrExpression } from '@/lib/contacts/query'
import { findOrganisationIdsMatching } from '@/lib/contacts/repository'
import type { ConsentStream, Database, SegmentContactRow } from '@/lib/db/types'

import { buildSegmentFilterExpression, parseSegmentCriteria } from './segmentCriteria'

/**
 * Segments: who a campaign goes to.
 *
 * A segment is a saved set of criteria (see `segmentCriteria.ts`) plus manual
 * overrides. Resolution happens in one place, for every caller: the member list, the
 * campaign audience, the send, and the copy generator. What an operator sees in the
 * segment panel is exactly what a send will do.
 *
 *   segment_contacts(segment id)            active contacts minus this segment's exclusions
 *   AND consent for the campaign's stream   never optional, never overridden
 *   AND (included by hand OR criteria)      a manual inclusion widens only the criteria
 *
 * The stream comes from the campaign, not the segment. A segment describes people; which
 * permission is being spent on them is a property of what is being sent.
 */

/**
 * Hard ceiling on how many contacts one segment can resolve to.
 *
 * The provider sends one API call per recipient against a token bucket of 100 refilling
 * at 10/sec, so 10,000 recipients is already ~17 minutes of queueing. This cap keeps a
 * mistyped filter from turning into an hours-long send.
 */
export const SEGMENT_MEMBER_CAP = 10_000

/** A stored segment, or a draft one (`id: null`) that has no overrides yet. */
export type SegmentRef = { id: string | null; definition: unknown }

export const CONSENT_COLUMNS: Record<ConsentStream, 'subscribed_to_newsletter' | 'subscribed_to_programs'> = {
  newsletter: 'subscribed_to_newsletter',
  programs: 'subscribed_to_programs',
}

const MEMBER_COLUMNS =
  'id, email, first_name, last_name, organisation_id, state, status, is_included'

export type SegmentMember = Pick<
  SegmentContactRow,
  'id' | 'email' | 'first_name' | 'last_name' | 'organisation_id' | 'state' | 'status' | 'is_included'
>

export type SegmentMembers = {
  members: SegmentMember[]
  total: number
  /** True when the segment matched more contacts than the cap allows. */
  truncated: boolean
}

export type SegmentPage = SegmentMembers & { page: number; pageSize: number }

export type AudienceRequest = {
  segmentId: string | null
  definition: unknown
  stream: ConsentStream
  page: number
  pageSize: number
  /** Narrows the list further (the panel's search box). Never widens it. */
  search?: string | null
}

type QueryResult<T> = PromiseLike<{
  data: T[] | null
  error: { message: string } | null
  count: number | null
}>

/** The chainable subset of a PostgREST filter builder this module uses. */
type AudienceQuery = {
  eq(column: string, value: unknown): AudienceQuery
  or(expression: string): AudienceQuery
  order(column: string, options: { ascending: boolean }): AudienceQuery
  range(from: number, to: number): AudienceQuery
}

/**
 * Starts a query over the segment's candidates with consent and criteria applied.
 * Exported for the facet counts, which read other columns from the same audience.
 *
 * Returned inside an object on purpose: a PostgREST builder is thenable, so an async
 * function returning it bare would run the query at the `await`, before the caller
 * could add its ordering and range.
 */
export async function segmentAudienceQuery(
  db: SupabaseClient<Database>,
  params: { segmentId: string | null; definition: unknown; stream: ConsentStream; columns: string },
  omit: ReadonlyArray<'state' | 'jobTypeId' | 'status'> = []
): Promise<{ query: AudienceQuery }> {
  const criteria = parseSegmentCriteria(params.definition)

  for (const key of omit) criteria[key] = null

  // A segment saved from a search carries the same `q` as the contact list, so it has
  // to match organisation names the same way, or the two silently disagree.
  const organisationIds = criteria.q ? await findOrganisationIdsMatching(db, criteria.q) : []
  const expression = buildSegmentFilterExpression(criteria, organisationIds)

  // Bound: supabase-js reads `this.rest` inside rpc, so a detached reference throws
  // "Cannot read properties of undefined (reading 'rest')".
  const rpc = db.rpc.bind(db) as unknown as (
    fn: string,
    args: Record<string, unknown>,
    options: { count: 'exact' }
  ) => { select(columns: string): AudienceQuery }

  let query = rpc('segment_contacts', { p_segment_id: params.segmentId }, { count: 'exact' })
    .select(params.columns)
    .eq(CONSENT_COLUMNS[params.stream], true)

  if (expression) query = query.or(`is_included.is.true,${expression}`)

  return { query }
}

/** One page of a segment's current members, flagged where they were added by hand. */
export async function resolveSegmentAudience(
  db: SupabaseClient<Database>,
  request: AudienceRequest
): Promise<SegmentPage> {
  const page = Math.max(1, request.page)
  const pageSize = Math.max(1, Math.min(request.pageSize, SEGMENT_MEMBER_CAP))

  let { query } = await segmentAudienceQuery(db, { ...request, columns: MEMBER_COLUMNS })

  if (request.search?.trim()) {
    const searchOrganisations = await findOrganisationIdsMatching(db, request.search)
    const search = buildSearchOrExpression(request.search, searchOrganisations)

    if (search) query = query.or(search)
  }

  const from = (page - 1) * pageSize
  const { data, error, count } = await (query
    .order('last_name', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1) as unknown as QueryResult<SegmentMember>)

  if (error) throw new Error(`Could not resolve segment members: ${error.message}`)

  const total = count ?? data?.length ?? 0

  return {
    members: data ?? [],
    total,
    // Surfaced so a truncated send is never mistaken for a complete one.
    truncated: total > SEGMENT_MEMBER_CAP,
    page,
    pageSize,
  }
}

/**
 * How many contacts a send would reach right now, and whether that is over the cap.
 *
 * Deliberately returns no member list. The function this replaced read "the whole
 * audience" with one `range(0, 9999)` request, which PostgREST silently truncates at
 * its max-rows setting (audit H7). A send's recipients are materialised page by page
 * in src/lib/marketing/runs.ts instead.
 */
export async function measureSegmentAudience(
  db: SupabaseClient<Database>,
  segment: SegmentRef,
  stream: ConsentStream
): Promise<{ total: number; truncated: boolean }> {
  const { total } = await resolveSegmentAudience(db, {
    segmentId: segment.id,
    definition: segment.definition,
    stream,
    page: 1,
    pageSize: 1,
  })

  return { total, truncated: total > SEGMENT_MEMBER_CAP }
}

/** One page of the audience, for screens that show who a campaign will reach. */
export async function resolveSegmentPage(
  db: SupabaseClient<Database>,
  segment: SegmentRef,
  stream: ConsentStream,
  params: { page: number; pageSize: number }
): Promise<SegmentPage> {
  return resolveSegmentAudience(db, {
    segmentId: segment.id,
    definition: segment.definition,
    stream,
    ...params,
  })
}
