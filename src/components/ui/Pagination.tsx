'use client'

import React from 'react'

import styles from './Pagination.module.css'

const PAGE_SIZE_CHOICES = [25, 50, 100, 200]

export interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  /** Omit to hide the page-size selector. */
  onPageSizeChange?: (pageSize: number) => void
  /** Plural noun for the summary line, e.g. "contacts". */
  label: string
  isLoading?: boolean
  /** Distinguishes the controls when a screen renders more than one pager. */
  testId?: string
}

const numberFormat = new Intl.NumberFormat('en-AU')

/**
 * Numbered pager for a server-paginated list.
 *
 * Deliberately shows the total as well as the current window: the point of paginating
 * these lists is that a table can be larger than what is on screen, and a pager that
 * only says "next" leaves the user unable to tell whether they are looking at
 * everything. Renders nothing when a single page holds the whole list, so short lists
 * are not cluttered with dead controls.
 */
export default function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  label,
  isLoading = false,
  testId = 'pagination',
}: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  // A page-size selector is still worth showing on a single page of results, since it is
  // how the user asks for more at once.
  if (pageCount <= 1 && !onPageSizeChange) {
    return null
  }

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)

  return (
    <nav className={styles.bar} aria-label={`${label} pagination`} data-testid={testId}>
      <p className={styles.summary} aria-live="polite" data-testid={`${testId}-summary`}>
        {total === 0
          ? `No ${label}`
          : `Showing ${numberFormat.format(first)}–${numberFormat.format(last)} of ${numberFormat.format(total)} ${label}`}
      </p>

      <div className={styles.controls}>
        {pageCount > 1 && (
          <>
            <button
              type="button"
              className={styles.pageBtn}
              onClick={() => onPageChange(page - 1)}
              disabled={isLoading || page <= 1}
              data-testid={`${testId}-prev`}
            >
              ‹ Previous
            </button>

            <span className={styles.position} data-testid={`${testId}-position`}>
              Page {numberFormat.format(page)} of {numberFormat.format(pageCount)}
            </span>

            <button
              type="button"
              className={styles.pageBtn}
              onClick={() => onPageChange(page + 1)}
              disabled={isLoading || page >= pageCount}
              data-testid={`${testId}-next`}
            >
              Next ›
            </button>
          </>
        )}

        {onPageSizeChange && (
          <label className={styles.sizeLabel}>
            <span className={styles.srOnly}>{label} per page</span>
            <select
              className={styles.sizeSelect}
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              disabled={isLoading}
              data-testid={`${testId}-size`}
            >
              {PAGE_SIZE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice} per page
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </nav>
  )
}
