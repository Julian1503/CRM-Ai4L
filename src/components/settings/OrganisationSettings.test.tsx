import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { installFetchRouter, type FetchCall } from '@/components/contacts/testing/mockFetch'

import OrganisationSettings from './OrganisationSettings'

const ACME = { id: 'o-1', name: 'Acme Training', industry: 'Education' }
const BETA = { id: 'o-2', name: 'Beta Health', industry: null }

function listResponse(call: FetchCall, organisations = [ACME, BETA]) {
  if (call.url.searchParams.get('facet') === 'industry') {
    return { body: { industries: ['Education', 'Health'] } }
  }

  return { body: { organisations, total: organisations.length, page: 1, pageSize: 20, hasMore: false } }
}

function setup(routes: Parameters<typeof installFetchRouter>[0] = {}) {
  const router = installFetchRouter({
    'GET /api/organisations': (call) => listResponse(call),
    ...routes,
  })
  const onChanged = jest.fn()
  render(<OrganisationSettings onChanged={onChanged} />)
  return { ...router, onChanged }
}

async function edit(name: string, value: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Edit industry of ${name}` }))
  fireEvent.change(screen.getByLabelText(`Industry of ${name}`), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

describe('OrganisationSettings', () => {
  it('lists organisations with their industry', async () => {
    setup()

    expect(await screen.findByText('Acme Training')).toBeInTheDocument()
    expect(screen.getByText('Education')).toBeInTheDocument()
    expect(screen.getByText('No industry set')).toBeInTheDocument()
  })

  it('searches on the server', async () => {
    const { calls } = setup()
    await screen.findByText('Acme Training')

    fireEvent.change(screen.getByLabelText('Search organisations'), { target: { value: 'beta' } })

    await waitFor(() => expect(calls.some((call) => call.url.searchParams.get('q') === 'beta')).toBe(true))
  })

  it('explains that the change applies to every contact of the organisation', async () => {
    setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit industry of Acme Training' }))

    expect(screen.getByLabelText('Industry of Acme Training')).toHaveAccessibleDescription(
      'This changes the industry for every contact at Acme Training.'
    )
  })

  it('saves with the value the edit started from', async () => {
    const saved = { ...ACME, industry: 'Health' }
    const { calls, onChanged } = setup({
      'PATCH /api/organisations/o-1': () => ({ body: { organisation: saved } }),
    })

    await edit('Acme Training', '  Health ')

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(saved))
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      industry: 'Health',
      expectedIndustry: 'Education',
    })
    expect(screen.getByRole('status')).toHaveTextContent('Acme Training is now in "Health".')
  })

  it('clears the industry when the field is emptied', async () => {
    const { calls } = setup({
      'PATCH /api/organisations/o-1': () => ({ body: { organisation: { ...ACME, industry: null } } }),
    })

    await edit('Acme Training', '   ')

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true))
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      industry: null,
      expectedIndustry: 'Education',
    })
  })

  it('does not send an unchanged value', async () => {
    const { calls } = setup()

    await edit('Acme Training', 'Education')

    expect(calls.some((call) => call.method === 'PATCH')).toBe(false)
  })

  it('shows a concurrent change clearly and reloads the list', async () => {
    let listCalls = 0
    const { onChanged } = setup({
      'GET /api/organisations': (call) => {
        if (call.url.searchParams.get('facet') !== 'industry') listCalls += 1
        return listResponse(call, listCalls > 1 ? [{ ...ACME, industry: 'Mining' }, BETA] : [ACME, BETA])
      },
      'PATCH /api/organisations/o-1': () => ({
        status: 409,
        body: { error: 'The industry of Acme Training was changed by someone else.' },
      }),
    })

    await edit('Acme Training', 'Health')

    expect(await screen.findByTestId('organisation-conflict')).toHaveTextContent(
      /changed by someone else.*reloaded/
    )
    expect(await screen.findByText('Mining')).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('keeps the editor open on other failures', async () => {
    setup({
      'PATCH /api/organisations/o-1': () => ({ status: 400, body: { error: 'Industry is too long.' } }),
    })

    await edit('Acme Training', 'Health')

    expect(await screen.findByRole('alert')).toHaveTextContent('Industry is too long.')
    expect(screen.getByLabelText('Industry of Acme Training')).toBeInTheDocument()
  })

  it('cancels with Escape', async () => {
    setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit industry of Acme Training' }))

    fireEvent.keyDown(screen.getByLabelText('Industry of Acme Training'), { key: 'Escape' })

    expect(screen.queryByLabelText('Industry of Acme Training')).not.toBeInTheDocument()
  })
})
