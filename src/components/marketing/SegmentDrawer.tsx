'use client'

import { useCallback, useEffect, useState } from 'react'

import LifecycleActions from '@/components/ui/LifecycleActions'
import Portal from '@/components/ui/Portal'
import type { Lifecycle } from '@/lib/lifecycle/lifecycle'

import styles from './marketing.module.css'
import SegmentAddPeopleTab from './SegmentAddPeopleTab'
import SegmentDecisionsTab from './SegmentDecisionsTab'
import SegmentFiltersTab from './SegmentFiltersTab'
import SegmentMembersTab from './SegmentMembersTab'
import type { SegmentSummary } from './SegmentsPanel'

type Option = { id: string; name: string }

type Detail = {
  segment: SegmentSummary
  counts: { newsletter: number; programs: number }
  overrides: { included: number; excluded: number }
  lockedBy: Array<{ id: string; name: string; status: string }>
  lifecycle?: Lifecycle
}

type Tab = 'members' | 'decisions' | 'add' | 'filters'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'members', label: 'Members' },
  { id: 'decisions', label: 'Added & excluded' },
  { id: 'add', label: 'Add people' },
  { id: 'filters', label: 'Filters' },
]

export type OverrideMode = 'include' | 'exclude'

/** What every tab needs to change membership and have the drawer catch up. */
export type SegmentActions = {
  segmentId: string
  locked: boolean
  decide: (contactId: string, mode: OverrideMode) => Promise<{ newsletter: boolean; programs: boolean } | null>
  undo: (contactId: string) => Promise<boolean>
  refreshKey: number
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

/**
 * One segment, opened from the list: who is in it and why, and the controls to change
 * that — exclude someone, add someone the criteria miss, undo either, or edit the
 * criteria. Locked while a campaign using it is approved or sending.
 */
export default function SegmentDrawer({
  segmentId,
  jobTypes,
  onClose,
  onChanged,
}: {
  segmentId: string
  jobTypes: Option[]
  onClose: () => void
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [tab, setTab] = useState<Tab>('members')
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/segments/${segmentId}`)
      if (!response.ok) throw new Error(await readError(response))
      setDetail(await response.json())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the segment.')
    }
  }, [segmentId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const changed = async () => {
    setRefreshKey((key) => key + 1)
    await load()
    onChanged()
  }

  const decide: SegmentActions['decide'] = async (contactId, mode) => {
    setError(null)
    try {
      const response = await fetch(`/api/segments/${segmentId}/overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, mode }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const body = await response.json()
      await changed()
      return body.consent ?? null
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : 'Could not save that change.')
      return null
    }
  }

  const undo: SegmentActions['undo'] = async (contactId) => {
    setError(null)
    try {
      const response = await fetch(`/api/segments/${segmentId}/overrides/${contactId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(await readError(response))
      await changed()
      return true
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : 'Could not undo that change.')
      return false
    }
  }

  const locked = (detail?.lockedBy.length ?? 0) > 0
  const actions: SegmentActions = { segmentId, locked, decide, undo, refreshKey }

  return (
    <Portal>
      <div className={styles.drawerBackdrop} onClick={onClose} data-testid="segment-drawer-backdrop">
        <aside
          className={styles.drawer}
          role="dialog"
          aria-modal="true"
          aria-labelledby="segment-drawer-title"
          onClick={(event) => event.stopPropagation()}
          data-testid="segment-drawer"
        >
          <header className={styles.drawerHeader}>
            <div>
              <h2 id="segment-drawer-title" className={styles.modalTitle}>
                {detail?.segment.name ?? 'Segment'}
              </h2>
              {detail && (
                <p className={styles.modalSubtitle} data-testid="segment-drawer-counts">
                  {detail.counts.newsletter} newsletter · {detail.counts.programs} courses &amp; training ·{' '}
                  {detail.overrides.included} added · {detail.overrides.excluded} excluded
                </p>
              )}
            </div>
            <div className={styles.drawerHeaderActions}>
              {detail && (
                <LifecycleActions
                  endpoint={`/api/segments/${segmentId}`}
                  noun="segment"
                  name={detail.segment.name}
                  archived={false}
                  lifecycle={detail.lifecycle}
                  onChanged={() => {
                    // Archived or removed, it has left the list this drawer was opened from.
                    onChanged()
                    onClose()
                  }}
                />
              )}
              <button type="button" className={styles.secondaryBtn} onClick={onClose} data-testid="close-segment">
                Close
              </button>
            </div>
          </header>

          {locked && detail && (
            <div className={styles.constraint} role="status" data-testid="segment-locked">
              <strong>Locked.</strong> Used by{' '}
              {detail.lockedBy.map((campaign) => `“${campaign.name}”`).join(', ')}, which is approved or
              sending. Move that campaign back to draft to change who is in this segment.
            </div>
          )}

          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}

          <nav className={styles.tabs} role="tablist" aria-label="Segment sections">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
                onClick={() => setTab(item.id)}
                data-testid={`segment-tab-${item.id}`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className={styles.drawerBody} role="tabpanel">
            {tab === 'members' && <SegmentMembersTab actions={actions} />}
            {tab === 'decisions' && <SegmentDecisionsTab actions={actions} />}
            {tab === 'add' && <SegmentAddPeopleTab actions={actions} />}
            {tab === 'filters' && detail && (
              <SegmentFiltersTab segment={detail.segment} jobTypes={jobTypes} locked={locked} onSaved={changed} />
            )}
          </div>
        </aside>
      </div>
    </Portal>
  )
}
