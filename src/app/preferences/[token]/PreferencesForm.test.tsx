import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import PreferencesForm from './PreferencesForm'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function setup(props: Partial<React.ComponentProps<typeof PreferencesForm>> = {}) {
  render(
    <PreferencesForm
      token="v1.c1.sig"
      initial={{ newsletter: true, programs: true }}
      {...props}
    />
  )
}

/** The body of the nth POST the form made. */
function postedBody(call = 0) {
  return JSON.parse(mockFetch.mock.calls[call][1].body)
}

describe('PreferencesForm', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockResolvedValue(jsonResponse({ newsletter: true, programs: true }))
  })

  it('changes nothing on load', async () => {
    // The single most important behaviour here. Outlook Safe Links, Gmail's proxy and
    // corporate antivirus gateways fetch every URL in an email before a human sees it,
    // so a form that saved on mount would unsubscribe a share of the list on the first
    // send — and those withdrawals would look exactly like real ones.
    setup({ requested: 'all' })

    // Ticking through a render cycle: anything fired on mount would have gone by now.
    await waitFor(() => expect(screen.getByTestId('save-preferences')).toBeEnabled())
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('pre-selects the change a per-stream link asked for, without applying it', () => {
    setup({ requested: 'programs' })

    expect(screen.getByTestId('consent-newsletter')).toBeChecked()
    expect(screen.getByTestId('consent-programs')).not.toBeChecked()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('leaves the pre-selection editable — the link is a shortcut, not a decision', () => {
    setup({ requested: 'all' })

    expect(screen.getByTestId('consent-newsletter')).not.toBeChecked()

    fireEvent.click(screen.getByTestId('consent-newsletter'))

    expect(screen.getByTestId('consent-newsletter')).toBeChecked()
  })

  it('saves both consents as the reader left them', async () => {
    setup()

    fireEvent.click(screen.getByTestId('consent-newsletter'))
    fireEvent.click(screen.getByTestId('save-preferences'))

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(postedBody()).toEqual({ newsletter: false, programs: true })
  })

  it('withdraws everything in one press', async () => {
    setup()

    fireEvent.click(screen.getByTestId('unsubscribe-all'))

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(postedBody()).toEqual({ newsletter: false, programs: false })
  })

  it('says plainly when no email will follow', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ newsletter: false, programs: false }))
    setup()

    fireEvent.click(screen.getByTestId('unsubscribe-all'))

    expect(await screen.findByTestId('preferences-saved')).toHaveTextContent(
      /will not receive any more email/i
    )
  })

  it('shows what the server applied rather than what was asked for', async () => {
    // The two can differ: withdrawing the last consent archives the contact through a
    // database trigger, so the reader should be shown the state that is actually true.
    mockFetch.mockResolvedValue(jsonResponse({ newsletter: true, programs: false }))
    setup()

    fireEvent.click(screen.getByTestId('unsubscribe-all'))

    // Waited on the box that actually changes: newsletter is already ticked, so
    // asserting on it first would pass before the response had arrived.
    await waitFor(() => expect(screen.getByTestId('consent-programs')).not.toBeChecked())
    expect(screen.getByTestId('consent-newsletter')).toBeChecked()
  })

  it('reports a failure instead of claiming the change was saved', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Could not save your preferences.' }, false, 500))
    setup()

    fireEvent.click(screen.getByTestId('save-preferences'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not save/i)
    expect(screen.queryByTestId('preferences-saved')).not.toBeInTheDocument()
  })
})
