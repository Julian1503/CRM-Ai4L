import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import ItemDetail, { groupByChannel } from './ItemDetail'
import { bodyOf, errorResponse, jsonResponse, makeAccount, makeAsset, makeItem, makeJob, makePublication, makeRevision, makeVariant, routeFetch } from './testUtils'

const ITEM = '/api/content-studio/items/item-1'

const fullItem = makeItem({
  channels: ['facebook', 'email'],
  brief: { topic: 'Spring', audience: 'Owners', referenceUrl: 'https://ai4l.test', sourceFacts: ['A', 'B'] },
  jobs: [makeJob({ status: 'failed', errorMessage: 'Provider error' })],
  variants: [
    makeVariant({ current: makeRevision({ review: 'approved' }) }),
    makeVariant({ id: 'var-2', channel: 'email', style: 'story', current: makeRevision({ id: 'rev-e', variantId: 'var-2' }) }),
    makeVariant({ id: 'var-3', archivedAt: '2026-01-01' }),
  ],
})

function baseHandlers(item = fullItem) {
  return {
    [`GET ${ITEM}`]: jsonResponse({ item }),
    ['GET /api/content-studio/assets']: jsonResponse({ assets: [makeAsset()], total: 1 }),
    ['GET /api/social/publications']: jsonResponse({ publications: [makePublication()] }),
    ['GET /api/social/accounts']: jsonResponse({ accounts: [makeAccount()], enabledPlatforms: ['facebook'] }),
  }
}

describe('groupByChannel', () => {
  it('groups live variants in channel order', () => {
    const groups = groupByChannel(fullItem.variants)
    expect(groups.map((group) => [group.channel, group.variants.map((variant) => variant.id)])).toEqual([
      ['facebook', ['var-1']],
      ['email', ['var-2']],
    ])
  })
})

describe('ItemDetail', () => {
  it('shows the brief, jobs, variants by channel, images and publications', async () => {
    const mock = routeFetch(baseHandlers())
    const onBack = jest.fn()
    render(<ItemDetail itemId="item-1" onBack={onBack} />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(await screen.findByRole('heading', { name: 'Spring workshop' })).toBeInTheDocument()
    expect(screen.getByText('Owners')).toBeInTheDocument()
    expect(screen.getByText('A · B')).toBeInTheDocument()
    expect(screen.getByText('Provider error')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Facebook' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Email' })).toBeInTheDocument()
    expect(screen.queryByTestId('variant-var-3')).not.toBeInTheDocument()
    expect(await screen.findByTestId('asset-asset-1')).toBeInTheDocument()
    expect(await screen.findByTestId('publication-pub-1')).toBeInTheDocument()
    expect(mock.mock.calls.some(([url]) => url === '/api/content-studio/assets?itemId=item-1&pageSize=100')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '← All content' }))
    expect(onBack).toHaveBeenCalled()
  })

  it('archives and restores the item', async () => {
    const mock = routeFetch({ ...baseHandlers(), [`PATCH ${ITEM}`]: jsonResponse({ item: fullItem }) })
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive item' }))
    await waitFor(() => expect(bodyOf(mock, 'PATCH', ITEM)).toEqual({ archived: true }))
  })

  it('shows an archived item and reports a failed restore', async () => {
    routeFetch({ ...baseHandlers(makeItem({ archivedAt: '2026-01-01', variants: [] })), [`PATCH ${ITEM}`]: errorResponse(500, 'Locked') })
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} />)

    expect(await screen.findByText(/No variants yet/)).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore item' }))
    expect(await screen.findByText('Locked')).toBeInTheDocument()
  })

  it('reports a load failure and retries', async () => {
    const responses = [errorResponse(404, 'Item not found'), jsonResponse({ item: fullItem })]
    routeFetch({ ...baseHandlers(), [`GET ${ITEM}`]: () => responses.shift() ?? jsonResponse({ item: fullItem }) })
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} />)

    expect(await screen.findByText(/Item not found/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Spring workshop' })).toBeInTheDocument()
  })

  it('shows a refresh error while keeping the loaded item', async () => {
    const responses = [jsonResponse({ item: fullItem }), errorResponse(500, 'Refresh failed')]
    routeFetch({ ...baseHandlers(), [`GET ${ITEM}`]: () => responses.shift() ?? jsonResponse({ item: fullItem }), [`PATCH ${ITEM}`]: jsonResponse({ item: fullItem }) })
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive item' }))
    expect(await screen.findByText('Refresh failed')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Spring workshop' })).toBeInTheDocument()
  })

  it('opens the publish dialog for an approved variant and refreshes after publishing', async () => {
    const mock = routeFetch({
      ...baseHandlers(),
      ['POST /api/social/publications/preflight']: jsonResponse({
        preflight: { ok: true, platform: 'facebook', composedText: 'Text', limits: { maxChars: 100, maxHashtags: 5, maxImages: 4, requiresImage: false }, issues: [] },
      }),
      ['POST /api/social/publications']: jsonResponse({ publication: makePublication({ id: 'pub-9' }) }, 202),
    })
    const onOpenSettings = jest.fn()
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} onOpenSettings={onOpenSettings} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Publish…' }))
    const dialog = screen.getByRole('dialog', { name: 'Publish to Facebook' })
    const arm = await within(dialog).findByRole('button', { name: 'Publish to Facebook…' })
    await waitFor(() => expect(arm).toBeEnabled())
    fireEvent.click(arm)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, publish to AI4L Page' }))
    expect(await within(dialog).findByText('Published to Facebook.')).toBeInTheDocument()

    await waitFor(() => expect(mock.mock.calls.filter(([url]) => url === ITEM).length).toBeGreaterThanOrEqual(2))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
