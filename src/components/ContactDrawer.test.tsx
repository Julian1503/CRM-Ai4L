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

  describe('address autocomplete', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.runOnlyPendingTimers()
      jest.useRealTimers()
    })

    function type(value: string) {
      fireEvent.change(screen.getByLabelText('Address'), { target: { value } })
    }

    it('does not query on a fragment too short to mean anything', () => {
      setup()
      ;(global.fetch as jest.Mock).mockClear()

      type('12')
      jest.advanceTimersByTime(1000)

      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('debounces, so a burst of typing makes one request', async () => {
      setup()
      ;(global.fetch as jest.Mock).mockClear()

      type('12 Colli')
      type('12 Collin')
      type('12 Collins')
      jest.advanceTimersByTime(400)

      await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
      expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
        'q=12+Collins'
      )
    })

    it('scopes the lookup to the contact country', async () => {
      setup()
      ;(global.fetch as jest.Mock).mockClear()

      type('12 Collins')
      jest.advanceTimersByTime(400)

      await waitFor(() => expect(global.fetch).toHaveBeenCalled())
      expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
        'country=Australia'
      )
    })

    it('offers what came back, and fills the address parts on choosing one', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          suggestions: [
            {
              display_name: '12 Collins St, Melbourne VIC 3000',
              address: {
                road: '12 Collins St',
                suburb: 'Melbourne',
                state: 'VIC',
                postcode: '3000',
                country: 'Australia',
              },
            },
          ],
        }),
      }) as unknown as typeof fetch

      setup()
      type('12 Collins')
      jest.advanceTimersByTime(400)

      const option = await screen.findByText('12 Collins St, Melbourne VIC 3000')
      fireEvent.click(option)

      expect(screen.getByLabelText('Address')).toHaveValue('12 Collins St')
      expect(screen.getByLabelText('Suburb')).toHaveValue('Melbourne')
      expect(screen.getByLabelText('Postcode')).toHaveValue('3000')
    })

    it('says the lookup is unavailable rather than failing silently', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {})
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Geoapify quota exceeded' }),
      }) as unknown as typeof fetch

      setup()
      type('12 Collins')
      jest.advanceTimersByTime(400)

      expect(await screen.findByText('Location lookup unavailable')).toBeInTheDocument()
    })

    it('clears suggestions when the field is emptied back below the threshold', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          suggestions: [
            { display_name: '12 Collins St', address: { road: '12 Collins St' } },
          ],
        }),
      }) as unknown as typeof fetch

      setup()
      type('12 Collins')
      jest.advanceTimersByTime(400)
      await screen.findByText('12 Collins St')

      type('12')

      await waitFor(() => expect(screen.queryByText('12 Collins St')).toBeNull())
    })
  })

  describe('services', () => {
    it('exposes each service as a named checkbox, not an unlabelled div', () => {
      // Every service used to share one element id inside a div with an onClick:
      // unreachable by keyboard and silent to a screen reader.
      setup()

      expect(screen.getByRole('checkbox', { name: 'Consulting' })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: 'Training' })).not.toBeChecked()
    })

    it('groups the services under a name', () => {
      setup()

      expect(screen.getByRole('group', { name: 'Services Bought' })).toBeInTheDocument()
    })

    it('adds a service that was not bought', () => {
      setup()

      fireEvent.click(screen.getByRole('checkbox', { name: 'Training' }))

      expect(screen.getByRole('checkbox', { name: 'Training' })).toBeChecked()
    })

    it('removes one that was', () => {
      setup()

      fireEvent.click(screen.getByRole('checkbox', { name: 'Consulting' }))

      expect(screen.getByRole('checkbox', { name: 'Consulting' })).not.toBeChecked()
    })

    it('sends the updated selection on save', async () => {
      const { onSave } = setup()

      fireEvent.click(screen.getByRole('checkbox', { name: 'Training' }))
      fireEvent.click(screen.getByText('Save Contact'))

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave.mock.calls[0][0].servicesBought).toEqual(['svc-1', 'svc-2'])
    })

    it('hides the services group entirely for a prospect', () => {
      setup({ contact: { ...contact, isCustomer: false } })

      expect(screen.queryByRole('group', { name: 'Services Bought' })).toBeNull()
    })
  })

  describe('status toggles', () => {
    it('names both status checkboxes', () => {
      setup()

      expect(
        screen.getByRole('checkbox', { name: /Is Customer/i })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('checkbox', { name: /Subscribed to Newsletter/i })
      ).toBeInTheDocument()
    })

    it('turns a customer back into a prospect', async () => {
      const { onSave } = setup()

      fireEvent.click(screen.getByRole('checkbox', { name: /Is Customer/i }))
      fireEvent.click(screen.getByText('Save Contact'))

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave.mock.calls[0][0].isCustomer).toBe(false)
    })

    it('subscribes a contact to the newsletter', async () => {
      const { onSave } = setup()

      fireEvent.click(screen.getByRole('checkbox', { name: /Subscribed to Newsletter/i }))
      fireEvent.click(screen.getByText('Save Contact'))

      await waitFor(() => expect(onSave).toHaveBeenCalled())
      expect(onSave.mock.calls[0][0].subscribedToNewsletter).toBe(true)
    })
  })
})
