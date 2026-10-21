import { fireEvent, render, screen } from '@testing-library/react'

import AudienceModal, { type Audience } from './AudienceModal'

const audience: Audience = {
  source: 'ledger',
  run: 2,
  segmentName: 'NSW leads',
  truncated: false,
  page: 1,
  pageSize: 25,
  total: 2,
  recipients: [
    {
      contactId: 'c1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      status: 'sent',
      error: null,
    },
    {
      contactId: 'c2',
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      status: 'failed',
      error: 'contact_id: This value should not be blank.',
    },
  ],
}

function renderModal(overrides: Partial<React.ComponentProps<typeof AudienceModal>> = {}) {
  const onClose = jest.fn()

  render(
    <AudienceModal
      campaignName="August offer"
      audience={audience}
      loading={false}
      error={null}
      page={1}
      pageSize={25}
      onPageChange={jest.fn()}
      onPageSizeChange={jest.fn()}
      onClose={onClose}
      {...overrides}
    />
  )

  return { onClose }
}

describe('AudienceModal', () => {
  it('names every recipient', async () => {
    renderModal()

    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.getByText('Lovelace')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('alan@example.com')).toBeInTheDocument()
  })

  it('says what happened to each of them', async () => {
    // The one place a per-recipient failure can be read: the send report gives a count,
    // and a count does not tell you whose address was wrong.
    renderModal()

    expect(screen.getByText('Sent')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(
      screen.getByText(/contact_id: This value should not be blank/)
    ).toBeInTheDocument()
  })

  it('distinguishes who was written to from who would be', async () => {
    renderModal()

    expect(screen.getByTestId('audience-modal')).toHaveTextContent('2 recipients · NSW leads · send 2')
  })

  it('says a segment audience is a projection, not a record', async () => {
    renderModal({
      audience: { ...audience, source: 'segment', run: 1, recipients: [] },
    })

    expect(screen.getByTestId('audience-modal')).toHaveTextContent('this is who matches now')
  })

  it('warns when the segment exceeds what one send can carry', async () => {
    renderModal({ audience: { ...audience, truncated: true } })

    expect(screen.getByText(/Only the first\s+10,000 would receive it/)).toBeInTheDocument()
  })

  it('is a dialog, and takes focus when it opens', async () => {
    renderModal()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('August offer')
    expect(screen.getByTestId('close-audience')).toHaveFocus()
  })

  it('closes on Escape and on the backdrop, but not on the dialog itself', async () => {
    const { onClose } = renderModal()

    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces a load failure inside the dialog', async () => {
    renderModal({ audience: null, error: 'Could not load the campaign audience.' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the campaign audience')
  })

  it('says an unpointed campaign has nobody rather than showing an empty table', async () => {
    renderModal({ audience: { ...audience, recipients: [], total: 0 } })

    expect(screen.getByText(/no audience yet/i)).toBeInTheDocument()
  })
})

describe('settling one uncertain recipient (audit B13)', () => {
  const withUncertain: Audience = {
    ...audience,
    recipients: [
      { contactId: 'c3', firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com', status: 'uncertain', sendId: 's3', error: 'timeout' },
    ],
  }

  it('labels the unknown outcome and asks again before queueing it', async () => {
    const onSettleUncertain = jest.fn(async () => undefined)
    renderModal({ audience: withUncertain, onSettleUncertain })

    expect(screen.getByText(/Unknown — check EmailOctopus/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Not received' }))
    expect(onSettleUncertain).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Queue again' }))
    expect(onSettleUncertain).toHaveBeenCalledWith('s3', 'retry')
  })

  it('offers no row actions without a handler', () => {
    renderModal({ audience: withUncertain })
    expect(screen.queryByRole('button', { name: 'Received' })).toBeNull()
  })
})
