import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'

import type { ContentChannel } from '@/lib/content-studio/types'

import ChannelSelector from './ChannelSelector'
import { errorResponse, jsonResponse, makeAccount, routeFetch } from './testUtils'

const ACCOUNTS = '/api/social/accounts'

function Harness({ initial = [], error, disabled }: { initial?: ContentChannel[]; error?: string; disabled?: boolean }) {
  const [value, setValue] = useState<ContentChannel[]>(initial)
  return (
    <>
      <ChannelSelector value={value} onChange={setValue} error={error} disabled={disabled} />
      <output data-testid="value">{value.join(',')}</output>
    </>
  )
}

const tile = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) })

describe('ChannelSelector', () => {
  it('selects several channels and keeps them in the canonical order', async () => {
    routeFetch({ [`GET ${ACCOUNTS}`]: jsonResponse({ accounts: [], enabledPlatforms: [] }) })
    render(<Harness initial={['linkedin']} />)

    fireEvent.click(tile('Email'))
    fireEvent.click(tile('Facebook'))
    expect(screen.getByTestId('value')).toHaveTextContent('facebook,linkedin,email')

    fireEvent.click(tile('LinkedIn'))
    expect(screen.getByTestId('value')).toHaveTextContent('facebook,email')
    expect(tile('Facebook')).toBeChecked()
    expect(tile('LinkedIn')).not.toBeChecked()
    await screen.findAllByText('Publishing unavailable')
  })

  it('describes each channel’s publishing state without blocking generation', async () => {
    routeFetch({
      [`GET ${ACCOUNTS}`]: jsonResponse({
        accounts: [
          makeAccount({ platform: 'facebook', status: 'connected' }),
          makeAccount({ id: 'a2', platform: 'linkedin', status: 'needs_reauth' }),
        ],
        enabledPlatforms: ['facebook', 'instagram', 'linkedin'],
      }),
    })
    render(<Harness />)

    expect(screen.getAllByText('Checking connection…')).toHaveLength(3)
    expect(await screen.findByText('Connected for publishing')).toBeInTheDocument()
    expect(tile('Facebook')).toHaveAccessibleName(/Connected for publishing/)
    expect(tile('Instagram')).toHaveAccessibleName(/Connect before publishing/)
    expect(tile('LinkedIn')).toHaveAccessibleName(/Reconnect before publishing/)
    expect(tile('Email')).toHaveAccessibleName(/Create an email draft/)
    // Not being connected never disables a channel: generating does not need an account.
    expect(tile('Instagram')).toBeEnabled()
  })

  it('says the status is unknown when accounts cannot be read, rather than disconnected', async () => {
    routeFetch({ [`GET ${ACCOUNTS}`]: errorResponse(500, 'down') })
    render(<Harness />)
    expect(await screen.findAllByText('Connection status unavailable')).toHaveLength(3)
  })

  it('shows its error and can be disabled as a whole', () => {
    routeFetch({})
    render(<Harness error="Pick at least one channel." disabled />)

    const group = screen.getByRole('group', { name: 'Channels' })
    expect(group).toHaveAccessibleDescription('Pick at least one channel.')
    expect(group).toBeDisabled()
    for (const checkbox of within(group).getAllByRole('checkbox')) expect(checkbox).toBeDisabled()
  })
})
