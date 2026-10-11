'use client'

import { useEffect, useMemo, useState } from 'react'

import TagPicker, { type TagOption } from '@/components/contacts/TagPicker'
import { AU_STATES } from '@/lib/contacts/states'
import { MAX_SEGMENT_TAGS } from '@/lib/marketing/segmentCriteria'
import type { FacetCounts, SegmentFacets } from '@/lib/marketing/facets'

import styles from './marketing.module.css'

/** The stored definition shape: criterion name → value. Empty values are omitted. */
export type CriteriaDraft = Record<string, string>

type Option = { id: string; name: string }

type Props = {
  value: CriteriaDraft
  onChange: (next: CriteriaDraft) => void
  jobTypes: Option[]
  /** Per-option counts from the preview; absent until the first one lands. */
  facets?: SegmentFacets
  /** Prefix for test ids, so the create form keeps its historical ones. */
  testIdPrefix?: string
  disabled?: boolean
}

const SOURCE_LABELS: Record<string, string> = {
  newsletter: 'Newsletter sign-up',
  import: 'Spreadsheet import',
  manual: 'Added by hand',
}

/** "(12)" beside an option, or nothing until counts exist. */
function optionCount(counts: FacetCounts | undefined, value: string): string {
  if (!counts) return ''
  return ` (${counts[value] ?? 0})`
}

/** Drops empty values so the stored definition only carries what was chosen. */
function withValue(draft: CriteriaDraft, key: string, value: string): CriteriaDraft {
  const next = { ...draft }
  if (value.trim()) next[key] = value
  else delete next[key]
  return next
}

/** Tag ids as the draft stores them: one comma-separated string. */
function splitIds(value: string | undefined): string[] {
  return (value ?? '').split(',').map((id) => id.trim()).filter(Boolean)
}

/** Shown for a saved tag id the catalogue no longer has, so it can be removed. */
const REMOVED_TAG = 'Removed tag'

/** Criteria beyond the three dropdowns, used to decide whether to open that section. */
const MORE_KEYS = ['organisationId', 'serviceId', 'source', 'createdFrom', 'createdTo', 'position', 'department']

/**
 * Who a segment selects. The three common criteria are always shown, with counts; the
 * rest sit under "More criteria" and open on their own when a saved segment uses one.
 */
export default function SegmentCriteriaFields({
  value,
  onChange,
  jobTypes,
  facets,
  testIdPrefix = 'segment',
  disabled = false,
}: Props) {
  const [services, setServices] = useState<Option[]>([])
  const [organisations, setOrganisations] = useState<Option[]>([])
  const [orgSearch, setOrgSearch] = useState('')
  const [showMore, setShowMore] = useState(() => MORE_KEYS.some((key) => Boolean(value[key])))
  // Names for the tag chips, by id: learnt from the picker, or looked up for a saved segment.
  const [tagNames, setTagNames] = useState<Record<string, string>>({})
  const [lookedUp, setLookedUp] = useState<ReadonlySet<string>>(() => new Set())

  const anyTagIds = useMemo(() => splitIds(value.tagIds), [value.tagIds])
  const excludedTagIds = useMemo(() => splitIds(value.excludeTagIds), [value.excludeTagIds])

  const set = (key: string) => (next: string) => onChange(withValue(value, key, next))
  const testId = (name: string) => `${testIdPrefix}-${name}`

  // Services are a short fixed list; organisations are many and searched by name. The
  // saved organisation is looked up by id so it has a label before anyone searches.
  useEffect(() => {
    if (!showMore) return

    const params = orgSearch.trim()
      ? `?org=${encodeURIComponent(orgSearch.trim())}`
      : value.organisationId
        ? `?orgId=${encodeURIComponent(value.organisationId)}`
        : ''
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/segments/options${params}`)
        if (!response.ok) return
        const body = await response.json()
        setServices(body.services ?? [])
        setOrganisations(body.organisations ?? [])
      } catch {
        // The pickers stay empty; the rest of the form still works.
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [showMore, orgSearch, value.organisationId])

  // A saved segment arrives with ids only; label them once.
  useEffect(() => {
    const unknown = [...anyTagIds, ...excludedTagIds].filter((id) => !(id in tagNames) && !lookedUp.has(id))
    if (unknown.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/segments/options?tagIds=${encodeURIComponent(unknown.join(','))}`)
        const body = response.ok ? await response.json() : {}
        if (cancelled) return
        const found = Object.fromEntries(((body.tags ?? []) as TagOption[]).map((tag) => [tag.id, tag.name]))
        setTagNames((current) => ({ ...current, ...found }))
      } catch {
        // The chips fall back to "Removed tag"; the criteria still work by id.
      } finally {
        if (!cancelled) setLookedUp((current) => new Set([...current, ...unknown]))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [anyTagIds, excludedTagIds, tagNames, lookedUp])

  const asOptions = (ids: string[]): TagOption[] =>
    ids.map((id) => ({ id, name: tagNames[id] ?? (lookedUp.has(id) ? REMOVED_TAG : '…') }))

  const setTags = (key: 'tagIds' | 'excludeTagIds') => (tags: TagOption[]) => {
    setTagNames((current) => ({ ...current, ...Object.fromEntries(tags.map((tag) => [tag.id, tag.name])) }))
    onChange(withValue(value, key, tags.map((tag) => tag.id).join(',')))
  }

  return (
    <>
      <div className={styles.formRow}>
        <div className={styles.field} data-testid={testId('tags')}>
          <TagPicker
            label="Has any of these tags"
            value={asOptions(anyTagIds)}
            onChange={setTags('tagIds')}
            allowCreate={false}
            maxTags={MAX_SEGMENT_TAGS}
            disabled={disabled}
            placeholder="Search tags…"
            hint="Contacts with at least one of the chosen tags. Leave empty for any."
            testId={testId('tag-any')}
          />
        </div>
        <div className={styles.field} data-testid={testId('exclude-tags')}>
          <TagPicker
            label="Leave out contacts tagged"
            value={asOptions(excludedTagIds)}
            onChange={setTags('excludeTagIds')}
            allowCreate={false}
            maxTags={MAX_SEGMENT_TAGS}
            disabled={disabled}
            placeholder="Search tags…"
            hint="Contacts with any of these tags are not in the group, unless added by hand."
            testId={testId('tag-exclude')}
          />
        </div>
      </div>

      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.label}>State</span>
          <select
            className={styles.input}
            value={value.state ?? ''}
            onChange={(event) => set('state')(event.target.value)}
            disabled={disabled}
            data-testid={testId('state')}
          >
            <option value="">Any state{optionCount(facets?.state, '')}</option>
            {AU_STATES.map((state) => (
              <option key={state.code} value={state.code}>
                {state.code}
                {optionCount(facets?.state, state.code)}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Job type</span>
          <select
            className={styles.input}
            value={value.jobTypeId ?? ''}
            onChange={(event) => set('jobTypeId')(event.target.value)}
            disabled={disabled}
            data-testid={testId('job-type')}
          >
            <option value="">Any job type{optionCount(facets?.jobType, '')}</option>
            {jobTypes.map((jobType) => (
              <option key={jobType.id} value={jobType.id}>
                {jobType.name}
                {optionCount(facets?.jobType, jobType.id)}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Status</span>
          <select
            className={styles.input}
            value={value.status ?? ''}
            onChange={(event) => set('status')(event.target.value)}
            disabled={disabled}
            data-testid={testId('status')}
          >
            <option value="">Any status{optionCount(facets?.status, '')}</option>
            <option value="lead">Lead{optionCount(facets?.status, 'lead')}</option>
            <option value="prospect">Prospect{optionCount(facets?.status, 'prospect')}</option>
            <option value="customer">Customer{optionCount(facets?.status, 'customer')}</option>
          </select>
        </label>
      </div>

      <button
        type="button"
        className={styles.linkBtn}
        onClick={() => setShowMore((open) => !open)}
        aria-expanded={showMore}
        data-testid={testId('more')}
      >
        {showMore ? 'Fewer criteria' : 'More criteria'}
      </button>

      {showMore && (
        <div className={styles.formRow}>
          <label className={styles.field}>
            <span className={styles.label}>Organisation</span>
            <input
              className={styles.input}
              value={orgSearch}
              onChange={(event) => setOrgSearch(event.target.value)}
              placeholder="Search organisations…"
              disabled={disabled}
              data-testid={testId('org-search')}
            />
            <select
              className={styles.input}
              value={value.organisationId ?? ''}
              onChange={(event) => set('organisationId')(event.target.value)}
              disabled={disabled}
              aria-label="Organisation"
              data-testid={testId('organisation')}
            >
              <option value="">Any organisation</option>
              {organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Service</span>
            <select
              className={styles.input}
              value={value.serviceId ?? ''}
              onChange={(event) => set('serviceId')(event.target.value)}
              disabled={disabled}
              data-testid={testId('service')}
            >
              <option value="">Any service</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>How they joined</span>
            <select
              className={styles.input}
              value={value.source ?? ''}
              onChange={(event) => set('source')(event.target.value)}
              disabled={disabled}
              data-testid={testId('source')}
            >
              <option value="">Any source</option>
              {Object.entries(SOURCE_LABELS).map(([source, label]) => (
                <option key={source} value={source}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Added from</span>
            <input
              type="date"
              className={styles.input}
              value={value.createdFrom ?? ''}
              onChange={(event) => set('createdFrom')(event.target.value)}
              disabled={disabled}
              data-testid={testId('created-from')}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Added until</span>
            <input
              type="date"
              className={styles.input}
              value={value.createdTo ?? ''}
              onChange={(event) => set('createdTo')(event.target.value)}
              disabled={disabled}
              data-testid={testId('created-to')}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Position contains</span>
            <input
              className={styles.input}
              value={value.position ?? ''}
              onChange={(event) => set('position')(event.target.value)}
              placeholder="Manager"
              disabled={disabled}
              data-testid={testId('position')}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Department contains</span>
            <input
              className={styles.input}
              value={value.department ?? ''}
              onChange={(event) => set('department')(event.target.value)}
              placeholder="Human resources"
              disabled={disabled}
              data-testid={testId('department')}
            />
          </label>
        </div>
      )}
    </>
  )
}
