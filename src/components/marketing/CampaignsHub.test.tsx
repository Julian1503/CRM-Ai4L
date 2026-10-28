import { fireEvent, render, screen } from '@testing-library/react'

import { currentUrl, resetNavigation } from '@/test/navigationMock'

import CampaignsHub from './CampaignsHub'

jest.mock('next/navigation', () => jest.requireActual('@/test/navigationMock').navigationModule)

jest.mock('./MarketingView', () => ({
  __esModule: true,
  default: ({ initialCampaignId, refreshKey }: { initialCampaignId?: string; refreshKey?: number }) => (
    <div data-testid="marketing-view" data-refresh={refreshKey}>
      campaigns{initialCampaignId ? `:${initialCampaignId}` : ''}
    </div>
  ),
}))
jest.mock('./CampaignResults', () => ({
  __esModule: true,
  default: ({ onOpenCampaign }: { onOpenCampaign: (id: string) => void }) => (
    <button type="button" data-testid="results-view" onClick={() => onOpenCampaign('camp-7')}>
      results
    </button>
  ),
}))
jest.mock('./SegmentsPanel', () => ({
  __esModule: true,
  default: ({ onChanged }: { onChanged: () => void }) => (
    <button type="button" data-testid="segments-view" onClick={onChanged}>
      segments
    </button>
  ),
}))
jest.mock('./NewsletterSchedules', () => ({ __esModule: true, default: () => <div data-testid="newsletters-view" /> }))

describe('CampaignsHub', () => {
  it('tells the campaign form to re-read segments after one is saved', () => {
    resetNavigation('/campaigns?tab=segments')
    render(<CampaignsHub jobTypes={[]} />)
    expect(screen.getByTestId('marketing-view')).toHaveAttribute('data-refresh', '0')

    fireEvent.click(screen.getByTestId('segments-view'))

    expect(screen.getByTestId('marketing-view')).toHaveAttribute('data-refresh', '1')
  })

  it('opens on Campaigns, one tab per job', () => {
    resetNavigation('/campaigns')
    render(<CampaignsHub jobTypes={[]} />)

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Campaigns',
      'Results',
      'Segments',
      'Recurring newsletters',
    ])
    expect(screen.getByRole('tab', { name: 'Campaigns' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('marketing-view')).toBeInTheDocument()
    expect(screen.queryByTestId('segments-view')).not.toBeInTheDocument()
  })

  it('keeps the tab in the URL so a reload or a shared link lands on it', () => {
    resetNavigation('/campaigns')
    render(<CampaignsHub jobTypes={[]} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Segments' }))

    expect(currentUrl()).toBe('/campaigns?tab=segments')
    expect(screen.getByTestId('segments-view')).toBeInTheDocument()
    // Hidden, not unmounted: a half-written campaign survives a look at another tab.
    expect(screen.getByTestId('marketing-view')).not.toBeVisible()
  })

  it('starts on the tab the URL names, and ignores one it does not know', () => {
    resetNavigation('/campaigns?tab=newsletters')
    const { unmount } = render(<CampaignsHub jobTypes={[]} />)
    expect(screen.getByTestId('newsletters-view')).toBeInTheDocument()
    unmount()

    resetNavigation('/campaigns?tab=nonsense')
    render(<CampaignsHub jobTypes={[]} />)
    expect(screen.getByTestId('marketing-view')).toBeVisible()
  })

  it('opens a campaign from Results on the Campaigns tab, with its copy open', () => {
    resetNavigation('/campaigns?tab=results')
    render(<CampaignsHub jobTypes={[]} />)

    fireEvent.click(screen.getByTestId('results-view'))

    expect(currentUrl()).toBe('/campaigns?campaign=camp-7')
    expect(screen.getByTestId('marketing-view')).toHaveTextContent('campaigns:camp-7')
  })

  it('opens Campaigns for a review email link', () => {
    resetNavigation('/campaigns?campaign=camp-1')
    render(<CampaignsHub jobTypes={[]} />)

    expect(screen.getByTestId('marketing-view')).toHaveTextContent('campaigns:camp-1')
  })
})
