'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { EmailOctopusStatus } from '@/components/settings/EmailOctopusSettings'
import { fetchJobTypes, getErrorMessage, REFERENCE_LIMIT, type ServiceOption } from '@/lib/contacts/contactRows'
import { getSupabaseClient, hasSupabaseConfig } from '@/lib/supabaseClient'

/**
 * What the CRM workspaces share across routes: the reference lists that feed dropdowns
 * (services, job types), the EmailOctopus connection status, the database connection
 * state, the last import's summary (shown on Contacts after an import) and the guard
 * against leaving a workspace with unsaved changes.
 *
 * Loaded once by the shell, so moving between routes does not re-read them.
 */

type CrmContextValue = {
  services: ServiceOption[]
  jobTypes: ServiceOption[]
  emailOctopusStatus: EmailOctopusStatus | null
  setEmailOctopusStatus: (status: EmailOctopusStatus | null) => void
  isDatabaseConnected: boolean
  connectionError: string | null
  /** Re-reads services, job types and the integration status. */
  reloadLiveData: () => Promise<void>
  /** Re-reads only the job types, after the catalogue changes. */
  reloadJobTypes: () => Promise<void>
  /** What the last import did, kept until dismissed: it can name rows to follow up. */
  importSummary: string | null
  setImportSummary: (summary: string | null) => void
  /**
   * A workspace with unsaved changes registers the question to ask before leaving it;
   * null clears it. confirmLeave() asks it (if any) and says whether to go.
   */
  setLeaveGuard: (message: string | null) => void
  confirmLeave: () => boolean
}

const noop = () => {}
const resolved = async () => {}

const CrmContext = createContext<CrmContextValue>({
  services: [],
  jobTypes: [],
  emailOctopusStatus: null,
  setEmailOctopusStatus: noop,
  isDatabaseConnected: false,
  connectionError: null,
  reloadLiveData: resolved,
  reloadJobTypes: resolved,
  importSummary: null,
  setImportSummary: noop,
  setLeaveGuard: noop,
  confirmLeave: () => true,
})

export function useCrm(): CrmContextValue {
  return useContext(CrmContext)
}

const NOT_CONFIGURED =
  'Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to load CRM data.'

function useLiveData() {
  const [services, setServices] = useState<ServiceOption[]>([])
  const [jobTypes, setJobTypes] = useState<ServiceOption[]>([])
  const [emailOctopusStatus, setEmailOctopusStatus] = useState<EmailOctopusStatus | null>(null)
  const [isDatabaseConnected, setIsDatabaseConnected] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)

  const reloadLiveData = useCallback(async () => {
    if (!hasSupabaseConfig) {
      setServices([])
      setJobTypes([])
      setEmailOctopusStatus(null)
      setIsDatabaseConnected(false)
      setConnectionError(NOT_CONFIGURED)
      return
    }

    try {
      const { data: serviceData, error: serviceError } = await getSupabaseClient()
        .from('services')
        .select('*')
        .order('name')
        .limit(REFERENCE_LIMIT)
      if (serviceError) throw serviceError

      const jobTypeData = await fetchJobTypes()

      const statusResponse = await fetch('/api/integrations/emailoctopus/credentials')
      const statusBody = await statusResponse.json().catch(() => ({}))
      if (!statusResponse.ok) {
        throw new Error(statusBody.error || `Could not read integration settings (HTTP ${statusResponse.status})`)
      }

      setServices(((serviceData || []) as ServiceOption[]).map((service) => ({ id: service.id, name: service.name })))
      setJobTypes(jobTypeData)
      setEmailOctopusStatus(statusBody as EmailOctopusStatus)
      setIsDatabaseConnected(true)
      setConnectionError(null)
    } catch (error) {
      setServices([])
      setJobTypes([])
      setIsDatabaseConnected(false)
      setConnectionError(`Supabase connection failed: ${getErrorMessage(error)}`)
      console.error('Supabase connection failed:', error)
    }
  }, [])

  const reloadJobTypes = useCallback(async () => {
    if (!hasSupabaseConfig) return
    try {
      setJobTypes(await fetchJobTypes())
    } catch (error) {
      console.error('Failed to reload job types', error)
    }
  }, [])

  useEffect(() => {
    // The shell loads its reference data once, on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadLiveData()
  }, [reloadLiveData])

  return useMemo(
    () => ({
      services,
      jobTypes,
      emailOctopusStatus,
      setEmailOctopusStatus,
      isDatabaseConnected,
      connectionError,
      reloadLiveData,
      reloadJobTypes,
    }),
    [services, jobTypes, emailOctopusStatus, isDatabaseConnected, connectionError, reloadLiveData, reloadJobTypes]
  )
}

export function CrmProvider({ children }: { children: ReactNode }) {
  const live = useLiveData()
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const leaveGuard = useRef<string | null>(null)

  const setLeaveGuard = useCallback((message: string | null) => {
    leaveGuard.current = message
  }, [])

  const confirmLeave = useCallback(() => {
    const message = leaveGuard.current
    if (message && !window.confirm(message)) return false
    leaveGuard.current = null
    return true
  }, [])

  const value = useMemo(
    () => ({ ...live, importSummary, setImportSummary, setLeaveGuard, confirmLeave }),
    [live, importSummary, setLeaveGuard, confirmLeave]
  )

  return <CrmContext.Provider value={value}>{children}</CrmContext.Provider>
}
