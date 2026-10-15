import { act, render, screen } from '@testing-library/react'

import SchedulingStep, { CALENDLY_ORIGIN, SCHEDULED_EVENT, isScheduledMessage } from './SchedulingStep'

const HREF = 'https://calendly.com/ai4l/consult?utm_content=b1'

function post(data: unknown, origin = CALENDLY_ORIGIN, source: MessageEventSource | null = null) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
  })
}

describe('isScheduledMessage', () => {
  const frame = {} as Window

  it('accepts only Calendly’s scheduled event, from Calendly, from our frame', () => {
    const scheduled = { event: SCHEDULED_EVENT }
    expect(isScheduledMessage(new MessageEvent('message', { data: scheduled, origin: CALENDLY_ORIGIN }), null)).toBe(true)
    expect(isScheduledMessage(new MessageEvent('message', { data: scheduled, origin: 'https://evil.example' }), null)).toBe(false)
    expect(isScheduledMessage(new MessageEvent('message', { data: { event: 'calendly.page_height' }, origin: CALENDLY_ORIGIN }), null)).toBe(false)
    expect(isScheduledMessage(new MessageEvent('message', { data: 'calendly.event_scheduled', origin: CALENDLY_ORIGIN }), null)).toBe(false)
    expect(isScheduledMessage(new MessageEvent('message', { data: null, origin: CALENDLY_ORIGIN }), null)).toBe(false)
    // From Calendly's origin but another window: not our embed.
    expect(isScheduledMessage(new MessageEvent('message', { data: scheduled, origin: CALENDLY_ORIGIN, source: window }), frame)).toBe(false)
  })
})

describe('SchedulingStep', () => {
  it('shows the Calendly embed while a time is being chosen', () => {
    render(<SchedulingStep calendlyHref={HREF} email="ada@example.com" />)

    expect(screen.getByRole('heading', { name: 'Choose a time that suits you' })).toBeInTheDocument()
    expect(screen.getByTitle('Choose a consultation time')).toHaveAttribute('src', HREF)
    expect(screen.getByText('Choose a time').closest('li')).toHaveAttribute('aria-current', 'step')
  })

  it('confirms immediately when Calendly reports the booking, and moves focus to it', () => {
    render(<SchedulingStep calendlyHref={HREF} email="ada@example.com" />)
    const frame = screen.getByTitle('Choose a consultation time') as HTMLIFrameElement

    post({ event: SCHEDULED_EVENT, payload: { event: { uri: 'https://api.calendly.com/scheduled_events/e1' } } }, CALENDLY_ORIGIN, frame.contentWindow)

    const heading = screen.getByRole('heading', { name: "You're booked in" })
    expect(heading).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('calendar invitation to ada@example.com')
    expect(screen.queryByTitle('Choose a consultation time')).not.toBeInTheDocument()
    expect(screen.getByText('Choose a time').closest('li')).not.toHaveAttribute('aria-current')
  })

  it('ignores look-alike messages from other origins', () => {
    render(<SchedulingStep calendlyHref={HREF} email="ada@example.com" />)

    post({ event: SCHEDULED_EVENT }, 'https://calendly.com.evil.example')
    post({ event: 'calendly.date_and_time_selected' })

    expect(screen.getByTitle('Choose a consultation time')).toBeInTheDocument()
  })

  it('never tells the server: the webhook stays the source of truth', () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    render(<SchedulingStep calendlyHref={HREF} email="ada@example.com" />)
    const frame = screen.getByTitle('Choose a consultation time') as HTMLIFrameElement

    post({ event: SCHEDULED_EVENT }, CALENDLY_ORIGIN, frame.contentWindow)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('stops listening once gone', () => {
    const remove = jest.spyOn(window, 'removeEventListener')
    const { unmount } = render(<SchedulingStep calendlyHref={HREF} email="ada@example.com" />)
    unmount()
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function))
    remove.mockRestore()
  })
})
