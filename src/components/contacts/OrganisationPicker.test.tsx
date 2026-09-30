import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import IndustryFilter from './IndustryFilter'
import OrganisationPicker from './OrganisationPicker'
import { installFetchRouter } from './testing/mockFetch'

const ACME = { id: 'o-1', name: 'Acme Training', industry: 'Education' }
const BETA = { id: 'o-2', name: 'Beta Health', industry: null }

function setupPicker(value: typeof ACME | null = null, total = 2) {
  const router = installFetchRouter({
    'GET /api/organisations': (call) => {
      const q = (call.url.searchParams.get('q') ?? '').toLowerCase()
      const pageSize = Number(call.url.searchParams.get('pageSize'))
      const items = [ACME, BETA].filter((org) => org.name.toLowerCase().includes(q))
      return {
        body: { organisations: items, total, page: 1, pageSize, hasMore: total > items.length },
      }
    },
  })
  const onChange = jest.fn()
  render(<OrganisationPicker value={value} onChange={onChange} />)
  return { ...router, onChange, input: screen.getByRole('combobox', { name: 'Organisation' }) }
}

describe('OrganisationPicker', () => {
  it('searches organisations on the server', async () => {
    const { input, calls } = setupPicker()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'beta' } })

    expect(await screen.findByRole('option', { name: 'Beta Health' })).toBeInTheDocument()
    await waitFor(() => expect(calls[calls.length - 1].url.searchParams.get('q')).toBe('beta'))
  })

  it('shows the industry next to each option', async () => {
    const { input } = setupPicker()
    fireEvent.focus(input)

    expect(await screen.findByRole('option', { name: /Acme Training.*Education/ })).toBeInTheDocument()
  })

  it('selects with the keyboard', async () => {
    const { input, onChange } = setupPicker()
    fireEvent.focus(input)
    await screen.findByRole('option', { name: /Acme/ })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith(BETA)
  })

  it('shows the selected organisation and clears it', () => {
    const { input, onChange } = setupPicker(ACME)

    expect(input).toHaveValue('Acme Training')
    fireEvent.click(screen.getByRole('button', { name: 'Clear organisation filter Acme Training' }))

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('pages further on the server when more organisations match', async () => {
    const { input, calls } = setupPicker(null, 45)
    fireEvent.focus(input)

    fireEvent.click(await screen.findByRole('button', { name: /Show more \(43 not shown\)/ }))

    await waitFor(() => expect(calls[calls.length - 1].url.searchParams.get('pageSize')).toBe('40'))
  })

  it('closes on Escape', async () => {
    const { input } = setupPicker()
    fireEvent.focus(input)
    await screen.findByRole('listbox')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('reports a load failure in the list', async () => {
    installFetchRouter({
      'GET /api/organisations': () => ({ status: 500, body: { error: 'Could not load organisations.' } }),
    })
    render(<OrganisationPicker value={null} onChange={jest.fn()} />)
    fireEvent.focus(screen.getByRole('combobox', { name: 'Organisation' }))

    expect(await screen.findByText('Could not load organisations.')).toBeInTheDocument()
  })
})

describe('IndustryFilter', () => {
  it('lists industries from the facet endpoint', async () => {
    const { calls } = installFetchRouter({
      'GET /api/organisations': () => ({ body: { industries: ['Education', 'Health'] } }),
    })
    render(<IndustryFilter value="" onChange={jest.fn()} />)

    expect(await screen.findByRole('option', { name: 'Health' })).toBeInTheDocument()
    expect(calls[0].url.searchParams.get('facet')).toBe('industry')
  })

  it('keeps a selected value the facet no longer lists', async () => {
    installFetchRouter({ 'GET /api/organisations': () => ({ body: { industries: ['Health'] } }) })
    render(<IndustryFilter value="Mining" onChange={jest.fn()} />)

    await screen.findByRole('option', { name: 'Health' })
    expect(screen.getByLabelText('Industry')).toHaveValue('Mining')
  })

  it('says when industries cannot be loaded', async () => {
    installFetchRouter({ 'GET /api/organisations': () => ({ status: 500, body: { error: 'nope' } }) })
    render(<IndustryFilter value="" onChange={jest.fn()} />)

    expect(await screen.findByRole('option', { name: 'Industries unavailable' })).toBeInTheDocument()
  })

  it('refetches when the reload key changes', async () => {
    const { calls } = installFetchRouter({
      'GET /api/organisations': () => ({ body: { industries: [] } }),
    })
    const { rerender } = render(<IndustryFilter value="" onChange={jest.fn()} reloadKey={0} />)
    await waitFor(() => expect(calls).toHaveLength(1))

    rerender(<IndustryFilter value="" onChange={jest.fn()} reloadKey={1} />)

    await waitFor(() => expect(calls).toHaveLength(2))
  })
})
