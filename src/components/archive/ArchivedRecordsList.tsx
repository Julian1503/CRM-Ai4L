'use client'

import { useCallback, useEffect, useState } from 'react'

import LifecycleActions from '@/components/ui/LifecycleActions'
import Pagination from '@/components/ui/Pagination'

import styles from '../contacts/ArchiveView.module.css'

export type ArchivedRecord = {
  id: string
  name: string
  archivedAt: string | null
  /** One line of context: a status, a segment, a description. */
  detail?: string | null
}

export type ArchivedPage = { records: ArchivedRecord[]; total: number }

type ArchivedRecordsListProps = {
  noun: string
  plural: string
  load: (page: number, pageSize: number) => Promise<ArchivedPage>
  endpoint: (id: string) => string
  emptyHint: string
}

function formatDate(value: string | null): string {
  if (!value) return 'Unknown'

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? 'Unknown'
    : parsed.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Archived records of one kind, each with Restore and Remove.
 *
 * Contacts have their own list (ArchiveView) because restoring one carries consent
 * rules; everything else archives the same way and shares this one.
 */
export default function ArchivedRecordsList({ noun, plural, load, endpoint, emptyHint }: ArchivedRecordsListProps) {
  const [records, setRecords] = useState<ArchivedRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await load(page, pageSize)
      setRecords(result.records)
      setTotal(result.total)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : `Could not load archived ${plural}.`)
    } finally {
      setIsLoading(false)
    }
  }, [load, page, pageSize, plural])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [refresh])

  const changed = async () => {
    // Restoring or removing the only row on a later page would strand the view on an
    // empty page.
    if (records.length === 1 && page > 1) setPage(page - 1)
    else await refresh()
  }

  return (
    <div className={styles.layout}>
      {error && (
        <div className={styles.error} role="alert" data-testid={`archived-${noun}-error`}>
          {error}
        </div>
      )}

      <p className={styles.summary}>
        {isLoading ? `Loading archived ${plural}…` : `${total} archived ${total === 1 ? noun : plural}.`}
      </p>

      {!isLoading && records.length === 0 && !error && (
        <p className={styles.empty} data-testid={`archived-${noun}-empty`}>
          {emptyHint}
        </p>
      )}

      {records.length > 0 && (
        <table className={styles.table} data-testid={`archived-${noun}-table`}>
          <caption className={styles.srOnly}>Archived {plural}, with options to restore or remove each</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>Name</th>
              <th scope="col" className={styles.th}>Details</th>
              <th scope="col" className={styles.th}>Archived</th>
              <th scope="col" className={styles.th}>
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id} className={styles.row}>
                <td className={styles.td}>
                  <span className={styles.name}>{record.name}</span>
                </td>
                <td className={styles.td}>{record.detail || '—'}</td>
                <td className={styles.td}>{formatDate(record.archivedAt)}</td>
                <td className={`${styles.td} ${styles.actionCell}`}>
                  <LifecycleActions
                    endpoint={endpoint(record.id)}
                    noun={noun}
                    name={record.name}
                    archived
                    onChanged={changed}
                    testId={`archived-${noun}-${record.id}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        shown={records.length}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        label={`archived ${plural}`}
        isLoading={isLoading}
        testId={`archived-${noun}-pagination`}
      />
    </div>
  )
}
