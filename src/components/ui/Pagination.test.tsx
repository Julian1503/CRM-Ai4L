import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import Pagination from './Pagination'

const noop = () => {}

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
