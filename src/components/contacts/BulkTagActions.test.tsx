import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { MAX_SELECTED_IDS } from '@/lib/contacts/query'

import BulkTagActions, { describeBulkTagAction } from './BulkTagActions'
import { installFetchRouter, page } from './testing/mockFetch'

const VIP = { id: 't-1', name: 'VIP' }
const WORKSHOP = { id: 't-2', name: 'Workshop 2026' }

function ids(count: number) {
  return Array.from({ length: count }, (_, index) => `c-${index}`)
}

function setup(selectedIds: string[], routes = {}) {
  const router = installFetchRouter({
    'GET /api/tags': () => ({ body: page('tags', [VIP, WORKSHOP]) }),
    ...routes,
  })
  const onApplied = jest.fn()
  const view = render(<BulkTagActions selectedIds={selectedIds} onApplied={onApplied} />)
  return { ...router, onApplied, view }
}

async function open(count: number) {
  fireEvent.click(screen.getByRole('button', { name: `Tag ${count} selected` }))
}

async function pick(name: string) {
  const input = screen.getByTestId('bulk-tag-picker-input')
  fireEvent.focus(input)
  fireEvent.click(await screen.findByRole('option', { name }))
}

describe('describeBulkTagAction', () => {
  it('spells out tag and contact counts', () => {
    expect(describeBulkTagAction('add', 2, 37)).toBe('Add 2 tags to 37 contacts')
    expect(describeBulkTagAction('remove', 1, 1)).toBe('Remove 1 tag from 1 contact')
    expect(describeBulkTagAction('add', 1, 3, 'done')).toBe('Added 1 tag to 3 contacts')
  })
})

describe('BulkTagActions', () => {
  it('renders nothing without a selection', () => {
    setup([])

    expect(screen.queryByTestId('bulk-tag-actions')).not.toBeInTheDocument()
  })

  it('shows the exact count before applying, then posts the explicit ids', async () => {
    const { calls, onApplied } = setup(ids(37), {
      'POST /api/contacts/tags': () => ({ body: { updated: 37 } }),
    })
    await open(37)
    await pick('VIP')
    await pick('Workshop 2026')

    const apply = screen.getByTestId('bulk-tag-apply')
    expect(apply).toHaveTextContent('Add 2 tags to 37 contacts')

    fireEvent.click(apply)

    await waitFor(() =>
      expect(onApplied).toHaveBeenCalledWith({ operation: 'add', tagIds: ['t-1', 't-2'], updated: 37 })
    )
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      contactIds: ids(37),
      tagIds: ['t-1', 't-2'],
      operation: 'add',
    })
    expect(screen.getByRole('status')).toHaveTextContent('Added 2 tags to 37 contacts.')
  })

  it('removes tags when the remove operation is chosen', async () => {
    const { calls } = setup(ids(3), { 'POST /api/contacts/tags': () => ({ body: { updated: 2 } }) })
    await open(3)
    fireEvent.click(screen.getByRole('radio', { name: 'Remove tags' }))
    await pick('VIP')

    fireEvent.click(screen.getByRole('button', { name: 'Remove 1 tag from 3 contacts' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true))
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ operation: 'remove' })
  })

  it('cannot apply without tags', async () => {
    setup(ids(2))
    await open(2)

    expect(screen.getByTestId('bulk-tag-apply')).toBeDisabled()
  })

  it(`refuses more than ${MAX_SELECTED_IDS} contacts`, async () => {
    const { calls } = setup(ids(MAX_SELECTED_IDS + 1))
    await open(MAX_SELECTED_IDS + 1)
    await pick('VIP')

    expect(screen.getByRole('alert')).toHaveTextContent(`at most ${MAX_SELECTED_IDS}`)
    expect(screen.getByTestId('bulk-tag-apply')).toBeDisabled()
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('keeps the chosen tags and reports a stale selection', async () => {
    const { onApplied } = setup(ids(2), {
      'POST /api/contacts/tags': () => ({
        status: 409,
        body: { error: 'Some contacts are no longer available.' },
      }),
    })
    await open(2)
    await pick('VIP')

    fireEvent.click(screen.getByTestId('bulk-tag-apply'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no longer available.*Refresh the list/
    )
    expect(onApplied).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Remove tag VIP' })).toBeInTheDocument()
  })

  it('reports other failures', async () => {
    setup(ids(2), {
      'POST /api/contacts/tags': () => ({ status: 400, body: { error: 'Too many tags.' } }),
    })
    await open(2)
    await pick('VIP')

    fireEvent.click(screen.getByTestId('bulk-tag-apply'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tags.')
  })
})
