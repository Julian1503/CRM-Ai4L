import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('shows the brief, jobs, one channel and variant at a time, media and history', async () => {
    const mock = routeFetch(baseHandlers())
    const onBack = jest.fn()
    render(<ItemDetail itemId="item-1" onBack={onBack} />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(await screen.findByRole('heading', { name: 'Spring workshop' })).toBeInTheDocument()
    expect(screen.getByText('Owners')).toBeInTheDocument()
    expect(screen.getByText('A · B')).toBeInTheDocument()
    expect(screen.getByText('Provider error')).toBeInTheDocument()

    // Channels are a selector; the first live one is active. Archived variants never show.
    const channels = screen.getByRole('group', { name: 'Content channel' })
    expect(within(channels).getByRole('button', { name: /Facebook/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(channels).getByRole('button', { name: /Email/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('variant-var-1')).toBeInTheDocument()
    expect(screen.queryByTestId('variant-var-2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('variant-var-3')).not.toBeInTheDocument()

    // Media is the default detail panel; history is one click away.
    expect(await screen.findByTestId('asset-asset-1')).toBeInTheDocument()
    expect(mock.mock.calls.some(([url]) => url === '/api/content-studio/assets?itemId=item-1&pageSize=100')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Publication history' }))
    expect(await screen.findByTestId('publication-pub-1')).toBeInTheDocument()
    expect(screen.queryByTestId('asset-asset-1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Media' }))
    expect(await screen.findByTestId('asset-asset-1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '← All content' }))
    expect(onBack).toHaveBeenCalled()
  })

  it('switches channel and variant, recording them in the URL', async () => {
    routeFetch(baseHandlers())
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} />)
    await screen.findByTestId('variant-var-1')

    fireEvent.click(within(screen.getByRole('group', { name: 'Content channel' })).getByRole('button', { name: /Email/ }))

    expect(screen.getByTestId('variant-var-2')).toBeInTheDocument()
    expect(new URL(window.location.href).searchParams.get('channel')).toBe('email')
    expect(new URL(window.location.href).searchParams.get('variant')).toBeNull()

  })

  it('switches between variants of one channel', async () => {
    const item = makeItem({
      variants: [
        makeVariant({ id: 'var-1', style: 'direct', createdAt: '2026-01-01' }),
        makeVariant({ id: 'var-4', style: 'question', createdAt: '2026-01-02', current: makeRevision({ id: 'rev-4', variantId: 'var-4' }) }),
      ],
    })
    routeFetch(baseHandlers(item))
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} />)
    await screen.findByTestId('variant-var-1')

    const nav = screen.getByRole('navigation', { name: 'Facebook variants' })
    fireEvent.click(within(nav).getByRole('button', { name: /question/ }))

    expect(screen.getByTestId('variant-var-4')).toBeInTheDocument()
    expect(new URL(window.location.href).searchParams.get('variant')).toBe('var-4')
    expect(within(nav).getByRole('button', { name: /question/ })).toHaveAttribute('aria-current', 'true')
  })

  it('opens the channel and variant named in the URL', async () => {
    window.history.replaceState(null, '', '/?item=item-1&channel=email&variant=var-2')
    routeFetch(baseHandlers())
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} />)
    expect(await screen.findByTestId('variant-var-2')).toBeInTheDocument()
  })

  it('opens on the first pending variant when reached from the review queue', async () => {
    routeFetch(baseHandlers())
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} reviewFocus />)
    // var-1 (Facebook) is approved; var-2 (Email) is the one waiting.
    expect(await screen.findByTestId('variant-var-2')).toBeInTheDocument()
  })

  it('lets the guard decide before switching variants', async () => {
    routeFetch(baseHandlers())
    let pending: (() => void) | null = null
    const guardLeave = jest.fn((proceed: () => void) => {
      pending = proceed
    })
    render(<ItemDetail itemId="item-1" onBack={jest.fn()} guardLeave={guardLeave} />)
    await screen.findByTestId('variant-var-1')

    const channels = () => within(screen.getByRole('group', { name: 'Content channel' }))
    fireEvent.click(channels().getByRole('button', { name: /Email/ }))
    // Held: the operator has not answered yet.
    expect(guardLeave).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('variant-var-1')).toBeInTheDocument()

    act(() => pending?.())
    expect(screen.getByTestId('variant-var-2')).toBeInTheDocument()

    // Re-selecting the active channel is not a leave.
    fireEvent.click(channels().getByRole('button', { name: /Email/ }))
    expect(guardLeave).toHaveBeenCalledTimes(1)
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
