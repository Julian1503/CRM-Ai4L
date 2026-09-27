'use client'

import { useEffect, useState } from 'react'

import Pagination from '@/components/ui/Pagination'
import type { ConsentStream } from '@/lib/db/types'
import { CONSENT_STREAM_LABELS } from '@/lib/marketing/consentStream'

import styles from './marketing.module.css'
import type { SegmentActions } from './SegmentDrawer'

type Member = {
  id: string
  first_name: string
  last_name: string
  email: string
  organisation: string | null
  state: string | null
  status: string | null
  is_included: boolean
}

/**
 * Who is in the segment right now, for one stream.
 *
 * The stream matters: the same criteria reach different people for the newsletter and
 * for courses, because each needs its own consent. Excluding someone here removes them
 * from the segment for every campaign that uses it.
 */
export default function SegmentMembersTab({ actions }: { actions: SegmentActions }) {
  const [stream, setStream] = useState<ConsentStream>('newsletter')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [members, setMembers] = useState<Member[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ stream, page: String(page), pageSize: String(pageSize) })
    if (query.trim()) params.set('q', query.trim())

    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const response = await fetch(`/api/segments/${actions.segmentId}/members?${params}`)
        const body = response.ok ? await response.json() : { members: [], total: 0 }
        if (!cancelled) {
          setMembers(body.members ?? [])
          setTotal(body.total ?? 0)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [actions.segmentId, actions.refreshKey, stream, query, page, pageSize])

  return (
    <>
      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.label}>Receiving</span>
          <select
            className={styles.input}
            value={stream}
            onChange={(event) => {
              setStream(event.target.value === 'programs' ? 'programs' : 'newsletter')
              setPage(1)
            }}
            data-testid="members-stream"
          >
            {(Object.keys(CONSENT_STREAM_LABELS) as ConsentStream[]).map((option) => (
              <option key={option} value={option}>
                {CONSENT_STREAM_LABELS[option]} emails
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Search</span>
          <input
            className={styles.input}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(1)
            }}
            placeholder="Name, email or organisation"
            data-testid="members-search"
          />
        </label>
      </div>

      <p className={styles.itemMeta} data-testid="members-total">
        {loading ? 'Counting…' : `${total} ${total === 1 ? 'person' : 'people'}`}
      </p>

      <table className={styles.audienceTable}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Organisation</th>
            <th>State</th>
            <th>Status</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {!loading && members.length === 0 && (
            <tr>
              <td colSpan={6} className={styles.empty}>
                Nobody matches.
              </td>
            </tr>
          )}
          {members.map((member) => (
            <tr key={member.id} data-testid={`member-${member.id}`}>
              <td>
                {member.first_name} {member.last_name}
                {member.is_included && <span className={styles.manualTag}>Added by hand</span>}
              </td>
              <td>{member.email}</td>
              <td>{member.organisation ?? '—'}</td>
              <td>{member.state ?? '—'}</td>
              <td>{member.status ?? '—'}</td>
              <td>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => void actions.decide(member.id, 'exclude')}
                  disabled={actions.locked}
                  data-testid={`exclude-${member.id}`}
                >
                  Exclude
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        shown={members.length}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        label="members"
        testId="members-pagination"
      />
    </>
  )
}
