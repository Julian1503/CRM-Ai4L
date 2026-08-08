import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import ContactDrawer from './ContactDrawer'
import type { TableContact } from './ContactTable'

const contact: TableContact = {
  id: 'c1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  preferredName: '',
  email: 'ada@example.com',
  mobileNumber: '',
  workPhone: '',
  address: '',
  suburb: '',
  state: 'NSW',
  postcode: '',
  country: 'Australia',
  department: '',
  position: 'Analyst',
  notes: '',
  isCustomer: true,
  subscribedToNewsletter: false,
  organisation: { name: 'Analytical Engines' },
  servicesBought: ['svc-1'],
}

const services = [
  { id: 'svc-1', name: 'Consulting' },
  { id: 'svc-2', name: 'Training' },
]

function setup(overrides: Partial<Parameters<typeof ContactDrawer>[0]> = {}) {
  const onSave = jest.fn().mockResolvedValue(undefined)
  const onClose = jest.fn()
  const onDelete = jest.fn().mockResolvedValue(undefined)

  render(
    <ContactDrawer
      contact={contact}
      onClose={onClose}
      onSave={onSave}
      onDelete={onDelete}
      availableServices={services}
      {...overrides}
    />
  )

  return { onSave, onClose, onDelete }
}

describe('ContactDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    }) as unknown as typeof fetch
  })

  describe('accessibility', () => {
    it('labels every field so assistive technology can announce it', () => {
      // Labels were previously siblings with no htmlFor, leaving every input
      // unnamed for screen readers (WCAG 1.3.1 / 3.3.2).
      setup()

      for (const label of [
        'First Name',
        'Last Name',
        'Email Address',
        'Organisation Name',
        'Position / Title',
        'Suburb',
        'Postcode',
      ]) {
        expect(screen.getByLabelText(label)).toBeInTheDocument()
      }
    })

    it('exposes the field values through their labels', () => {
      setup()

      expect(screen.getByLabelText('First Name')).toHaveValue('Ada')
      expect(screen.getByLabelText('Email Address')).toHaveValue('ada@example.com')
      expect(screen.getByLabelText('Organisation Name')).toHaveValue('Analytical Engines')
    })
  })

  describe('rendering', () => {
    it('renders nothing but the overlay without a contact', () => {
      setup({ contact: null })

      expect(screen.queryByLabelText('First Name')).not.toBeInTheDocument()
    })

    it('shows the services list for a customer', () => {
      setup()

      expect(screen.getByText('Consulting')).toBeInTheDocument()
      expect(screen.getByText('Training')).toBeInTheDocument()
    })
  })

  describe('validation', () => {
    it('blocks saving when a required field is emptied', async () => {
      const { onSave } = setup()

      fireEvent.change(screen.getByLabelText('First Name'), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => expect(screen.getByText(/First Name is required/i)).toBeInTheDocument())
      expect(onSave).not.toHaveBeenCalled()
    })

    it('rejects a malformed email', async () => {
      const { onSave } = setup()

      fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'nope' } })
      fireEvent.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => expect(screen.getByText(/Invalid Email/i)).toBeInTheDocument())
      expect(onSave).not.toHaveBeenCalled()
    })

    it('clears a field error once the field is edited', async () => {
      setup()

      fireEvent.change(screen.getByLabelText('First Name'), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: /save/i }))
      await waitFor(() => expect(screen.getByText(/First Name is required/i)).toBeInTheDocument())

      fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Ada' } })

      await waitFor(() =>
        expect(screen.queryByText(/First Name is required/i)).not.toBeInTheDocument()
      )
    })
  })

  describe('saving', () => {
    it('submits the edited contact and closes', async () => {
      const { onSave, onClose } = setup()

      fireEvent.change(screen.getByLabelText('Preferred Name'), { target: { value: 'Ada L' } })
      fireEvent.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ preferredName: 'Ada L' }))
      )
      await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('stays open when saving fails, so the edit is not lost', async () => {
      const onSave = jest.fn().mockRejectedValue(new Error('network'))
      const { onClose } = setup({ onSave })

      fireEvent.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  describe('archiving', () => {
    it('asks for confirmation before archiving', () => {
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false)
      const { onDelete } = setup()

      fireEvent.click(screen.getByRole('button', { name: /archive/i }))

      expect(confirmSpy).toHaveBeenCalled()
      expect(onDelete).not.toHaveBeenCalled()
      confirmSpy.mockRestore()
    })

    it('says the record can be restored, since it is not a delete', () => {
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false)
      setup()

      fireEvent.click(screen.getByRole('button', { name: /archive/i }))

      expect(confirmSpy.mock.calls[0][0]).toMatch(/restored later/i)
      confirmSpy.mockRestore()
    })

    it('archives when confirmed', async () => {
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)
      const { onDelete, onClose } = setup()

      fireEvent.click(screen.getByRole('button', { name: /archive/i }))

      await waitFor(() => expect(onDelete).toHaveBeenCalledWith('c1'))
      expect(onClose).toHaveBeenCalled()
      confirmSpy.mockRestore()
    })
  })

  it('closes on cancel without saving', () => {
    const { onClose, onSave } = setup()

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})
