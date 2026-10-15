'use client'

import { useCallback, useEffect, useState } from 'react'

import styles from '@/app/page.module.css'
import statsStyles from '@/components/DashboardStats.module.css'
import { useCrm } from '@/components/crm/CrmContext'
import PageHeader from '@/components/crm/PageHeader'
import EmailTemplateRegistry from '@/components/marketing/EmailTemplateRegistry'
import Pagination from '@/components/ui/Pagination'
import { useToast } from '@/components/ui/Toast'
import { getErrorMessage } from '@/lib/contacts/contactRows'
import { useContactStats } from '@/components/contacts/useContactList'
import { getSupabaseClient, hasSupabaseConfig } from '@/lib/supabaseClient'

type SyncLog = { id: string; event_text: string; status: string; created_at: string }
type EmailOctopusHealth =
  | { status: 'unchecked' | 'checking' | 'not_configured' | 'error'; missing: string[] }
  | { status: 'ready' | 'needs_fields'; missing: string[] }

/** Sync log entries per page. Short: it is a timeline, not a report. */
export const SYNC_LOG_PAGE_SIZE = 20

/** One page of the sync activity timeline, newest first, and a way to add to it. */
function useSyncLogs() {
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([])
  const [syncLogsPage, setSyncLogsPage] = useState(1)
  const [syncLogsTotal, setSyncLogsTotal] = useState(0)

  const loadSyncLogs = useCallback(async () => {
    if (!hasSupabaseConfig) {
      setSyncLogs([])
      setSyncLogsTotal(0)
      return
    }
    try {
      const from = (syncLogsPage - 1) * SYNC_LOG_PAGE_SIZE
      const { data, error, count } = await getSupabaseClient()
        .from('sync_logs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + SYNC_LOG_PAGE_SIZE - 1)
      if (error) throw error
      setSyncLogs(((data || []) as SyncLog[]).map(({ id, event_text, status, created_at }) => ({ id, event_text, status, created_at })))
      setSyncLogsTotal(count ?? 0)
    } catch (error) {
      console.error('Failed to load sync logs', error)
    }
  }, [syncLogsPage])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSyncLogs()
  }, [loadSyncLogs])

  const recordSyncLog = useCallback(
    async (eventText: string, status: 'success' | 'failed' | 'info') => {
      const { data, error } = await getSupabaseClient()
        .from('sync_logs')
        .insert({ event_text: eventText, status })
        .select()
        .single()
      if (error) throw error
      if (!data) return null

      const log = { id: data.id, event_text: data.event_text, status: data.status, created_at: data.created_at }
      setSyncLogsTotal((prev) => prev + 1)
      // Only the first page shows the newest entry.
      if (syncLogsPage === 1) setSyncLogs((prev) => [log, ...prev].slice(0, SYNC_LOG_PAGE_SIZE))
      return log
    },
    [syncLogsPage]
  )

  return { syncLogs, syncLogsPage, setSyncLogsPage, syncLogsTotal, recordSyncLog }
}

/** Pushes the whole book to EmailOctopus in server-side chunks; returns the totals. */
async function runSync(): Promise<{ syncedCount: number; errorsCount: number }> {
  // No contact list from the browser: it holds one page only, so the route reads the
  // full book server-side.
  let offset = 0
  let syncedCount = 0
  let errorsCount = 0

  for (let chunk = 0; chunk < 1000; chunk += 1) {
    const response = await fetch('/api/integrations/emailoctopus/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset }),
    })
    const result = await response.json()
    if (!response.ok || !result.success) throw new Error(result.message || result.error || 'Unknown error')

    syncedCount += Number(result.syncedCount) || 0
    errorsCount += Number(result.errorsCount) || 0
    if (!result.hasMore) return { syncedCount, errorsCount }
    if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset) {
      throw new Error('EmailOctopus sync returned an invalid continuation cursor.')
    }
    offset = result.nextOffset
  }
  throw new Error('EmailOctopus sync exceeded the maximum number of chunks.')
}

/** The EmailOctopus workspace: connection health, on-demand sync and its history. */
export default function IntegrationsView() {
  const { notify } = useToast()
  const { emailOctopusStatus } = useCrm()
  const { stats } = useContactStats()
  const { syncLogs, syncLogsPage, setSyncLogsPage, syncLogsTotal, recordSyncLog } = useSyncLogs()
  const [isSyncing, setIsSyncing] = useState(false)
  const [isPreparingEmailOctopus, setIsPreparingEmailOctopus] = useState(false)
  const [emailOctopusHealth, setEmailOctopusHealth] = useState<EmailOctopusHealth>({ status: 'unchecked', missing: [] })

  const isEmailOctopusConfigured = Boolean(emailOctopusStatus?.configured)
  const isEmailOctopusReachable = emailOctopusHealth.status === 'ready' || emailOctopusHealth.status === 'needs_fields'
  const newsletterSubscribersCount = stats?.newsletter ?? 0
  const totalContactsCount = stats?.total ?? 0

  const checkEmailOctopus = useCallback(async () => {
    setEmailOctopusHealth({ status: 'checking', missing: [] })
    try {
      const response = await fetch('/api/integrations/emailoctopus/fields')
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Could not validate the EmailOctopus list.')
      setEmailOctopusHealth({ status: result.ready ? 'ready' : 'needs_fields', missing: Array.isArray(result.missing) ? result.missing : [] })
    } catch (error) {
      console.error('EmailOctopus connection check failed:', error)
      setEmailOctopusHealth({ status: 'error', missing: [] })
    }
  }, [])

  useEffect(() => {
    if (!isEmailOctopusConfigured) return
    const timeoutId = window.setTimeout(() => void checkEmailOctopus(), 0)
    return () => window.clearTimeout(timeoutId)
  }, [checkEmailOctopus, isEmailOctopusConfigured])

  const handleManualSync = async () => {
    setIsSyncing(true)
    try {
      const { syncedCount, errorsCount } = await runSync()
      await recordSyncLog(
        `Sync completed: ${syncedCount} subscribers synced${errorsCount ? `, ${errorsCount} failed` : ''}`,
        errorsCount ? 'failed' : 'success'
      )
      notify(
        errorsCount
          ? { tone: 'error', message: `Sync finished with ${errorsCount} failure(s). See the sync log for details.` }
          : { tone: 'success', message: `Sync complete: ${syncedCount} subscriber(s) synced.` }
      )
    } catch (err) {
      console.error('Sync error:', err)
      await recordSyncLog(`Sync failed: ${getErrorMessage(err)}`, 'failed').catch((logError) => {
        console.error('Failed to record sync failure:', logError)
      })
      notify({ tone: 'error', message: `Sync failed: ${getErrorMessage(err)}` })
    } finally {
      setIsSyncing(false)
    }
  }

  const prepareEmailOctopusFields = async () => {
    setIsPreparingEmailOctopus(true)
    try {
      const response = await fetch('/api/integrations/emailoctopus/fields', { method: 'POST' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || (Array.isArray(result.failed) && result.failed.length > 0)) {
        throw new Error(result.error || 'Some EmailOctopus fields could not be created.')
      }
      await checkEmailOctopus()
    } catch (error) {
      console.error('EmailOctopus field setup failed:', error)
      notify({ tone: 'error', message: `Field setup failed: ${getErrorMessage(error)}` })
    } finally {
      setIsPreparingEmailOctopus(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Mailing List Sync"
        title="EmailOctopus campaigns"
        subtitle="Review mailing lists sync status and activity timelines."
      />

      {/* Sync dashboard layout */}
      <div className={statsStyles.statsGrid} style={{ marginBottom: '32px' }}>
        <div className={statsStyles.cardShell} style={{ cursor: 'default' }}>
          <div className={statsStyles.cardInner}>
            <div className={statsStyles.header}>
              <span className={statsStyles.label}>Connection State</span>
              <div className={`${styles.statusDot} ${emailOctopusHealth.status === 'ready' ? styles.statusActive : styles.statusIdle}`} />
            </div>
            <span className={statsStyles.value} style={{ fontSize: '1.8rem' }}>
              {emailOctopusHealth.status === 'ready'
                ? 'Ready'
                : emailOctopusHealth.status === 'needs_fields'
                  ? 'Setup required'
                  : emailOctopusHealth.status === 'checking'
                    ? 'Checking'
                    : isEmailOctopusConfigured
                      ? 'Connection failed'
                      : 'Not configured'}
            </span>
            <div className={statsStyles.trend}>
              <span className={emailOctopusHealth.status === 'ready' ? statsStyles.trendPositive : statsStyles.trendNeutral}>
                {emailOctopusHealth.status === 'ready'
                  ? 'List and campaign merge fields verified'
                  : emailOctopusHealth.status === 'needs_fields'
                    ? `${emailOctopusHealth.missing.length} required merge fields missing`
                    : isEmailOctopusConfigured
                      ? 'Saved credentials could not validate the list'
                      : 'Requires API key and list ID'}
              </span>
            </div>
          </div>
        </div>

        <div className={statsStyles.cardShell} style={{ cursor: 'default' }}>
          <div className={statsStyles.cardInner}>
            <div className={statsStyles.header}>
              <span className={statsStyles.label}>Subscribers Synced</span>
              <span style={{ color: 'var(--primary)', fontSize: '0.8rem', fontWeight: 600 }}>Total</span>
            </div>
            <span className={statsStyles.value} style={{ fontSize: '1.8rem' }}>{newsletterSubscribersCount} Contacts</span>
            <div className={statsStyles.trend}>
              <span className={statsStyles.trendPositive}>
                {totalContactsCount > 0 ? Math.round((newsletterSubscribersCount / totalContactsCount) * 100) : 0}% list density
              </span>
            </div>
          </div>
        </div>

        <div className={statsStyles.cardShell} style={{ cursor: 'default' }}>
          <div className={statsStyles.cardInner}>
            <div className={statsStyles.header}>
              <span className={statsStyles.label}>Sync Frequency</span>
              <span style={{ color: 'var(--accent)', fontSize: '0.8rem', fontWeight: 600 }}>Active</span>
            </div>
            <span className={statsStyles.value} style={{ fontSize: '1.8rem' }}>On-demand</span>
            <div className={statsStyles.trend}>
              <span className={statsStyles.trendNeutral}>Background replication disabled</span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.splitLayoutEqual}>
        <div className={styles.sectionIntro} style={{ padding: '12px' }}>
          <h3 className={styles.sectionIntroTitle}>Sync Configurations</h3>
          <p className={styles.sectionIntroDesc}>
            On-demand sync pushes newsletter contacts to EmailOctopus. Subscriber webhooks import new website signups when the website and EmailOctopus are configured to call this CRM.
          </p>
          <div className={styles.statusCard} style={{ marginTop: '12px' }}>
            <div className={styles.statusHeader}>
              <span className={`${styles.statusDot} ${emailOctopusHealth.status === 'ready' ? styles.statusActive : styles.statusIdle}`} />
              <span className={styles.settingLabel} style={{ marginBottom: 0 }}>Sync Engine Status</span>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: '1.5' }}>
              {emailOctopusHealth.status === 'ready'
                ? 'Ready. The list exists and every campaign merge field is available.'
                : emailOctopusHealth.status === 'needs_fields'
                  ? `Connected, but missing: ${emailOctopusHealth.missing.join(', ')}.`
                  : emailOctopusHealth.status === 'checking'
                    ? 'Validating the saved API key, list and merge fields.'
                    : isEmailOctopusConfigured
                      ? 'The saved API key or list ID could not be validated.'
                      : 'Configure the API key and list ID in Settings.'}
            </p>
            {emailOctopusHealth.status === 'needs_fields' && (
              <button
                className={styles.actionButton}
                style={{ marginTop: '16px', width: '100%', justifyContent: 'center' }}
                onClick={prepareEmailOctopusFields}
                disabled={isPreparingEmailOctopus}
              >
                {isPreparingEmailOctopus ? 'Creating fields...' : 'Create missing fields'}
              </button>
            )}
            <button 
              className={styles.actionButton} 
              style={{ marginTop: '16px', width: '100%', justifyContent: 'center' }}
              onClick={() => {
                if (!isEmailOctopusReachable) {
                  notify({ tone: 'info', message: 'Validate the EmailOctopus API key and List ID before syncing.' });
                  return;
                }
                handleManualSync();
              }}
              disabled={isSyncing || !isEmailOctopusReachable}
            >
              {isSyncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>

        <div className="outerShell">
          <div className="innerCore" style={{ padding: '24px' }}>
            <h3 className={styles.sectionIntroTitle} style={{ marginBottom: '16px', borderBottom: '1px dashed var(--border)', paddingBottom: '12px' }}>Sync activity history</h3>
            <div className={styles.timeline}>
              {syncLogs.length === 0 ? (
                <div className={styles.timelineItem}>
                  <span className={styles.timelineDot} />
                  <div className={styles.timelineContent}>
                    <span className={styles.timelineTime}>Now</span>
                    <span className={styles.timelineText}>No sync history. Configure credentials to start.</span>
                  </div>
                </div>
              ) : (
                syncLogs.map((log) => (
                  <div key={log.id} className={styles.timelineItem}>
                    <span className={`${styles.timelineDot} ${log.status === 'failed' ? styles.timelineDotWarning : ''}`} />
                    <div className={styles.timelineContent}>
                      <span className={styles.timelineTime}>
                        {new Date(log.created_at).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true
                        })}
                      </span>
                      <span className={styles.timelineText}>{log.event_text}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <Pagination
              page={syncLogsPage}
              pageSize={SYNC_LOG_PAGE_SIZE}
              total={syncLogsTotal}
              shown={syncLogs.length}
              onPageChange={setSyncLogsPage}
              label="sync events"
              testId="sync-logs-pagination"
            />
          </div>
        </div>
      </div>

      {/* Named automations. EmailOctopus publishes no endpoint that lists them,
          so this registry is the only place a name can come from. */}
      <div style={{ marginTop: '32px' }}>
        <EmailTemplateRegistry />
      </div>
    </>
  )
}
