'use client'

import { useEffect, useState } from 'react'

import Pagination from '@/components/ui/Pagination'

import styles from './marketing.module.css'
import type { OverrideMode, SegmentActions } from './SegmentDrawer'

type Decision = {
  contact_id: string
  mode: OverrideMode
  reason: string | null
  created_at: string
  contact: {
    first_name: string
    last_name: string
    email: string
    subscribed_to_newsletter: boolean
    subscribed_to_programs: boolean
    deleted_at: string | null
  } | null
}

const FILTERS: Array<{ value: '' | OverrideMode; label: string }> = [
  { value: '', label: 'All' },
  { value: 'exclude', label: 'Excluded' },
  { value: 'include', label: 'Added by hand' },
]

/**
 * Every manual decision on this segment, and the way to undo one. Undoing returns the
 * person to being in or out by the criteria alone.
 */
export default function SegmentDecisionsTab({ actions }: { actions: SegmentActions }) {
  const [mode, setMode] = useState<'' | OverrideMode>('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (mode) params.set('mode', mode)

    void (async () => {
      const response = await fetch(`/api/segments/${actions.segmentId}/overrides?${params}`)
      const body = response.ok ? await response.json() : { overrides: [], total: 0 }
      if (!cancelled) {
        setDecisions(body.overrides ?? [])
        setTotal(body.total ?? 0)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [actions.segmentId, actions.refreshKey, mode, page, pageSize])

  return (
    <>
      <div className={styles.segmented} role="group" aria-label="Show">
        {FILTERS.map((filter) => (
          <button
            key={filter.value || 'all'}
            type="button"
            className={`${styles.tab} ${mode === filter.value ? styles.tabActive : ''}`}
            aria-pressed={mode === filter.value}
            onClick={() => {
              setMode(filter.value)
              setPage(1)
            }}
            data-testid={`decisions-filter-${filter.value || 'all'}`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <ul className={styles.list}>
        {decisions.length === 0 && (
          <li className={styles.empty}>No manual decisions. Everyone is in or out by the filters alone.</li>
        )}
        {decisions.map((decision) => (
          <li key={decision.contact_id} className={styles.listItem} data-testid={`decision-${decision.contact_id}`}>
            <span className={styles.campaignMain}>
              <span className={styles.itemName}>
                {decision.contact
                  ? `${decision.contact.first_name} ${decision.contact.last_name}`
                  : 'Deleted contact'}{' '}
                <span className={styles.manualTag}>{decision.mode === 'exclude' ? 'Excluded' : 'Added by hand'}</span>
              </span>
              <span className={styles.itemMeta}>
                {decision.contact?.email}
                {decision.contact?.deleted_at && ' · archived, so not in any audience'}
                {decision.reason && ` · ${decision.reason}`}
              </span>
            </span>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => void actions.undo(decision.contact_id)}
              disabled={actions.locked}
              data-testid={`undo-${decision.contact_id}`}
            >
              {decision.mode === 'exclude' ? 'Restore' : 'Remove'}
            </button>
          </li>
        ))}
      </ul>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        shown={decisions.length}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        label="decisions"
        testId="decisions-pagination"
      />
    </>
  )
}
