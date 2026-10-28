'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import ArchiveHub from '@/components/archive/ArchiveHub'
import BookingsView from '@/components/bookings/BookingsView'
import ContentStudioView from '@/components/content-studio/ContentStudioView'
import CampaignsHub from '@/components/marketing/CampaignsHub'
import SettingsView from '@/components/settings/SettingsView'
import { contactHref } from '@/components/contacts/useContactDeepLink'
import { VIEW_ROUTES } from '@/lib/navigation/routes'

import { useCrm } from './CrmContext'
import PageHeader from './PageHeader'

export const SETTINGS_LEAVE_MESSAGE = 'Discard unsaved brand changes and leave Settings?'
export const STUDIO_LEAVE_MESSAGE = 'Discard unsaved variant changes and leave Content Studio?'

export function ArchiveWorkspace() {
  return (
    <>
      <PageHeader
        eyebrow="Retained Records"
        title="Archive"
        subtitle="Archived records are kept and can be restored. Removing one takes it out of the CRM for good, but nothing is ever deleted."
      />
      <ArchiveHub />
    </>
  )
}

/** `?tab=` picks the tab; `?campaign=<id>` opens that campaign (newsletter review emails link here). */
export function CampaignsWorkspace() {
  const { jobTypes } = useCrm()
  return (
    <>
      <PageHeader
        eyebrow="Outreach"
        title="Segments and campaigns"
        subtitle="Build an audience from the database, then approve and send."
      />
      <CampaignsHub jobTypes={jobTypes} />
    </>
  )
}

export function ContentWorkspace() {
  const router = useRouter()
  const { setLeaveGuard } = useCrm()
  return (
    <>
      <PageHeader
        title="Content Studio"
        subtitle="Write once for social and email. Every channel is reviewed and approved on its own."
      />
      <ContentStudioView
        onDirtyChange={(dirty) => setLeaveGuard(dirty ? STUDIO_LEAVE_MESSAGE : null)}
        onOpenSettings={() => router.push(`${VIEW_ROUTES.settings}?section=connections`)}
        onOpenCampaign={(campaignId) => router.push(`${VIEW_ROUTES.campaigns}?campaign=${encodeURIComponent(campaignId)}`)}
      />
      <GuardCleanup />
    </>
  )
}

export function BookingsWorkspace() {
  const router = useRouter()
  return (
    <>
      <PageHeader
        eyebrow="Consultations"
        title="Consultation bookings"
        subtitle="Every booking link a campaign sent, and how far each one got — from the $500 consultation claimed at $0 through to a scheduled time."
      />
      <BookingsView
        onOpenIntegrationHealth={() => router.push(`${VIEW_ROUTES.settings}?section=overview`)}
        onOpenContact={(contactId) => router.push(contactHref(contactId))}
      />
    </>
  )
}

export function SettingsWorkspace() {
  const router = useRouter()
  const { emailOctopusStatus, setEmailOctopusStatus, reloadJobTypes, setLeaveGuard } = useCrm()
  return (
    <>
      <SettingsView
        emailOctopusStatus={emailOctopusStatus}
        onEmailOctopusSaved={setEmailOctopusStatus}
        onJobTypesChanged={() => void reloadJobTypes()}
        // Contacts re-reads its list and filter options whenever it is opened again.
        onOrganisationsChanged={() => undefined}
        onDirtyChange={(dirty) => setLeaveGuard(dirty ? SETTINGS_LEAVE_MESSAGE : null)}
        onOpenStudio={() => {
          setLeaveGuard(null)
          router.push(VIEW_ROUTES.content)
        }}
      />
      <GuardCleanup />
    </>
  )
}

/**
 * Drops the workspace's "discard unsaved changes?" question when it unmounts: a page that
 * is gone has nothing left to lose.
 */
function GuardCleanup() {
  const { setLeaveGuard } = useCrm()
  useEffect(() => () => setLeaveGuard(null), [setLeaveGuard])
  return null
}
