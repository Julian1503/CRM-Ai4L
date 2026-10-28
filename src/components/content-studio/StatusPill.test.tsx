import { render, screen } from '@testing-library/react'

import type { ContentChannel } from '@/lib/content-studio/types'

import { ChannelTag } from './StatusPill'

describe('ChannelTag', () => {
  it('names a supported channel', () => {
    render(<ChannelTag channel="instagram" />)

    expect(screen.getByText('Instagram')).toBeInTheDocument()
  })

  it('still names a retired channel stored before it was dropped', () => {
    // Archived items from before LinkedIn was dropped keep it in their channel list.
    render(<ChannelTag channel={'linkedin' as ContentChannel} />)

    expect(screen.getByText('linkedin (retired)')).toBeInTheDocument()
  })
})
