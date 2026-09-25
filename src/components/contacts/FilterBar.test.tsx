import { fireEvent, render, screen } from '@testing-library/react'

import { MAX_SELECTED_IDS } from '@/lib/contacts/query'
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
    it.each(['all', 'lead', 'customer', 'prospect', 'newsletter', 'programs'] as const)(
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

describe('FilterBar selection export', () => {
  it('keeps the filtered-view links when nothing is selected', () => {
    renderBar({ selectedIds: [] })

    expect(screen.getByTestId('export-full')).toBeInTheDocument()
    expect(screen.queryByTestId('export-selection-form')).not.toBeInTheDocument()
  })

  it('switches to a selection export once rows are ticked', () => {
    renderBar({ selectedIds: ['c1', 'c2'] })

    expect(screen.getByText('Export 2 selected')).toBeInTheDocument()
    expect(screen.queryByTestId('export-full')).not.toBeInTheDocument()
  })

  it('posts the selected ids in the body rather than the URL', () => {
    // A few hundred ids do not fit in a query string, so the request must not grow one.
    renderBar({ selectedIds: ['c1', 'c2'], exportQuery: '&state=NSW' })

    const form = screen.getByTestId('export-selection-form')

    expect(form).toHaveAttribute('method', 'post')
    expect(form).toHaveAttribute('action', '/api/contacts/export?state=NSW')
    expect(form.querySelector('input[name="ids"]')).toHaveValue('c1,c2')
  })

  it('offers both formats as submit buttons on the one form', () => {
    renderBar({ selectedIds: ['c1'] })

    expect(screen.getByTestId('export-selected-full')).toHaveAttribute('value', 'full')
    expect(screen.getByTestId('export-selected-emailoctopus')).toHaveAttribute(
      'value',
      'emailoctopus'
    )
  })

  it('blocks an over-long selection in place rather than letting the post fail', () => {
    const ids = Array.from({ length: MAX_SELECTED_IDS + 1 }, (_, i) => `id-${i}`)
    renderBar({ selectedIds: ids })

    expect(screen.getByTestId('export-selected-full')).toBeDisabled()
    expect(screen.getByText(new RegExp(`export at most ${MAX_SELECTED_IDS}`, 'i'))).toBeInTheDocument()
  })

  it('clears the selection without submitting the form', () => {
    const onClearSelection = jest.fn()
    renderBar({ selectedIds: ['c1'], onClearSelection })

    const clear = screen.getByTestId('clear-selection')
    expect(clear).toHaveAttribute('type', 'button')

    fireEvent.click(clear)
    expect(onClearSelection).toHaveBeenCalled()
  })
})
