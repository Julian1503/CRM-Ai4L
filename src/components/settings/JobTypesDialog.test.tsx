import { fireEvent, render, screen } from '@testing-library/react'

import { installFetchRouter, page } from '@/components/contacts/testing/mockFetch'

import JobTypesDialog from './JobTypesDialog'

describe('JobTypesDialog', () => {
  beforeEach(() => {
    installFetchRouter({
      'GET /api/job-types': () => ({ body: page('jobTypes', [{ id: 'jt-1', name: 'Trainers' }]) }),
    })
  })

  it('shows the catalogue in a labelled modal', async () => {
    render(<JobTypesDialog onClose={jest.fn()} onChanged={jest.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Manage job types' })).toHaveAttribute('aria-modal', 'true')
    expect(await screen.findByText('Trainers')).toBeInTheDocument()
  })

  it('closes on Escape without letting the key reach the drawer underneath', () => {
    const onClose = jest.fn()
    const drawerListener = jest.fn()
    document.addEventListener('keydown', drawerListener)
    render(<JobTypesDialog onClose={onClose} onChanged={jest.fn()} />)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(drawerListener).not.toHaveBeenCalled()
    document.removeEventListener('keydown', drawerListener)
  })

  it('closes from the Done button and from the backdrop', () => {
    const onClose = jest.fn()
    render(<JobTypesDialog onClose={onClose} onChanged={jest.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByTestId('job-types-dialog').parentElement as HTMLElement)

    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
