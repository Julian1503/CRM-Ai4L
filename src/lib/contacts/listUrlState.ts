import { isUuid } from './tags'
import { CONTACT_SORT_KEYS, type ContactSortKey } from './query'
import { AU_STATE_CODES } from './states'

import { ORGANISATION_INDUSTRY_MAX_LENGTH } from '@/lib/db/types'

/**
 * The contact list's view — search, filters, sort and page — as URL parameters
 * (UX plan P5.1, audit P2). The URL is the single source of truth: it is shareable,
 * survives a reload and moves with Back/Forward.
 *
 * Reading is defensive: anything malformed (an unknown status, a non-UUID tag, page
 * "abc", a page size nobody offers) falls back to the default for that field rather than
 * erroring, so a hand-edited or stale link always opens a working list. Writing omits
 * defaults, so the plain list is just `/contacts`.
 */

export const CONTACT_LIST_STATUSES = ['all', 'lead', 'prospect', 'customer', 'newsletter', 'programs'] as const
export type ContactListStatus = (typeof CONTACT_LIST_STATUSES)[number]

export const CONTACT_PAGE_SIZES = [25, 50, 100, 200] as const
export const DEFAULT_CONTACT_PAGE_SIZE = 50
const MAX_SEARCH_LENGTH = 200
const MAX_TAG_FILTERS = 20

export type ContactListState = {
  q: string
  status: ContactListStatus
  jobTypeId: string
  state: string
  tagIds: string[]
  organisationId: string | null
  industry: string
  sort: ContactSortKey
  dir: 'asc' | 'desc'
  page: number
  pageSize: number
}

export const DEFAULT_CONTACT_LIST_STATE: Readonly<ContactListState> = {
  q: '',
  status: 'all',
  jobTypeId: '',
  state: '',
  tagIds: [],
  organisationId: null,
  industry: '',
  sort: 'name',
  dir: 'asc',
  page: 1,
  pageSize: DEFAULT_CONTACT_PAGE_SIZE,
}

/** The parameters that select *which* contacts; changing one returns to page 1. */
export const CONTACT_FILTER_KEYS = ['q', 'status', 'jobTypeId', 'state', 'tagIds', 'organisationId', 'industry'] as const

type ReadableParams = Pick<URLSearchParams, 'get'>

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return fallback
  const value = Number.parseInt(raw, 10)
  return value >= 1 ? value : fallback
}

function oneOf<T extends string>(raw: string | null, options: readonly T[], fallback: T): T {
  return raw !== null && (options as readonly string[]).includes(raw) ? (raw as T) : fallback
}

export function readContactListState(params: ReadableParams): ContactListState {
  const tagIds = (params.get('tagIds') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(isUuid)
  const pageSize = positiveInt(params.get('pageSize'), DEFAULT_CONTACT_PAGE_SIZE)
  const state = params.get('state')?.trim().toUpperCase() ?? ''
  const industry = params.get('industry')?.trim() ?? ''
  const organisationId = params.get('organisationId')

  return {
    q: (params.get('q') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    status: oneOf(params.get('status'), CONTACT_LIST_STATUSES, 'all'),
    jobTypeId: isUuid(params.get('jobTypeId')) ? (params.get('jobTypeId') as string) : '',
    state: (AU_STATE_CODES as readonly string[]).includes(state) ? state : '',
    tagIds: [...new Set(tagIds)].slice(0, MAX_TAG_FILTERS),
    organisationId: isUuid(organisationId) ? organisationId : null,
    industry: industry.length <= ORGANISATION_INDUSTRY_MAX_LENGTH ? industry : '',
    sort: oneOf(params.get('sort'), CONTACT_SORT_KEYS, 'name'),
    dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
    page: positiveInt(params.get('page'), 1),
    pageSize: (CONTACT_PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_CONTACT_PAGE_SIZE,
  }
}

/** The URL parameters for a state, defaults omitted. */
export function writeContactListState(state: ContactListState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.q.trim()) params.set('q', state.q.trim())
  if (state.status !== 'all') params.set('status', state.status)
  if (state.jobTypeId) params.set('jobTypeId', state.jobTypeId)
  if (state.state) params.set('state', state.state)
  if (state.tagIds.length > 0) params.set('tagIds', state.tagIds.join(','))
  if (state.organisationId) params.set('organisationId', state.organisationId)
  if (state.industry) params.set('industry', state.industry)
  if (state.sort !== 'name') params.set('sort', state.sort)
  if (state.dir !== 'asc') params.set('dir', state.dir)
  if (state.page !== 1) params.set('page', String(state.page))
  if (state.pageSize !== DEFAULT_CONTACT_PAGE_SIZE) params.set('pageSize', String(state.pageSize))
  return params
}

/**
 * Applies a change. Any filter change returns to page 1: a filter applied on page 7 would
 * otherwise ask for a page the narrowed result may not have.
 */
export function updateContactListState(state: ContactListState, change: Partial<ContactListState>): ContactListState {
  const filterChanged = CONTACT_FILTER_KEYS.some(
    (key) => key in change && JSON.stringify(change[key]) !== JSON.stringify(state[key])
  )
  return { ...state, ...change, ...(filterChanged && change.page === undefined ? { page: 1 } : {}) }
}

/** True when two states select the same contacts (page, size and sort aside). */
export function sameContactSelection(a: ContactListState, b: ContactListState): boolean {
  return CONTACT_FILTER_KEYS.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}

/**
 * The query the contact list API and the export parse (src/lib/contacts/query.ts):
 * the status tab becomes `status`, `subscribed` or `programs`. Page bounds are added by
 * the list request only, so the export still means "everything I am looking at".
 */
export function contactApiQuery(state: ContactListState): string {
  const params = new URLSearchParams()
  if (state.q.trim()) params.set('q', state.q.trim())
  if (state.jobTypeId) params.set('jobTypeId', state.jobTypeId)
  if (state.state) params.set('state', state.state)
  if (state.tagIds.length > 0) params.set('tagIds', state.tagIds.join(','))
  if (state.organisationId) params.set('organisationId', state.organisationId)
  if (state.industry) params.set('industry', state.industry)
  if (state.status === 'lead' || state.status === 'customer' || state.status === 'prospect') params.set('status', state.status)
  if (state.status === 'newsletter') params.set('subscribed', 'true')
  if (state.status === 'programs') params.set('programs', 'true')
  params.set('sort', state.sort)
  params.set('dir', state.dir)
  return params.toString()
}
