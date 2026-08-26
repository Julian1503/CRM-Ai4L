import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import Pagination from './Pagination'

const noop = () => {}

/** The props every summary test shares; each case supplies the numbers under test. */
const baseProps = { onPageChange: noop, label: 'contacts' } as const

describe('Pagination', () => {
  it('reports the current window and the full total', () => {
    render(<Pagination page={2} pageSize={50} total={3482} onPageChange={noop} label="contacts" />)

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(
      'Showing 51–100 of 3,482 contacts'
    )
    expect(screen.getByTestId('pagination-position')).toHaveTextContent('Page 2 of 70')
  })

  it('clamps the last window to the total rather than the page boundary', () => {
    render(<Pagination page={3} pageSize={50} total={120} onPageChange={noop} label="contacts" />)

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent('Showing 101–120 of 120')
  })

  it('never claims a wider window than the rows on screen', () => {
    // The summary used to be pure arithmetic: page x pageSize, clamped to the total.
    // While a filter was in flight the table showed skeleton rows under a line still
    // asserting "Showing 1-25 of 5,222", which reads as a broken table.
    render(<Pagination {...baseProps} page={1} pageSize={25} total={5222} shown={4} />)

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(
      'Showing 1–4 of 5,222 contacts'
    )
  })

  it('counts the shown window from the current page, not from the start', () => {
    render(<Pagination {...baseProps} page={3} pageSize={25} total={5222} shown={10} />)

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(
      'Showing 51–60 of 5,222 contacts'
    )
  })

  it('falls back to the page arithmetic when the caller does not count its rows', () => {
    render(<Pagination {...baseProps} page={1} pageSize={25} total={5222} />)

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(
      'Showing 1–25 of 5,222 contacts'
    )
  })

  it('says an empty page is empty rather than showing a backwards range', () => {
    render(<Pagination {...baseProps} page={4} pageSize={25} total={5222} shown={0} />)

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(
      'No contacts on this page'
    )
  })

  it('says it is loading rather than describing a window it is not showing', () => {
    render(<Pagination {...baseProps} page={1} pageSize={25} total={5222} isLoading />)

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent('Loading contacts')
    expect(screen.getByTestId('pagination-summary')).not.toHaveTextContent('5,222')
  })

  it('renders nothing when one page holds everything', () => {
    const { container } = render(
      <Pagination page={1} pageSize={50} total={12} onPageChange={noop} label="contacts" />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('still renders when a page-size selector is offered on a single page', () => {
    render(
      <Pagination
        page={1}
        pageSize={50}
        total={12}
        onPageChange={noop}
        onPageSizeChange={noop}
        label="contacts"
      />
    )

    expect(screen.getByTestId('pagination-size')).toBeInTheDocument()
    expect(screen.queryByTestId('pagination-next')).not.toBeInTheDocument()
  })

  it('disables previous on the first page and next on the last', () => {
    const { rerender } = render(
      <Pagination page={1} pageSize={50} total={120} onPageChange={noop} label="contacts" />
    )

    expect(screen.getByTestId('pagination-prev')).toBeDisabled()
    expect(screen.getByTestId('pagination-next')).toBeEnabled()

    rerender(<Pagination page={3} pageSize={50} total={120} onPageChange={noop} label="contacts" />)

    expect(screen.getByTestId('pagination-prev')).toBeEnabled()
    expect(screen.getByTestId('pagination-next')).toBeDisabled()
  })

  it('moves a page in each direction', () => {
    const onPageChange = jest.fn()
    render(
      <Pagination page={2} pageSize={50} total={300} onPageChange={onPageChange} label="contacts" />
    )

    fireEvent.click(screen.getByTestId('pagination-next'))
    expect(onPageChange).toHaveBeenCalledWith(3)

    fireEvent.click(screen.getByTestId('pagination-prev'))
    expect(onPageChange).toHaveBeenCalledWith(1)
  })

  it('reports a page size change as a number', () => {
    const onPageSizeChange = jest.fn()
    render(
      <Pagination
        page={1}
        pageSize={50}
        total={300}
        onPageChange={noop}
        onPageSizeChange={onPageSizeChange}
        label="contacts"
      />
    )

    fireEvent.change(screen.getByTestId('pagination-size'), { target: { value: '100' } })
    expect(onPageSizeChange).toHaveBeenCalledWith(100)
  })

  it('blocks navigation while a page is loading', () => {
    render(
      <Pagination page={2} pageSize={50} total={300} onPageChange={noop} label="contacts" isLoading />
    )

    expect(screen.getByTestId('pagination-prev')).toBeDisabled()
    expect(screen.getByTestId('pagination-next')).toBeDisabled()
  })

  it('says so plainly when there is nothing to page through', () => {
    render(
      <Pagination
        page={1}
        pageSize={50}
        total={0}
        onPageChange={noop}
        onPageSizeChange={noop}
        label="campaigns"
      />
    )

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent('No campaigns')
  })
})
