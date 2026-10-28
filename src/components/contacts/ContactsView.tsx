'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import styles from '@/app/page.module.css'
import ContactDrawer from '@/components/ContactDrawer'
import ContactTable, { type TableContact } from '@/components/ContactTable'
import DashboardStats from '@/components/DashboardStats'
import BulkContactActions from '@/components/contacts/BulkContactActions'
import BulkTagActions from '@/components/contacts/BulkTagActions'
import FilterBar, { type StatusFilter } from '@/components/contacts/FilterBar'
import type { OrganisationOption } from '@/components/contacts/OrganisationPicker'
import type { TagOption } from '@/components/contacts/TagPicker'
import { useCrm } from '@/components/crm/CrmContext'
import PageHeader from '@/components/crm/PageHeader'
import JobTypesDialog from '@/components/settings/JobTypesDialog'
import Pagination from '@/components/ui/Pagination'
import { contactApiQuery, sameContactSelection, type ContactListState } from '@/lib/contacts/listUrlState'
import { requestLifecycle } from '@/lib/lifecycle/client'
import { hasSupabaseConfig } from '@/lib/supabaseClient'

import { useContactDeepLink } from './useContactDeepLink'
import { useContactList, useContactStats } from './useContactList'
import { useContactListUrl } from './useContactListUrl'
import { useContactQuickActions } from './useContactQuickActions'
import { useFilterLabels } from './useFilterLabels'

type ContactSavePayload = Partial<TableContact> & { organisationName?: string }

const NEW_CONTACT: TableContact = {
  id: '',
  firstName: '',
  lastName: '',
  preferredName: '',
  email: '',
  mobileNumber: '',
  workPhone: '',
  address: '',
  suburb: '',
  state: '',
  postcode: '',
  country: 'Australia',
  department: '',
  position: '',
  status: 'prospect',
  isCustomer: false,
  subscribedToNewsletter: false,
  subscribedToPrograms: false,
  organisation: null,
}

/**
 * Row selection for a partial export. Held as ids rather than contacts: only one page is
 * in memory, and a selection has to survive paging. It is dropped whenever the filters
 * change, because the export applies the active filters — a row ticked under the old
 * filters would silently not be exported under the new ones.
 */
function useSelection(state: ContactListState) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())
  const previous = useRef(state)

  useEffect(() => {
    if (!sameContactSelection(previous.current, state)) {
      setSelected((current) => (current.size === 0 ? current : new Set<string>()))
    }
    previous.current = state
  }, [state])

  const clear = useCallback(() => setSelected((current) => (current.size === 0 ? current : new Set<string>())), [])
  const toggle = useCallback((id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const togglePage = useCallback((ids: string[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)))
      return next
    })
  }, [])
  const list = useMemo(() => [...selected], [selected])

  return { selected, list, clear, toggle, togglePage }
}

function ConnectionBanner() {
  const { isDatabaseConnected, connectionError } = useCrm()
  if (isDatabaseConnected || !connectionError) return null
  return (
    <div className={styles.alertBanner}>
      <svg className={styles.alertIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span>
        <strong>Live database unavailable:</strong> {connectionError}
      </span>
    </div>
  )
}

function Notices({ statsError, hasStats, onRetryStats }: { statsError: string | null; hasStats: boolean; onRetryStats: () => void }) {
  const { importSummary, setImportSummary } = useCrm()
  return (
    <>
      {importSummary && (
        <div className={styles.alertBanner} role="status" data-testid="import-summary">
          <span>{importSummary}</span>
          <button type="button" className={styles.bannerButton} onClick={() => setImportSummary(null)}>
            Dismiss
          </button>
        </div>
      )}
      {statsError && (
        <div className={styles.alertBanner} role="alert" data-testid="stats-error">
          <span>
            <strong>Counts unavailable:</strong> {statsError}
            {hasStats ? ' Showing the last counts that loaded.' : ''}
          </span>
          <button type="button" className={styles.bannerButton} onClick={onRetryStats}>
            Try again
          </button>
        </div>
      )}
    </>
  )
}

/** The contacts workspace: counters, filters (all in the URL), the list and the drawer. */
export default function ContactsView() {
  const { services, jobTypes, reloadLiveData, reloadJobTypes } = useCrm()
  const { state, navigate, searchInput, setSearchInput } = useContactListUrl()
  const labels = useFilterLabels(state.tagIds, state.organisationId)
  const apiQuery = useMemo(() => contactApiQuery(state), [state])
  const list = useContactList(apiQuery, state.page, state.pageSize)
  const stats = useContactStats()
  const selection = useSelection(state)
  const [selectedContact, setSelectedContact] = useState<TableContact | null>(null)
  const [isJobTypesOpen, setIsJobTypesOpen] = useState(false)
  // `?contact=<id>` opens that contact's drawer; closing it drops the parameter.
  const closeDeepLink = useContactDeepLink(setSelectedContact)

  /** Re-reads everything a write can have changed. */
  const refresh = useCallback(async () => {
    await Promise.all([reloadLiveData(), list.reload(), stats.reload()])
  }, [reloadLiveData, list, stats])

  /**
   * One server call commits the contact, its organisation and its services together, or
   * nothing (audit H8). An update names the revision it was edited from, so a concurrent
   * edit is refused rather than overwritten. Errors are rethrown for the drawer.
   */
  const saveContact = async (data: ContactSavePayload) => {
    const { id, revision, ...fields } = data
    const response = await fetch(id ? `/api/contacts/${id}` : '/api/contacts', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, ...(id ? { expectedRevision: revision } : {}) }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `Could not save this contact (HTTP ${response.status}).`)
    }
    await refresh()
  }

  /**
   * Archiving is a soft delete through the API, where the archive rules live. The drawer's
   * confirm dialog reports a failure (and success) itself, so it is only rethrown here.
   */
  const archiveContact = async (id: string) => {
    try {
      const response = await fetch(`/api/contacts/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `Archive failed (HTTP ${response.status})`)
      }
      await refresh()
    } catch (error) {
      console.error('Failed to archive contact', error)
      throw error
    }
  }

  /** Removal is a soft delete as well; errors go back to the drawer's dialog. */
  const removeContact = async (id: string) => {
    await requestLifecycle(`/api/contacts/${id}`, 'remove')
    await refresh()
  }

  const closeDrawer = useCallback(() => {
    setSelectedContact(null)
    closeDeepLink()
  }, [closeDeepLink])

  const quick = useContactQuickActions({
    selection,
    onOpen: setSelectedContact,
    refresh,
    openContactId: selectedContact?.id || null,
    onCloseContact: closeDrawer,
  })

  const handleSort = (key: string) => {
    const dir = state.sort === key && state.dir === 'asc' ? 'desc' : 'asc'
    navigate({ sort: key as ContactListState['sort'], dir, page: 1 })
  }

  const counts = stats.stats ?? { total: 0, leads: 0, customers: 0, prospects: 0, newsletter: 0, programs: 0 }

  return (
    <>
      <ConnectionBanner />
      <PageHeader
        eyebrow="Workspace Overview"
        title="Dashboard overview"
        subtitle="Review and manage your system clients."
        action={
          <button className={styles.actionButton} onClick={() => setSelectedContact({ ...NEW_CONTACT })}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>New Contact</span>
          </button>
        }
      />

      <Notices statsError={stats.error} hasStats={stats.stats !== null} onRetryStats={() => void stats.reload()} />

      <DashboardStats
        totalContacts={counts.total}
        leads={counts.leads}
        customers={counts.customers}
        prospects={counts.prospects}
        newsletterSubscribers={counts.newsletter}
        programSubscribers={counts.programs}
        unavailable={stats.stats === null && hasSupabaseConfig}
      />

      <FilterBar
        searchQuery={searchInput}
        onSearchChange={setSearchInput}
        statusFilter={state.status as StatusFilter}
        onStatusChange={(status) => navigate({ status })}
        jobTypes={jobTypes}
        jobTypeFilter={state.jobTypeId}
        onJobTypeChange={(jobTypeId) => navigate({ jobTypeId })}
        stateFilter={state.state}
        onStateChange={(value) => navigate({ state: value })}
        exportQuery={`&${apiQuery}`}
        resultCount={list.total}
        selectedIds={selection.list}
        onClearSelection={selection.clear}
        tagFilter={labels.tags}
        onTagFilterChange={(tags: TagOption[]) => {
          labels.rememberTags(tags)
          navigate({ tagIds: tags.map((tag) => tag.id) })
        }}
        organisationFilter={labels.organisation}
        onOrganisationFilterChange={(organisation: OrganisationOption | null) => {
          labels.rememberOrganisation(organisation)
          navigate({ organisationId: organisation?.id ?? null })
        }}
        industryFilter={state.industry}
        onIndustryFilterChange={(industry) => navigate({ industry })}
      />

      <BulkContactActions
        selectedIds={selection.list}
        onRequest={quick.requestForSelection}
        onClear={selection.clear}
      />

      {/* The selection is kept after tagging: the user may add a second set of tags to the
          same people, and clearing it is one click away. */}
      <BulkTagActions selectedIds={selection.list} onApplied={() => void refresh()} />

      <ContactTable
        contacts={list.contacts}
        onSelectContact={setSelectedContact}
        onSort={handleSort}
        sortKey={state.sort}
        sortDir={state.dir}
        isLoading={list.isLoading}
        selectedIds={selection.selected}
        onToggleRow={selection.toggle}
        onTogglePage={selection.togglePage}
        loadError={list.error}
        onRetry={() => void list.reload()}
        onRowContextMenu={quick.openMenu}
      />

      {quick.menuElement}
      {quick.dialogElement}

      <Pagination
        page={state.page}
        pageSize={state.pageSize}
        total={list.total}
        shown={list.contacts.length}
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => navigate({ pageSize, page: 1 })}
        label="contacts"
        isLoading={list.isLoading}
        testId="contacts-pagination"
      />

      <ContactDrawer
        contact={selectedContact}
        onClose={closeDrawer}
        onSave={saveContact}
        onDelete={archiveContact}
        onRemove={removeContact}
        availableServices={services}
        jobTypes={jobTypes}
        onManageJobTypes={() => setIsJobTypesOpen(true)}
        isSuspended={isJobTypesOpen}
      />

      {isJobTypesOpen && <JobTypesDialog onClose={() => setIsJobTypesOpen(false)} onChanged={() => void reloadJobTypes()} />}
    </>
  )
}
