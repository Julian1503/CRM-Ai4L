'use client'

import { useCallback, useEffect, useState } from 'react'

import Pagination from '@/components/ui/Pagination'
import { AU_STATES } from '@/lib/contacts/states'
import type { SegmentFacets } from '@/lib/marketing/facets'

import styles from './marketing.module.css'
import SegmentCriteriaFields, { type CriteriaDraft } from './SegmentCriteriaFields'
import SegmentDrawer from './SegmentDrawer'

type Option = { id: string; name: string }

export type SegmentSummary = {
  id: string
  name: string
  description: string | null
  definition: Record<string, unknown>
}

type Preview = {
  total: number
  truncated: boolean
  estimatedSendMs: number
  facets?: SegmentFacets & { truncated: boolean }
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return 'under a second'
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return `${Math.round(ms / 1000)} seconds`
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

const STATUS_LABELS: Record<string, string> = { lead: 'Leads', prospect: 'Prospects', customer: 'Customers' }
const SOURCE_LABELS: Record<string, string> = {
  newsletter: 'joined via the newsletter',
  import: 'imported',
  manual: 'added by hand',
}

/** A saved definition in words, with names rather than ids wherever the page has them. */
export function describeCriteria(definition: Record<string, unknown>, jobTypes: Option[]): string {
  const value = (key: string) => (typeof definition[key] === 'string' ? (definition[key] as string) : '')
  const parts: string[] = []

  if (value('status')) parts.push(STATUS_LABELS[value('status')] ?? value('status'))
  if (value('state')) {
    parts.push(`in ${AU_STATES.find((state) => state.code === value('state'))?.code ?? value('state')}`)
  }
  if (value('jobTypeId')) {
    parts.push(jobTypes.find((jobType) => jobType.id === value('jobTypeId'))?.name ?? 'one job type')
  }
  if (value('organisationId')) parts.push('at one organisation')
  if (value('serviceId')) parts.push('using one service')
  if (value('source')) parts.push(SOURCE_LABELS[value('source')] ?? value('source'))
  if (value('createdFrom')) parts.push(`added from ${value('createdFrom')}`)
  if (value('createdTo')) parts.push(`added until ${value('createdTo')}`)
  if (value('position')) parts.push(`position contains “${value('position')}”`)
  if (value('department')) parts.push(`department contains “${value('department')}”`)
  if (value('q')) parts.push(`matching “${value('q')}”`)

  return parts.length > 0 ? parts.join(' · ') : 'All subscribed contacts'
}

/**
 * Segments: create one, see them all, and open one to see and control who is in it.
 *
 * `onChanged` lets the campaign form refresh its segment picker after a save.
 */
export default function SegmentsPanel({
  jobTypes,
  onChanged,
}: {
  jobTypes: Option[]
  onChanged: () => void
}) {
  const [segments, setSegments] = useState<SegmentSummary[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [total, setTotal] = useState(0)
  const [name, setName] = useState('')
  const [criteria, setCriteria] = useState<CriteriaDraft>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/segments?page=${page}&pageSize=${pageSize}`)
      if (!response.ok) throw new Error(await readError(response))
      const body = await response.json()
      setSegments(body.segments ?? [])
      setTotal(body.total ?? 0)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load segments.')
    }
  }, [page, pageSize])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // Live audience size. Debounced so dragging through a dropdown does not fire a
  // request per change.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/segments/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: criteria }),
        })
        setPreview(response.ok ? await response.json() : null)
      } catch {
        setPreview(null)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [criteria])

  const create = async () => {
    setError(null)
    setBusy(true)

    try {
      const response = await fetch('/api/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, definition: criteria }),
      })

      if (!response.ok) throw new Error(await readError(response))

      setName('')
      // Listings are newest-first, so the new record is on page 1.
      setPage(1)
      await load()
      onChanged()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create segment.')
    } finally {
      setBusy(false)
    }
  }

  const afterDrawerChange = async () => {
    await load()
    onChanged()
  }

  return (
    <section className={styles.panel} aria-labelledby="segments-heading">
      <h2 id="segments-heading" className={styles.panelTitle}>
        Segments
      </h2>
      <p className={styles.panelHint}>
        Segments always exclude archived contacts and anyone who has not agreed to the
        kind of email a campaign sends. Open a segment to see who is in it, and to add or
        remove people by hand.
      </p>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="NSW electricians"
            data-testid="segment-name"
          />
        </label>
      </div>

      <SegmentCriteriaFields
        value={criteria}
        onChange={setCriteria}
        jobTypes={jobTypes}
        facets={preview?.facets}
      />

      <div className={styles.previewRow}>
        <div className={styles.preview} data-testid="segment-preview">
          {preview ? (
            <>
              <span className={styles.previewCount}>{preview.total}</span>
              <span className={styles.previewLabel}>
                subscribed contact{preview.total === 1 ? '' : 's'} match
                {preview.total === 1 ? 'es' : ''}
              </span>
              {preview.total > 0 && (
                <span className={styles.previewMeta}>≈ {formatDuration(preview.estimatedSendMs)} to send</span>
              )}
              {preview.total === 0 && (
                <span className={styles.previewWarning} data-testid="segment-preview-empty">
                  Nothing matches these filters. A campaign on this segment cannot generate copy or
                  send.
                </span>
              )}
              {preview.truncated && (
                <span className={styles.previewWarning}>Capped — only the first 10,000 will receive this.</span>
              )}
            </>
          ) : (
            <span className={styles.previewLabel}>Counting…</span>
          )}
        </div>

        <button
          type="button"
          className={styles.primaryBtn}
          onClick={create}
          disabled={!name.trim() || busy}
          data-testid="create-segment"
        >
          {busy ? 'Saving…' : 'Save segment'}
        </button>
      </div>

      <ul className={styles.list}>
        {segments.length === 0 && <li className={styles.empty}>No segments yet.</li>}
        {segments.map((segment) => (
          <li key={segment.id} className={styles.listItem}>
            <span className={styles.campaignMain}>
              <span className={styles.itemName}>{segment.name}</span>
              <span className={styles.itemMeta}>{describeCriteria(segment.definition ?? {}, jobTypes)}</span>
            </span>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => setOpenId(segment.id)}
              data-testid={`open-segment-${segment.id}`}
            >
              View
            </button>
          </li>
        ))}
      </ul>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        shown={segments.length}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        label="segments"
        testId="segments-pagination"
      />

      {openId && (
        <SegmentDrawer
          segmentId={openId}
          jobTypes={jobTypes}
          onClose={() => setOpenId(null)}
          onChanged={afterDrawerChange}
        />
      )}
    </section>
  )
}
