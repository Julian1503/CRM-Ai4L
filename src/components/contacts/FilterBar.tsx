'use client'

import React from 'react'

import { AU_STATES } from '@/lib/contacts/states'

import styles from './FilterBar.module.css'

export type StatusFilter = 'all' | 'lead' | 'prospect' | 'customer' | 'subscribed'

export type JobTypeOption = { id: string; name: string }

interface FilterBarProps {
  searchQuery: string
  onSearchChange: (value: string) => void
  statusFilter: StatusFilter
  onStatusChange: (value: StatusFilter) => void
  jobTypes: JobTypeOption[]
  jobTypeFilter: string
  onJobTypeChange: (value: string) => void
  stateFilter: string
  onStateChange: (value: string) => void
  /** Query string describing the active filters, forwarded to the export endpoint. */
  exportQuery: string
  /** Number of contacts currently matching, shown so an export has a known size. */
  resultCount: number
}

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All List' },
  { value: 'lead', label: 'Leads' },
  { value: 'customer', label: 'Customers' },
  { value: 'prospect', label: 'Prospects' },
  { value: 'subscribed', label: 'Subscribed' },
]

export default function FilterBar({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusChange,
  jobTypes,
  jobTypeFilter,
  onJobTypeChange,
  stateFilter,
  onStateChange,
  exportQuery,
  resultCount,
}: FilterBarProps) {
  const hasActiveFilters =
    searchQuery !== '' || statusFilter !== 'all' || jobTypeFilter !== '' || stateFilter !== ''

  const clearAll = () => {
    onSearchChange('')
    onStatusChange('all')
    onJobTypeChange('')
    onStateChange('')
  }

  return (
    <div className={styles.filterBar}>
      <div className={styles.primaryRow}>
        <div className={styles.searchWrapper}>
          <svg
            className={styles.searchIcon}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <label htmlFor="contact-search" className={styles.srOnly}>
            Search contacts
          </label>
          <input
            id="contact-search"
            type="search"
            placeholder="Search name, organisation, title…"
            className={styles.searchInput}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>

        <div className={styles.statusTabs} role="group" aria-label="Filter by client status">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              data-testid={`status-filter-${tab.value}`}
              className={`${styles.statusTab} ${
                statusFilter === tab.value ? styles.statusTabActive : ''
              }`}
              aria-pressed={statusFilter === tab.value}
              onClick={() => onStatusChange(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.secondaryRow}>
        <div className={styles.selectGroup}>
          <label htmlFor="job-type-filter" className={styles.selectLabel}>
            Job type
          </label>
          <select
            id="job-type-filter"
            data-testid="job-type-filter"
            className={styles.select}
            value={jobTypeFilter}
            onChange={(event) => onJobTypeChange(event.target.value)}
          >
            <option value="">All job types</option>
            {jobTypes.map((jobType) => (
              <option key={jobType.id} value={jobType.id}>
                {jobType.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.selectGroup}>
          <label htmlFor="state-filter" className={styles.selectLabel}>
            State
          </label>
          <select
            id="state-filter"
            data-testid="state-filter"
            className={styles.select}
            value={stateFilter}
            onChange={(event) => onStateChange(event.target.value)}
          >
            <option value="">All states</option>
            {AU_STATES.map((state) => (
              <option key={state.code} value={state.code}>
                {state.code} — {state.name}
              </option>
            ))}
          </select>
        </div>

        {hasActiveFilters && (
          <button type="button" className={styles.clearBtn} onClick={clearAll}>
            Clear filters
          </button>
        )}

        <div className={styles.exportGroup}>
          <span className={styles.exportLabel}>
            Export {resultCount} {resultCount === 1 ? 'contact' : 'contacts'}
          </span>
          {/* Plain links: the route sets Content-Disposition, so no JS is involved and
              the active filters travel with the request. */}
          <a
            className={styles.exportBtn}
            data-testid="export-full"
            href={`/api/contacts/export?format=full${exportQuery}`}
          >
            CSV
          </a>
          <a
            className={styles.exportBtn}
            data-testid="export-emailoctopus"
            href={`/api/contacts/export?format=emailoctopus${exportQuery}`}
          >
            EmailOctopus
          </a>
        </div>
      </div>
    </div>
  )
}
