import { fireEvent, render, screen } from '@testing-library/react'

import { AU_STATES } from '@/lib/contacts/states'

import FilterBar from './FilterBar'

function renderBar(overrides: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  const handlers = {
    onSearchChange: jest.fn(),
    onStatusChange: jest.fn(),
    onJobTypeChange: jest.fn(),
    onStateChange: jest.fn(),
  }

  render(
    <FilterBar
      searchQuery=""
      statusFilter="all"
      jobTypes={[
        { id: 'jt-1', name: 'Learning and Development' },
        { id: 'jt-2', name: 'Registered Training Organisation' },
      ]}
      jobTypeFilter=""
      stateFilter=""
      exportQuery=""
      resultCount={12}
      {...handlers}
      {...overrides}
    />
  )

  return handlers
}

describe('FilterBar', () => {
  describe('search', () => {
    it('labels the search input for assistive technology', () => {
      renderBar()

      expect(screen.getByLabelText('Search contacts')).toBeInTheDocument()
    })

    it('reports what was typed', () => {
      const { onSearchChange } = renderBar()

      fireEvent.change(screen.getByLabelText('Search contacts'), {
        target: { value: 'lovelace' },
      })

      expect(onSearchChange).toHaveBeenCalledWith('lovelace')
    })
  })

  describe('status tabs', () => {
    it.each(['all', 'lead', 'customer', 'prospect', 'subscribed'] as const)(
      'reports the "%s" tab',
      (status) => {
        const { onStatusChange } = renderBar()

        fireEvent.click(screen.getByTestId(`status-filter-${status}`))

        expect(onStatusChange).toHaveBeenCalledWith(status)
      }
    )

    it('marks only the active tab as pressed', () => {
      renderBar({ statusFilter: 'customer' })

      expect(screen.getByTestId('status-filter-customer')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(screen.getByTestId('status-filter-all')).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    })
  })

  describe('dropdowns', () => {
    it('offers every job type it was given, plus an "all" option', () => {
      renderBar()

      const select = screen.getByTestId('job-type-filter')
      expect(select).toHaveTextContent('All job types')
      expect(select).toHaveTextContent('Learning and Development')
    })

    it('reports a chosen job type', () => {
      const { onJobTypeChange } = renderBar()

      fireEvent.change(screen.getByTestId('job-type-filter'), { target: { value: 'jt-2' } })

      expect(onJobTypeChange).toHaveBeenCalledWith('jt-2')
    })

    it('offers every Australian state', () => {
      renderBar()

      const select = screen.getByTestId('state-filter')
      for (const state of AU_STATES) {
        expect(select).toHaveTextContent(state.code)
      }
    })

    it('reports a chosen state', () => {
      const { onStateChange } = renderBar()

      fireEvent.change(screen.getByTestId('state-filter'), { target: { value: 'VIC' } })

      expect(onStateChange).toHaveBeenCalledWith('VIC')
    })
  })

  describe('clearing', () => {
    it('offers nothing to clear when no filter is active', () => {
      renderBar()

      expect(screen.queryByText('Clear filters')).toBeNull()
    })

    it.each([
      ['searchQuery', { searchQuery: 'ada' }],
      ['statusFilter', { statusFilter: 'customer' as const }],
      ['jobTypeFilter', { jobTypeFilter: 'jt-1' }],
      ['stateFilter', { stateFilter: 'NSW' }],
    ])('offers to clear when %s is set', (_name, override) => {
      renderBar(override)

      expect(screen.getByText('Clear filters')).toBeInTheDocument()
    })

    it('resets every filter at once', () => {
      const handlers = renderBar({ searchQuery: 'ada', statusFilter: 'customer' })

      fireEvent.click(screen.getByText('Clear filters'))

      expect(handlers.onSearchChange).toHaveBeenCalledWith('')
      expect(handlers.onStatusChange).toHaveBeenCalledWith('all')
      expect(handlers.onJobTypeChange).toHaveBeenCalledWith('')
      expect(handlers.onStateChange).toHaveBeenCalledWith('')
    })
  })

  describe('export', () => {
    it('says how many contacts will be exported, so the size is known first', () => {
      renderBar({ resultCount: 3482 })

      expect(screen.getByText('Export 3482 contacts')).toBeInTheDocument()
    })

    it('uses the singular for one contact', () => {
      renderBar({ resultCount: 1 })

      expect(screen.getByText('Export 1 contact')).toBeInTheDocument()
    })

    it('carries the active filters into both export links', () => {
      // "Export what I am looking at" only holds if the query travels with the request.
      renderBar({ exportQuery: '&state=NSW&status=customer' })

      expect(screen.getByTestId('export-full')).toHaveAttribute(
        'href',
        '/api/contacts/export?format=full&state=NSW&status=customer'
      )
      expect(screen.getByTestId('export-emailoctopus')).toHaveAttribute(
        'href',
        '/api/contacts/export?format=emailoctopus&state=NSW&status=customer'
      )
    })
  })
})
