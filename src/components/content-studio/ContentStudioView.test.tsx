import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import ContentStudioView, { readItemParam } from './ContentStudioView'
import { jsonResponse, makeItem, makeJob, makeSummary, routeFetch } from './testUtils'

const handlers = {
  ['GET /api/content-studio/items']: jsonResponse({ items: [makeSummary()], total: 1, page: 1, pageSize: 25 }),
  ['GET /api/content-studio/items/item-1']: jsonResponse({ item: makeItem() }),
  ['GET /api/content-studio/assets']: jsonResponse({ assets: [], total: 0 }),
  ['GET /api/social/publications']: jsonResponse({ publications: [] }),
  ['GET /api/social/accounts']: jsonResponse({ accounts: [], enabledPlatforms: [] }),
}

function setSearch(search: string) {
  window.history.replaceState(null, '', `/${search}`)
}

describe('readItemParam', () => {
  it('accepts plausible ids only', () => {
    expect(readItemParam('?item=abc-123')).toBe('abc-123')
    expect(readItemParam('?item=%3Cscript%3E')).toBeNull()
    expect(readItemParam('?other=1')).toBeNull()
  })
})

describe('ContentStudioView', () => {
  afterEach(() => setSearch(''))

  it('starts on Create and switches sections with clicks and arrow keys', async () => {
    routeFetch(handlers)
    render(<ContentStudioView />)

    expect(screen.getByRole('tab', { name: 'Create' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'New content brief' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connections' })).toBeDisabled()

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }))
    expect(await screen.findByText('Content library')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Library' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Review' }))
    expect(await screen.findByText('Waiting for review')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Review' }), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Review' }), { key: 'ArrowRight' })
    expect(await screen.findByRole('heading', { name: 'Publications' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Publications' }), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Create' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Publications' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens an item from the library and goes back', async () => {
    routeFetch(handlers)
    render(<ContentStudioView />)

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }))
    fireEvent.click(await screen.findByText('Spring workshop'))
    expect(await screen.findByRole('heading', { name: 'Spring workshop' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '← All content' }))
    expect(await screen.findByText('Content library')).toBeInTheDocument()
  })

  it('keeps the review tab when opening from the queue', async () => {
    routeFetch(handlers)
    render(<ContentStudioView />)

    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    fireEvent.click(await screen.findByText('Spring workshop'))
    expect(await screen.findByRole('heading', { name: 'Spring workshop' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the item named in ?item= on mount', async () => {
    setSearch('?item=item-1')
    routeFetch(handlers)
    render(<ContentStudioView />)

    expect(await screen.findByRole('heading', { name: 'Spring workshop' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the new item after creating it', async () => {
    routeFetch({
      ...handlers,
      ['POST /api/content-studio/items']: jsonResponse({ item: makeItem() }, 201),
      ['POST /api/content-studio/items/item-1/generate']: jsonResponse({ job: makeJob() }, 202),
    })
    render(<ContentStudioView />)

    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Spring workshop' } })
    fireEvent.change(screen.getByLabelText(/^Topic/), { target: { value: 'Spring' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }))

    expect(await screen.findByRole('heading', { name: 'Spring workshop' })).toBeInTheDocument()
  })

  it('opens the email dialog from a variant and hands the new draft to Campaigns', async () => {
    setSearch('?item=item-1')
    routeFetch({
      ...handlers,
      ['GET /api/content-studio/variants/var-1/email-draft']: jsonResponse({
        proposal: {
          variantId: 'var-1',
          itemId: 'item-1',
          itemTitle: 'Spring workshop',
          revisionId: 'rev-1',
          adaptation: {
            subject: 'Spring workshop',
            fields: { Preheader: 'p', Headline: 'Spring workshop', Intro: 'i', Body: 'b', CtaLabel: '' },
            ctaUrl: null,
            ctaMode: 'none',
            notes: [],
          },
          assets: [],
        },
      }),
      ['GET /api/templates']: jsonResponse({ templates: [{ id: 'tpl-1', name: 'Static', contract_id: 'studio-static-v1', contract_version: 1, archived_at: null }] }),
      ['GET /api/segments']: jsonResponse({ segments: [] }),
      ['POST /api/content-studio/variants/var-1/email-draft']: jsonResponse({ campaignId: 'camp-1', created: true }, 201),
    })
    const onCreateEmail = jest.fn()
    const onOpenCampaign = jest.fn()
    render(<ContentStudioView onCreateEmail={onCreateEmail} onOpenCampaign={onOpenCampaign} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Create email' }))
    expect(onCreateEmail).toHaveBeenCalledWith('var-1', 'rev-1')
    expect(await screen.findByRole('dialog', { name: 'Create email' })).toBeInTheDocument()

    fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'tpl-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create draft campaign' }))

    await waitFor(() => expect(onOpenCampaign).toHaveBeenCalledWith('camp-1'))
    expect(screen.queryByRole('dialog', { name: 'Create email' })).not.toBeInTheDocument()
  })

  it('links to Settings for connections', () => {
    routeFetch(handlers)
    const onOpenSettings = jest.fn()
    render(<ContentStudioView onOpenSettings={onOpenSettings} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }))
    expect(onOpenSettings).toHaveBeenCalled()
  })
})
