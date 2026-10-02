'use client'

import { useCallback, useId, useState } from 'react'
import type { FormEvent } from 'react'

import type { ContentItemSummary } from '@/lib/content-studio/types'
import Pagination from '@/components/ui/Pagination'

import { errorMessage, listItems } from './api'
import { useResource } from './hooks'
import { formatDateTime } from './labels'
import { ChannelTag, StatusPill } from './StatusPill'
import styles from './ContentStudio.module.css'

const PAGE_SIZE = 25
const REVIEW_PAGE_SIZE = 100

type ItemLibraryProps = {
  onOpen: (itemId: string) => void
  /** Revision queue: only active items with something waiting for review. */
  reviewOnly?: boolean
}

/** Content items with search and an archived filter; the review queue reuses it. */
export default function ItemLibrary({ onOpen, reviewOnly = false }: ItemLibraryProps) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [page, setPage] = useState(1)
  const searchId = useId()

  const load = useCallback(
    () =>
      listItems({
        search: query || undefined,
        status: archived && !reviewOnly ? 'archived' : 'active',
        page,
        pageSize: reviewOnly ? REVIEW_PAGE_SIZE : PAGE_SIZE,
      }),
    [query, archived, page, reviewOnly]
  )
  // The current page stays on screen while the next one loads.
  const { data, error, loading, reload } = useResource(load, { keepPrevious: true })

  const items = (data?.items ?? []).filter((item) => !reviewOnly || item.pendingReviewCount > 0)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setPage(1)
    setQuery(search.trim())
  }

  return (
    <div className="outerShell">
      <div className={`innerCore ${styles.panel}`}>
        <div className={styles.panelHead}>
          <div>
            <h2 className={styles.panelTitle}>{reviewOnly ? 'Waiting for review' : 'Content library'}</h2>
            <p className={styles.panelHint}>
              {reviewOnly
                ? 'Items with at least one variant whose current revision has not been approved or rejected.'
                : 'Every brief and its generated variants. Open one to edit, review and publish.'}
            </p>
          </div>
        </div>

        <form className={styles.toolbarRow} onSubmit={submit} role="search">
          <label htmlFor={searchId} className={styles.visuallyHidden}>
            Search content
          </label>
          <input
            id={searchId}
            type="search"
            className={styles.input}
            placeholder="Search by title"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="submit" className={styles.secondaryBtn}>
            Search
          </button>
          {!reviewOnly && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => {
                  setPage(1)
                  setArchived(event.target.checked)
                }}
              />
              Show archived
            </label>
          )}
        </form>

        {Boolean(error) && (
          <div className={styles.error} role="alert">
            {errorMessage(error, 'Could not load content.')}{' '}
            <button type="button" className={styles.linkBtn} onClick={reload}>
              Try again
            </button>
          </div>
        )}

        {loading && !data && <ListSkeleton />}

        {data && items.length === 0 && (
          <p className={styles.empty}>
            {query
              ? `Nothing matches “${query}”.`
              : reviewOnly
                ? 'Nothing is waiting for review.'
                : archived
                  ? 'No archived content.'
                  : 'No content yet. Start with a brief in Create.'}
          </p>
        )}

        {items.length > 0 && (
          <ul className={styles.itemList} aria-busy={loading}>
            {items.map((item) => (
              <ItemRow key={item.id} item={item} onOpen={onOpen} />
            ))}
          </ul>
        )}

        {data && !reviewOnly && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data.total}
            onPageChange={setPage}
            label="items"
            shown={items.length}
            isLoading={loading}
          />
        )}
      </div>
    </div>
  )
}

function ItemRow({ item, onOpen }: { item: ContentItemSummary; onOpen: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={styles.itemRow} onClick={() => onOpen(item.id)}>
        <span className={styles.itemMain}>
          <span className={styles.itemTitle}>{item.title}</span>
          <span className={styles.itemMeta}>
            Updated {formatDateTime(item.updatedAt)} · {item.variantCount} {item.variantCount === 1 ? 'variant' : 'variants'}
          </span>
        </span>
        <span className={styles.tagRow}>
          {item.channels.map((channel) => (
            <ChannelTag key={channel} channel={channel} />
          ))}
        </span>
        <span className={styles.tagRow}>
          {item.activeJobCount > 0 && <StatusPill tone="info">Generating</StatusPill>}
          {item.pendingReviewCount > 0 && <StatusPill tone="warning">{`${item.pendingReviewCount} to review`}</StatusPill>}
          {item.approvedCount > 0 && <StatusPill tone="success">{`${item.approvedCount} approved`}</StatusPill>}
          {item.archivedAt && <StatusPill tone="neutral">Archived</StatusPill>}
        </span>
      </button>
    </li>
  )
}

function ListSkeleton() {
  return (
    <ul className={styles.itemList} aria-label="Loading content">
      {[0, 1, 2].map((row) => (
        <li key={row}>
          <span className={`skeleton ${styles.skeletonRow}`} />
        </li>
      ))}
    </ul>
  )
}
