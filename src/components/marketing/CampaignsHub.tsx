'use client'

import { useCallback, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import CampaignResults from './CampaignResults'
import MarketingView from './MarketingView'
import NewsletterSchedules from './NewsletterSchedules'
import SegmentsPanel from './SegmentsPanel'
import styles from './CampaignsHub.module.css'

export type CampaignsTab = 'campaigns' | 'results' | 'segments' | 'newsletters'

const TABS: ReadonlyArray<{ id: CampaignsTab; label: string }> = [
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'results', label: 'Results' },
  { id: 'segments', label: 'Segments' },
  { id: 'newsletters', label: 'Recurring newsletters' },
]

function readTab(value: string | null): CampaignsTab | null {
  return TABS.some((tab) => tab.id === value) ? (value as CampaignsTab) : null
}

export interface CampaignsHubProps {
  jobTypes: Array<{ id: string; name: string }>
}

/**
 * The Outreach workspace, one job per tab: write and send campaigns, see how the sent
 * ones did, build the audiences they go to, and run the newsletters that draft
 * themselves.
 *
 * The tab lives in the URL (`?tab=`) so a reload, the back button and a shared link
 * all land where the user was. `?campaign=<id>` — the link in a newsletter review
 * email — opens Campaigns with that campaign's copy open.
 */
export default function CampaignsHub({ jobTypes }: CampaignsHubProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const campaignId = searchParams.get('campaign') ?? undefined
  const tab = readTab(searchParams.get('tab')) ?? 'campaigns'
  /** Bumped when a segment is saved, so the campaign form's segment picker re-reads. */
  const [segmentsVersion, setSegmentsVersion] = useState(0)

  const go = useCallback(
    (next: CampaignsTab, campaign?: string) => {
      const params = new URLSearchParams()
      if (next !== 'campaigns') params.set('tab', next)
      if (campaign) params.set('campaign', campaign)
      const query = params.toString()
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router]
  )

  return (
    <div className={styles.hub}>
      <nav className={styles.tabs} role="tablist" aria-label="Outreach">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`outreach-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="outreach-panel"
            className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
            onClick={() => go(item.id)}
            data-testid={`outreach-tab-${item.id}`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div id="outreach-panel" role="tabpanel" aria-labelledby={`outreach-tab-${tab}`} className={styles.panel}>
        {/* Campaigns stays mounted while hidden: a half-written campaign or open copy
            editor must survive a look at Results or Segments. */}
        <div hidden={tab !== 'campaigns'}>
          <MarketingView initialCampaignId={campaignId} refreshKey={segmentsVersion} />
        </div>
        {tab === 'results' && <CampaignResults onOpenCampaign={(id) => go('campaigns', id)} />}
        {tab === 'segments' && (
          <SegmentsPanel jobTypes={jobTypes} onChanged={() => setSegmentsVersion((version) => version + 1)} />
        )}
        {tab === 'newsletters' && <NewsletterSchedules />}
      </div>
    </div>
  )
}
