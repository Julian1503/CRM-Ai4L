import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { installFetchRouter, page } from '@/components/contacts/testing/mockFetch'

import JobTypesSettings from './JobTypesSettings'

const LND = { id: 'jt-1', name: 'Learning and Development' }
const RTO = { id: 'jt-2', name: 'Registered Training Organisation' }

function setup(routes: Parameters<typeof installFetchRouter>[0] = {}) {
  const router = installFetchRouter({
    'GET /api/job-types': () => ({ body: page('jobTypes', [LND, RTO]) }),
    ...routes,
  })
  const onChanged = jest.fn()
  render(<JobTypesSettings onChanged={onChanged} />)
  return { ...router, onChanged }
}

describe('JobTypesSettings', () => {
  it('lists job types from the server', async () => {
    setup()

    expect(await screen.findByText('Learning and Development')).toBeInTheDocument()
    expect(screen.getByText('Registered Training Organisation')).toBeInTheDocument()
    expect(screen.getByText(/2 job types · page 1 of 1/)).toBeInTheDocument()
  })

  it('searches on the server and returns to the first page', async () => {
    const { calls } = setup()
    await screen.findByText('Learning and Development')

    fireEvent.change(screen.getByLabelText('Search job types'), { target: { value: 'RTO' } })

    await waitFor(() =>
      expect(calls.some((call) => call.url.searchParams.get('q') === 'RTO')).toBe(true)
    )
    const last = calls[calls.length - 1]
    expect(last.url.searchParams.get('page')).toBe('1')
  })

  it('pages through the catalogue', async () => {
    const { calls } = setup({
      'GET /api/job-types': (call) => ({
        body: {
          ...page('jobTypes', call.url.searchParams.get('page') === '2' ? [RTO] : [LND], 21),
          hasMore: call.url.searchParams.get('page') !== '2',
        },
      }),
    })
    await screen.findByText('Learning and Development')

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('Registered Training Organisation')).toBeInTheDocument()
    expect(calls[calls.length - 1].url.searchParams.get('page')).toBe('2')
  })

  it('creates a job type and reports the change', async () => {
    const created = { id: 'jt-3', name: 'Corporate' }
    const { calls, onChanged } = setup({
      'POST /api/job-types': () => ({ status: 201, body: { jobType: created } }),
    })
    await screen.findByText('Learning and Development')

    fireEvent.change(screen.getByLabelText('New job type'), { target: { value: '  Corporate ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add job type' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: 'created', jobType: created }))
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ name: 'Corporate' })
    expect(screen.getByRole('status')).toHaveTextContent('Added "Corporate".')
  })

  it('refuses an empty name without calling the server', async () => {
    const { calls } = setup()
    await screen.findByText('Learning and Development')

    fireEvent.click(screen.getByRole('button', { name: 'Add job type' }))

    expect(screen.getByRole('alert')).toHaveTextContent('A job type name is required.')
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('catches a duplicate already on screen, ignoring case', async () => {
    const { calls } = setup()
    await screen.findByText('Learning and Development')

    fireEvent.change(screen.getByLabelText('New job type'), {
      target: { value: 'learning AND development' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add job type' }))

    expect(screen.getByRole('alert')).toHaveTextContent(/already exists/)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('shows the server duplicate message readably', async () => {
    const { onChanged } = setup({
      'POST /api/job-types': () => ({
        status: 409,
        body: { error: 'A job type named "Corporate" already exists.' },
      }),
    })
    await screen.findByText('Learning and Development')

    fireEvent.change(screen.getByLabelText('New job type'), { target: { value: 'Corporate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add job type' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A job type named "Corporate" already exists.'
    )
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('renames inline, keeping the id', async () => {
    const renamed = { id: 'jt-2', name: 'RTO' }
    const { calls, onChanged } = setup({
      'PATCH /api/job-types/jt-2': () => ({ body: { jobType: renamed } }),
    })
    await screen.findByText('Registered Training Organisation')

    fireEvent.click(screen.getByRole('button', { name: 'Rename Registered Training Organisation' }))
    const input = screen.getByLabelText('New name for Registered Training Organisation')
    fireEvent.change(input, { target: { value: 'RTO' } })
    fireEvent.click(within(screen.getByTestId('job-type-row-jt-2')).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: 'renamed', jobType: renamed }))
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ name: 'RTO' })
  })

  it('shows a rename conflict and keeps the editor open', async () => {
    setup({
      'PATCH /api/job-types/jt-2': () => ({
        status: 409,
        body: { error: 'A job type named "Corporate" already exists.' },
      }),
    })
    await screen.findByText('Registered Training Organisation')

    fireEvent.click(screen.getByRole('button', { name: 'Rename Registered Training Organisation' }))
    fireEvent.change(screen.getByLabelText('New name for Registered Training Organisation'), {
      target: { value: 'Corporate' },
    })
    fireEvent.submit(screen.getByLabelText('New name for Registered Training Organisation'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/)
    expect(screen.getByLabelText('New name for Registered Training Organisation')).toBeInTheDocument()
  })

  it('cancels a rename with Escape', async () => {
    setup()
    await screen.findByText('Learning and Development')

    fireEvent.click(screen.getByRole('button', { name: 'Rename Learning and Development' }))
    fireEvent.keyDown(screen.getByLabelText('New name for Learning and Development'), { key: 'Escape' })

    expect(screen.queryByLabelText('New name for Learning and Development')).not.toBeInTheDocument()
  })

  it('shows a load failure with a retry', async () => {
    setup({ 'GET /api/job-types': () => ({ status: 500, body: { error: 'Could not load job types.' } }) })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load job types.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
