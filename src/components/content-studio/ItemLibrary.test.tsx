import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import ItemLibrary from './ItemLibrary'
import { errorResponse, jsonResponse, makeSummary, routeFetch } from './testUtils'

const ITEMS = '/api/content-studio/items'

function page(items = [makeSummary()], total = items.length) {
  return jsonResponse({ items, total, page: 1, pageSize: 25 })
}

describe('ItemLibrary', () => {
  it('lists items with their channels and counts, and opens one', async () => {
    routeFetch({
      [`GET ${ITEMS}`]: page([makeSummary({ activeJobCount: 1, approvedCount: 2, archivedAt: null }), makeSummary({ id: 'item-2', title: 'Old post', variantCount: 1, pendingReviewCount: 0 })]),
    })
    const onOpen = jest.fn()
    render(<ItemLibrary onOpen={onOpen} />)

    expect(screen.getByLabelText('Loading content')).toBeInTheDocument()
    expect(await screen.findByText('Spring workshop')).toBeInTheDocument()
    expect(screen.getByText('Generating')).toBeInTheDocument()
    expect(screen.getByText('1 to review')).toBeInTheDocument()
    expect(screen.getByText('2 approved')).toBeInTheDocument()
    expect(screen.getByText(/1 variant$/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Old post'))
    expect(onOpen).toHaveBeenCalledWith('item-2')
  })

  it('searches and filters archived items', async () => {
    const mock = routeFetch({ [`GET ${ITEMS}`]: page([makeSummary({ archivedAt: '2026-09-01T00:00:00Z' })]) })
    render(<ItemLibrary onOpen={jest.fn()} />)
    await screen.findByText('Spring workshop')

    fireEvent.change(screen.getByLabelText('Search content'), { target: { value: ' spring ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(mock).toHaveBeenLastCalledWith(`${ITEMS}?search=spring&status=active&page=1&pageSize=25`, expect.anything()))

    fireEvent.click(screen.getByLabelText('Show archived'))
    await waitFor(() => expect(mock).toHaveBeenLastCalledWith(`${ITEMS}?search=spring&status=archived&page=1&pageSize=25`, expect.anything()))
    expect(await screen.findByText('Archived')).toBeInTheDocument()
  })

  it('explains each empty state', async () => {
    routeFetch({ [`GET ${ITEMS}`]: page([]) })
    const { unmount } = render(<ItemLibrary onOpen={jest.fn()} />)
    expect(await screen.findByText(/No content yet/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Show archived'))
    expect(await screen.findByText('No archived content.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search content'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Nothing matches “zzz”.')).toBeInTheDocument()
    unmount()
  })

  it('shows only items waiting for review in review mode', async () => {
    const mock = routeFetch({
      [`GET ${ITEMS}`]: page([makeSummary(), makeSummary({ id: 'item-2', title: 'Done post', pendingReviewCount: 0 })]),
    })
    render(<ItemLibrary onOpen={jest.fn()} reviewOnly />)

    expect(await screen.findByText('Waiting for review')).toBeInTheDocument()
    expect(await screen.findByText('Spring workshop')).toBeInTheDocument()
    expect(screen.queryByText('Done post')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Show archived')).not.toBeInTheDocument()
    expect(mock.mock.calls[0][0]).toContain('pageSize=100')
  })

  it('says when nothing waits for review', async () => {
    routeFetch({ [`GET ${ITEMS}`]: page([makeSummary({ pendingReviewCount: 0 })]) })
    render(<ItemLibrary onOpen={jest.fn()} reviewOnly />)
    expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument()
  })

  it('reports a load error and retries', async () => {
    const responses = [errorResponse(500, 'Database down'), page()]
    routeFetch({ [`GET ${ITEMS}`]: () => responses.shift() ?? page() })
    render(<ItemLibrary onOpen={jest.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Database down')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Spring workshop')).toBeInTheDocument()
  })
})
