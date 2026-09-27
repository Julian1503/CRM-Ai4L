import {
  buildSearchOrExpression,
  escapeLikePattern,
  quoteFilterValue,
} from '@/lib/contacts/query'
import { normaliseAuState } from '@/lib/contacts/states'
import type { ContactStatus } from '@/lib/db/types'

import { zonedToUtc } from './schedules/nextRun'

/**
 * What a segment selects on, and how that becomes a PostgREST filter.
 *
 * Pure and separate from resolution so every rule is unit-tested without a database.
 * The definition is stored as JSON and may be old, hand-edited or hostile, so it is read
 * through allowlists. One asymmetry matters: an invalid value is dropped only where
 * dropping it cannot quietly widen a segment that used to be narrower. That is why `state`
 * keeps any text: validating it against the list would turn an old "nsw" into
 * "every state".
 *
 * Consent and archiving are deliberately absent. They come from the campaign's stream
 * and from `segment_contacts()`, never from anything a definition can say.
 */

export const SEGMENT_STATUSES: ContactStatus[] = ['lead', 'prospect', 'customer']
export const SEGMENT_SOURCES = ['newsletter', 'import', 'manual'] as const

export type SegmentSource = (typeof SEGMENT_SOURCES)[number]

export type SegmentCriteria = {
  q: string | null
  state: string | null
  jobTypeId: string | null
  status: ContactStatus | null
  organisationId: string | null
  serviceId: string | null
  source: SegmentSource | null
  /** Inclusive local (Sydney) calendar dates, YYYY-MM-DD. */
  createdFrom: string | null
  createdTo: string | null
  position: string | null
  department: string | null
}

export const EMPTY_CRITERIA: SegmentCriteria = {
  q: null,
  state: null,
  jobTypeId: null,
  status: null,
  organisationId: null,
  serviceId: null,
  source: null,
  createdFrom: null,
  createdTo: null,
  position: null,
  department: null,
}

/** Creation dates are read as calendar days where the client works. */
const CRITERIA_TIMEZONE = 'Australia/Sydney'

const MAX_TEXT = 100
const ID_PATTERN = /^[0-9a-zA-Z-]+$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim().slice(0, MAX_TEXT)

  return trimmed || null
}

/** A recognised state becomes its code; anything else is kept, never dropped. */
function state(value: unknown): string | null {
  const candidate = text(value)

  return candidate ? (normaliseAuState(candidate) ?? candidate) : null
}

function id(value: unknown): string | null {
  const candidate = text(value)

  return candidate && ID_PATTERN.test(candidate) ? candidate : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null
}

function date(value: unknown): string | null {
  const candidate = text(value)
  const match = candidate ? DATE_PATTERN.exec(candidate) : null

  if (!match) return null

  const [, year, month, day] = match.map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))

  return parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? candidate : null
}

export function parseSegmentCriteria(definition: unknown): SegmentCriteria {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return { ...EMPTY_CRITERIA }
  }

  const source = definition as Record<string, unknown>

  return {
    q: text(source.q),
    state: state(source.state),
    jobTypeId: id(source.jobTypeId),
    status: oneOf(source.status, SEGMENT_STATUSES),
    organisationId: id(source.organisationId),
    serviceId: id(source.serviceId),
    source: oneOf(source.source, SEGMENT_SOURCES),
    createdFrom: date(source.createdFrom),
    createdTo: date(source.createdTo),
    position: text(source.position),
    department: text(source.department),
  }
}

/** The stored form: only the criteria that are set. */
export function criteriaToDefinition(criteria: SegmentCriteria): Record<string, string> {
  return Object.fromEntries(
    Object.entries(criteria).filter((entry): entry is [string, string] => entry[1] !== null)
  )
}

function nextDay(value: string): string {
  const [year, month, day] = value.split('-').map(Number)

  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

function localMidnight(value: string): string {
  return quoteFilterValue(zonedToUtc(value, '00:00', CRITERIA_TIMEZONE).toISOString())
}

function contains(column: string, value: string): string {
  return `${column}.ilike.${quoteFilterValue(`%${escapeLikePattern(value)}%`)}`
}

/**
 * The criteria as one PostgREST `and(...)` group, or null when there are none.
 *
 * Returned as a group rather than applied as chained filters so the caller can write
 * `or(is_included.is.true, <this>)`: a manual inclusion satisfies the criteria, but
 * nothing here can satisfy the consent gate, which the caller applies beside it.
 *
 * Free-text values are quoted, so a term containing the grammar's separators
 * (`x,status.eq.customer`) stays a search term instead of becoming a clause.
 */
export function buildSegmentFilterExpression(
  criteria: SegmentCriteria,
  organisationIds: readonly string[] = []
): string | null {
  const clauses: string[] = []

  if (criteria.state) clauses.push(`state.eq.${quoteFilterValue(criteria.state)}`)
  if (criteria.jobTypeId) clauses.push(`job_type_id.eq.${criteria.jobTypeId}`)
  if (criteria.status) clauses.push(`status.eq.${criteria.status}`)
  if (criteria.organisationId) clauses.push(`organisation_id.eq.${criteria.organisationId}`)
  if (criteria.serviceId) clauses.push(`service_ids.cs.{${criteria.serviceId}}`)
  if (criteria.source) clauses.push(`source.eq.${criteria.source}`)
  if (criteria.createdFrom) clauses.push(`created_at.gte.${localMidnight(criteria.createdFrom)}`)
  if (criteria.createdTo) {
    clauses.push(`created_at.lt.${localMidnight(nextDay(criteria.createdTo))}`)
  }
  if (criteria.position) clauses.push(contains('position', criteria.position))
  if (criteria.department) clauses.push(contains('department', criteria.department))

  if (criteria.q) {
    const search = buildSearchOrExpression(criteria.q, organisationIds)
    if (search) clauses.push(`or(${search})`)
  }

  return clauses.length > 0 ? `and(${clauses.join(',')})` : null
}
