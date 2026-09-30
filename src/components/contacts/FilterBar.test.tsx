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

describe('FilterBar tag, organisation and industry filters', () => {
  const VIP = { id: 't-1', name: 'VIP' }
  const ACME = { id: 'o-1', name: 'Acme Training', industry: 'Education' }

  beforeEach(() => {
    global.fetch = jest.fn(async (input: string) => {
      const url = new URL(input, 'https://crm.test')
      const body =
        url.pathname === '/api/tags'
          ? { tags: [VIP], total: 1, page: 1, pageSize: 20, hasMore: false }
          : url.searchParams.get('facet') === 'industry'
            ? { industries: ['Education', 'Health'] }
            : { organisations: [ACME], total: 1, page: 1, pageSize: 20, hasMore: false }
      return { ok: true, status: 200, json: async () => body }
    }) as unknown as typeof fetch
  })

  function renderWithCatalogFilters(overrides: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
    const handlers = {
      onTagFilterChange: jest.fn(),
      onOrganisationFilterChange: jest.fn(),
      onIndustryFilterChange: jest.fn(),
    }
    const base = renderBar({ ...handlers, ...overrides })
    return { ...base, ...handlers }
  }

  it('hides the new filters when the page does not handle them', () => {
    renderBar()

    expect(screen.queryByTestId('tag-filter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('organisation-filter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('industry-filter')).not.toBeInTheDocument()
  })

  it('reports a tag picked from the server catalogue, without offering to create one', async () => {
    const { onTagFilterChange } = renderWithCatalogFilters()

    const input = screen.getByRole('combobox', { name: 'Tags' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Brand new' } })
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(await screen.findByRole('option', { name: 'VIP' }))

    expect(onTagFilterChange).toHaveBeenCalledWith([VIP])
  })

  it('reports an organisation picked from the server', async () => {
    const { onOrganisationFilterChange } = renderWithCatalogFilters()

    fireEvent.focus(screen.getByRole('combobox', { name: 'Organisation' }))
    fireEvent.click(await screen.findByRole('option', { name: /Acme Training/ }))

    expect(onOrganisationFilterChange).toHaveBeenCalledWith(ACME)
  })

  it('offers industries from the facet endpoint', async () => {
    const { onIndustryFilterChange } = renderWithCatalogFilters()

    expect(await screen.findByRole('option', { name: 'Health' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Industry'), { target: { value: 'Health' } })

    expect(onIndustryFilterChange).toHaveBeenCalledWith('Health')
  })

  it.each([
    ['a tag', { tagFilter: [VIP] }],
    ['an organisation', { organisationFilter: ACME }],
    ['an industry', { industryFilter: 'Health' }],
  ])('counts %s as an active filter and clears it with the rest', (_label, active) => {
    const handlers = renderWithCatalogFilters(active)

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    expect(handlers.onSearchChange).toHaveBeenCalledWith('')
    if ('tagFilter' in active) expect(handlers.onTagFilterChange).toHaveBeenCalledWith([])
    if ('organisationFilter' in active) expect(handlers.onOrganisationFilterChange).toHaveBeenCalledWith(null)
    if ('industryFilter' in active) expect(handlers.onIndustryFilterChange).toHaveBeenCalledWith('')
  })

  it('leaves untouched filters alone when clearing', () => {
    const handlers = renderWithCatalogFilters({ industryFilter: 'Health' })

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    expect(handlers.onTagFilterChange).not.toHaveBeenCalled()
    expect(handlers.onOrganisationFilterChange).not.toHaveBeenCalled()
  })

  it('keeps export and selection behaviour unchanged with the new filters active', () => {
    renderWithCatalogFilters({
      tagFilter: [VIP],
      exportQuery: '&tagIds=t-1',
      selectedIds: ['c1', 'c2'],
    })

    expect(screen.getByTestId('export-selection-form')).toHaveAttribute(
      'action',
      '/api/contacts/export?tagIds=t-1'
    )
    expect(screen.getByText('Export 2 selected')).toBeInTheDocument()
  })
})
