'use client'

import React, { useCallback, useEffect, useState } from 'react'

import Pagination from '@/components/ui/Pagination'

import styles from './ArchiveView.module.css'

type ArchivedContact = {
  id: string
  first_name: string
  last_name: string
  email: string
  state: string | null
  deleted_at: string | null
  organisation?: { name: string } | null
}

function formatDate(value: string | null): string {
  if (!value) return 'Unknown'

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? 'Unknown'
    : parsed.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Archived contacts, with restore.
 *
 * The requirement is that records are archived rather than removed — which is only
 * half met if there is no way to see or recover them. Archiving already worked; this is
 * the other half.
 */
export default function ArchiveView() {
  const [contacts, setContacts] = useState<ArchivedContact[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      // The page has to be requested explicitly: /api/contacts always bounds its result
      // set, so omitting it silently pinned this view to the first page while still
      // reporting the full archive count.
      const response = await fetch(
        `/api/contacts?includeArchived=true&page=${page}&pageSize=${pageSize}`
      )

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || 'Could not load archived contacts.')
      }

      const body = await response.json()
      setContacts(body.contacts ?? [])
      setTotal(body.total ?? 0)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load archived contacts.')
    } finally {
      setIsLoading(false)
    }
  }, [page, pageSize])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const restore = async (contact: ArchivedContact) => {
    setRestoringId(contact.id)
    setError(null)

    try {
      const response = await fetch(`/api/contacts/${contact.id}`, { method: 'POST' })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        // A 409 means the email was reused while this contact was archived — an
        // actionable conflict, not a failure to report as "something went wrong".
        throw new Error(body.error || 'Could not restore this contact.')
      }

      // Restoring the only row on the last page would otherwise leave the user staring
      // at an empty page with no obvious way back.
      if (contacts.length === 1 && page > 1) {
        setPage(page - 1)
      } else {
        await load()
      }
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'Could not restore.')
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <div className={styles.layout}>
      {error && (
        <div className={styles.error} role="alert" data-testid="archive-error">
          {error}
        </div>
      )}

      <p className={styles.summary}>
        {isLoading
          ? 'Loading archived contacts…'
          : `${total} archived contact${total === 1 ? '' : 's'}. Archived records are kept and can be restored.`}
      </p>

      {!isLoading && contacts.length === 0 && !error && (
        <p className={styles.empty} data-testid="archive-empty">
          Nothing archived. Contacts you archive from the contact drawer appear here.
        </p>
      )}

      {contacts.length > 0 && (
        <table className={styles.table} data-testid="archive-table">
          <caption className={styles.srOnly}>Archived contacts, with an option to restore each</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>Name</th>
              <th scope="col" className={styles.th}>Email</th>
              <th scope="col" className={styles.th}>Organisation</th>
              <th scope="col" className={styles.th}>Archived</th>
              <th scope="col" className={styles.th}>
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => (
              <tr key={contact.id} className={styles.row}>
                <td className={styles.td}>
                  <span className={styles.name}>
                    {contact.first_name} {contact.last_name}
                  </span>
                </td>
                <td className={styles.td}>{contact.email}</td>
                <td className={styles.td}>{contact.organisation?.name ?? '—'}</td>
                <td className={styles.td}>{formatDate(contact.deleted_at)}</td>
                <td className={`${styles.td} ${styles.actionCell}`}>
                  <button
                    type="button"
                    className={styles.restoreBtn}
                    onClick={() => restore(contact)}
                    disabled={restoringId !== null}
                    data-testid={`restore-${contact.id}`}
                  >
                    {restoringId === contact.id ? 'Restoring…' : 'Restore'}
                  </button>
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
        shown={contacts.length}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        label="archived contacts"
        isLoading={isLoading}
        testId="archive-pagination"
      />
    </div>
  )
}
