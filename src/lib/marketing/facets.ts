import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContactFilters } from '@/lib/contacts/query'
import { applyContactFilters, findOrganisationIdsMatching } from '@/lib/contacts/repository'
import type { ConsentStream, ContactStatus, Database } from '@/lib/db/types'

import { SEGMENT_MEMBER_CAP, segmentDefinitionToFilters } from './segments'

/**
 * Option counts for the segment builder's dropdowns.
 *
 * Each list answers "how many contacts would this option leave me with", counted
 * against the *other* selections. Picking NSW narrows the job-type numbers to those
 * NSW contacts, which is the whole point: you can see that 5 of the 10 are
 * electricians before committing to a segment that turns out to be empty.
 *
 * A list is never counted against its own selection. Doing so would report the chosen
 * value and zero everywhere else, and the operator would learn nothing about the
 * alternatives -- which is exactly what a dropdown is for.
 */

/** The three columns the segment builder filters on. */
export type FacetRow = {
  state: string | null
  job_type_id: string | null
  status: ContactStatus | null
}

/**
 * Contacts per option value.
 *
 * The empty-string key is the "Any …" option -- every contact the other selections
 * allow, including those with no value in this column at all. Options no contact
 * matches are absent rather than zero; the UI renders the difference the same way.
 */
export type FacetCounts = Record<string, number>

export type SegmentFacets = {
  state: FacetCounts
  jobType: FacetCounts
  status: FacetCounts
}

/** Which list is being counted, and therefore which filter is set aside. */
type Facet = keyof SegmentFacets

function isAllowed(row: FacetRow, filters: ContactFilters, counting: Facet): boolean {
  if (counting !== 'state' && filters.state && row.state !== filters.state) return false
  if (counting !== 'jobType' && filters.jobTypeId && row.job_type_id !== filters.jobTypeId) {
    return false
  }
  if (counting !== 'status' && filters.status && row.status !== filters.status) return false

  return true
}

function tally(
  rows: readonly FacetRow[],
  filters: ContactFilters,
  counting: Facet,
  valueOf: (row: FacetRow) => string | null
): FacetCounts {
  const counts: FacetCounts = { '': 0 }

  for (const row of rows) {
    if (!isAllowed(row, filters, counting)) continue

    counts[''] += 1

    const value = valueOf(row)
    if (value) {
      counts[value] = (counts[value] ?? 0) + 1
    }
  }

  return counts
}

/** Counts each dropdown's options against the other two selections. */
export function computeSegmentFacets(
  rows: readonly FacetRow[],
  filters: ContactFilters
): SegmentFacets {
  return {
    state: tally(rows, filters, 'state', (row) => row.state),
    jobType: tally(rows, filters, 'jobType', (row) => row.job_type_id),
    status: tally(rows, filters, 'status', (row) => row.status),
  }
}

export type ResolvedSegmentFacets = SegmentFacets & {
  /** True when the audience outgrew the cap, so the counts describe only its first slice. */
  truncated: boolean
}

/**
 * Reads the audience once and counts all three lists from it.
 *
 * One query rather than one per option: PostgREST aggregates are disabled on this
 * project's instance (`Use of aggregate functions is not allowed`), so grouped counts
 * would otherwise mean 8 states + 18 job types + 3 statuses of `head: true` requests
 * every time a dropdown moves. Three narrow columns bounded by `SEGMENT_MEMBER_CAP`
 * is a smaller round trip than that, and it keeps the counting rules in one testable
 * pure function.
 */
export async function resolveSegmentFacets(
  db: SupabaseClient<Database>,
  definition: unknown,
  stream: ConsentStream
): Promise<ResolvedSegmentFacets> {
  const filters = segmentDefinitionToFilters(definition, stream)

  // Same organisation expansion as the member query, or a segment saved from a search
  // would count a different audience than it sends to.
  const organisationIds = filters.q ? await findOrganisationIdsMatching(db, filters.q) : []

  const query = db
    .from('active_contacts')
    .select('state, job_type_id, status', { count: 'exact' })

  // The facet columns are deliberately left unfiltered -- the counts are what the
  // audience would look like under each *other* value, and the database cannot return
  // rows it has already excluded.
  const { data, error, count } = await (applyContactFilters(
    query as never,
    { ...filters, state: null, jobTypeId: null, status: null, page: 1, pageSize: SEGMENT_MEMBER_CAP },
    { organisationIds }
  ) as unknown as PromiseLike<{
    data: FacetRow[] | null
    error: { message: string } | null
    count: number | null
  }>)

  if (error) {
    throw new Error(`Could not count segment options: ${error.message}`)
  }

  const rows = data ?? []

  return {
    ...computeSegmentFacets(rows, filters),
    truncated: (count ?? rows.length) > SEGMENT_MEMBER_CAP,
  }
}
