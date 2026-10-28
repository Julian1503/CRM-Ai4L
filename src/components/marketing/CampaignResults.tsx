'use client'

import { useCallback, useEffect, useState } from 'react'

import Pagination from '@/components/ui/Pagination'
import type { CampaignResult } from '@/lib/marketing/campaignResults'

import StreamPill from './StreamPill'
import styles from './CampaignResults.module.css'

export interface CampaignResultsProps {
  onOpenCampaign: (campaignId: string) => void
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const MONEY_FORMAT = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' })

const STATUS_LABELS: Record<string, string> = {
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
}

/** "12%" of the people emailed, or nothing when nobody was emailed yet. */
function shareOf(count: number, sent: number): string | null {
  if (sent <= 0) return null
  return `${Math.round((count / sent) * 100)}%`
}

function emailedNote(result: CampaignResult): string | null {
  const send = result.send
  if (!send) return null

  const notes: string[] = []
  if (send.pending > 0) notes.push(`${send.pending} still to go`)
  if (send.failed > 0) notes.push(`${send.failed} failed`)
  if (send.uncertain > 0) notes.push(`${send.uncertain} to check`)
  if (send.skipped > 0) notes.push(`${send.skipped} skipped`)
  return notes.length > 0 ? notes.join(' · ') : null
}

/**
 * How each sent campaign did: how many it reached, then how many of those started
 * booking from the link, paid (or claimed the consultation at $0), have a time booked,
 * or cancelled. Read-only — Open jumps to the campaign itself for anything to act on.
 *
 * Starting a booking is the only engagement measure there is: EmailOctopus reports
 * nothing for automation sends, so email opens and other clicks are not known.
 * "Emailed" is the current send; the booking figures cover every send of the campaign.
 */
export default function CampaignResults({ onOpenCampaign }: CampaignResultsProps) {
  const [results, setResults] = useState<CampaignResult[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/campaigns/results?page=${page}&pageSize=${pageSize}`)
      const body = (await response.json().catch(() => ({}))) as {
        results?: CampaignResult[]
        total?: number
        error?: string
      }
      if (!response.ok) throw new Error(body.error || 'Could not load campaign results.')

      setResults(Array.isArray(body.results) ? body.results : [])
      setTotal(typeof body.total === 'number' ? body.total : 0)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load campaign results.')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  return (
    <section className={styles.panel} aria-labelledby="results-heading" data-testid="campaign-results">
      <div className={styles.header}>
        <h2 id="results-heading" className={styles.title}>
          Results
        </h2>
        <p className={styles.hint}>
          Every campaign that went out, newest first. Counts are people: each recipient counts
          once, at the furthest step they reached — from opening checkout through the link to
          a time in the calendar. A campaign sent more than once counts everyone it reached.
        </p>
      </div>

      {error && (
        <div className={styles.error} role="alert" data-testid="campaign-results-error">
          {error}{' '}
          <button type="button" className={styles.retry} onClick={() => void load()} disabled={loading}>
            Try again
          </button>
        </div>
      )}

      {!error && !loading && results.length === 0 && (
        <p className={styles.empty} data-testid="campaign-results-empty">
          No campaign has been sent yet. Once one goes out, how many people it reached and
          how many booked will show here.
        </p>
      )}

      {results.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table} aria-busy={loading}>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Sent</th>
                <th scope="col" className={styles.num}>Emailed</th>
                <th scope="col" className={styles.num}>Started booking</th>
                <th scope="col" className={styles.num}>Paid</th>
                <th scope="col" className={styles.num}>Booked</th>
                <th scope="col" className={styles.num}>Cancelled</th>
                <th scope="col"><span className={styles.srOnly}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => {
                const sent = result.send?.sent ?? 0
                const note = emailedNote(result)
                const { funnel } = result

                return (
                  <tr key={result.id} data-testid={`result-${result.id}`}>
                    <td data-label="Campaign">
                      <span className={styles.name}>{result.name}</span>
                      <span className={styles.meta}>
                        <span className={`${styles.status} ${styles[`status_${result.status}`] ?? ''}`}>
                          {STATUS_LABELS[result.status] ?? result.status}
                        </span>
                        <StreamPill stream={result.consentStream} />
                        {result.segmentName ?? 'No segment'}
                        {result.run > 1 ? ` · sent ${result.run} times` : ''}
                      </span>
                    </td>
                    <td data-label="Sent" className={styles.date}>
                      {result.startedAt ? DATE_FORMAT.format(new Date(result.startedAt)) : '—'}
                    </td>
                    <td data-label="Emailed" className={styles.num}>
                      <span className={styles.figure} data-testid={`result-emailed-${result.id}`}>{sent}</span>
                      {note && <span className={styles.subtle}>{note}</span>}
                    </td>
                    <td data-label="Started booking" className={styles.num}>
                      <Figure value={funnel.started} share={shareOf(funnel.started, sent)} />
                    </td>
                    <td data-label="Paid" className={styles.num}>
                      <Figure value={funnel.paid} share={shareOf(funnel.paid, sent)} />
                      {funnel.chargedCents > 0 && (
                        <span className={styles.subtle}>{MONEY_FORMAT.format(funnel.chargedCents / 100)}</span>
                      )}
                    </td>
                    <td data-label="Booked" className={styles.num}>
                      <Figure value={funnel.booked} share={shareOf(funnel.booked, sent)} strong />
                    </td>
                    <td data-label="Cancelled" className={styles.num}>
                      <Figure value={funnel.cancelled} share={null} />
                    </td>
                    <td className={styles.actionCell}>
                      <button
                        type="button"
                        className={styles.open}
                        onClick={() => onOpenCampaign(result.id)}
                        aria-label={`Open ${result.name}`}
                        data-testid={`result-open-${result.id}`}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        shown={results.length}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        label="campaigns"
        testId="campaign-results-pagination"
      />
    </section>
  )
}

function Figure({ value, share, strong = false }: { value: number; share: string | null; strong?: boolean }) {
  return (
    <>
      <span className={`${styles.figure} ${strong && value > 0 ? styles.figureStrong : ''}`}>{value}</span>
      {share && value > 0 && <span className={styles.subtle}>{share}</span>}
    </>
  )
}
