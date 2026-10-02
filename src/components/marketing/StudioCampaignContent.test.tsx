import { render, screen } from '@testing-library/react'

import CampaignCopyEditor from './CampaignCopyEditor'
import MarketingView from './MarketingView'

const CONTENT = {
  snapshotId: 'snap-1',
  contract: { id: 'studio-static-v1', version: 1, label: 'Studio static Automation (fixed HTML)', delivery: 'static' },
  ctaMode: 'external_url',
  ctaUrl: 'https://ai4l.com.au/guide',
  subject: 'Term update',
  fields: {},
  assets: [{ assetId: 'a', publishedAssetId: 'p', url: 'https://x/p.jpg', checksum: 'c', alt: 'A classroom', order: 0 }],
  contentHash: 'abcdef0123456789abcdef',
  sourceRevisionId: 'rev-1',
  sourceRevisionNumber: 4,
  sourceItemId: 'item-1',
  renderedHtml: '<p>Reference</p>',
  renderedText: 'Reference',
  createdAt: '2026-10-01T00:00:00Z',
}

function respond(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

describe('a Content Studio campaign in Campaigns', () => {
  it('is shown read-only with its source and a link back to the Studio', async () => {
    global.fetch = jest.fn(async () => respond({ content: CONTENT })) as unknown as typeof fetch

    render(
      <CampaignCopyEditor campaignId="camp-1" campaignName="x" editable mergeFields={{}} snapshotId="snap-1" onSaved={jest.fn()} onError={jest.fn()} />
    )

    expect(await screen.findByTestId('studio-content-source')).toHaveTextContent('Content comes from Content Studio (revision 4)')
    expect(screen.getByRole('link', { name: 'Open it in the Content Studio' })).toHaveAttribute('href', '/?view=content&item=item-1')
    expect(screen.getByText('Term update')).toBeInTheDocument()
    expect(screen.getByText(/Button linking to https:\/\/ai4l\.com\.au\/guide/)).toBeInTheDocument()
    expect(screen.getByText('A classroom')).toBeInTheDocument()
    expect(screen.getByTestId('email-preview-frame').getAttribute('srcdoc')).toBe('<p>Reference</p>')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(global.fetch).toHaveBeenCalledWith('/api/campaigns/camp-1/content')
  })

  it('reports content that cannot be loaded', async () => {
    global.fetch = jest.fn(async () => respond({ error: 'The snapshot no longer exists.' }, false, 409)) as unknown as typeof fetch

    render(<CampaignCopyEditor campaignId="camp-1" campaignName="x" editable mergeFields={{}} snapshotId="snap-1" onSaved={jest.fn()} onError={jest.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('The snapshot no longer exists.')
  })

  it('opens the campaign named on arrival in MarketingView', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.startsWith('/api/campaigns/camp-2/content')) return respond({ content: { ...CONTENT, sourceItemId: null, ctaMode: 'none' } })
      if (url.startsWith('/api/campaigns?') || url === '/api/campaigns') {
        return respond({
          campaigns: [
            { id: 'camp-2', name: 'Studio email', status: 'draft', segment_id: null, provider_automation_id: 'auto-1', consent_stream: 'newsletter', merge_fields: {}, revision: 1, content_snapshot_id: 'snap-1' },
          ],
        })
      }
      return respond({})
    }) as unknown as typeof fetch

    render(<MarketingView jobTypes={[]} initialCampaignId="camp-2" />)

    expect(await screen.findByTestId('studio-content-camp-2')).toBeInTheDocument()
    expect(await screen.findByText('No button')).toBeInTheDocument()
  })
})
