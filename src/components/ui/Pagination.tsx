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
  /**
   * Rows the caller actually rendered.
   *
   * Without it the window is pure arithmetic and can describe rows that are not on
   * screen — while a filter is in flight the table shows skeletons under a line still
   * claiming "Showing 1–25 of 5,222", which reads as a broken table rather than as a
   * load in progress.
   */
  shown?: number
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
  shown,
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
  // Prefer what is on screen. The arithmetic is the fallback for callers that do not
  // count their rows, and it assumes a full page came back.
  const last =
    shown === undefined ? Math.min(page * pageSize, total) : Math.max(first - 1, first + shown - 1)

  const summary = isLoading
    ? `Loading ${label}…`
    : total === 0
      ? `No ${label}`
      : shown === 0
        // A page past the end of a list that shrank under the user.
        ? `No ${label} on this page`
        : `Showing ${numberFormat.format(first)}–${numberFormat.format(last)} of ${numberFormat.format(total)} ${label}`

  return (
    <nav className={styles.bar} aria-label={`${label} pagination`} data-testid={testId}>
      <p className={styles.summary} aria-live="polite" data-testid={`${testId}-summary`}>
        {summary}
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
