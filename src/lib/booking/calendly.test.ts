/** @jest-environment node */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { applyCalendlyEvent, readCalendlyEvent, type CalendlyInviteeEvent } from './calendly'

const BOOKING = '11111111-1111-4111-8111-111111111111'

const PAYLOAD = {
  uri: ' https://api.calendly.com/invitees/new ',
  email: 'ada@example.test',
  rescheduled: false,
  old_invitee: 'https://api.calendly.com/invitees/old',
  scheduled_event: { uri: 'https://api.calendly.com/events/e1', start_time: '2026-10-10T01:00:00Z' },
  tracking: { utm_content: BOOKING },
}

describe('readCalendlyEvent', () => {
  it('reads the fields the booking rules need', () => {
    expect(readCalendlyEvent('invitee.created', PAYLOAD)).toEqual({
      event: 'invitee.created',
      inviteeUri: 'https://api.calendly.com/invitees/new',
      eventUri: 'https://api.calendly.com/events/e1',
      scheduledAt: '2026-10-10T01:00:00Z',
      email: 'ada@example.test',
      trackingBookingId: BOOKING,
      rescheduled: false,
      oldInviteeUri: 'https://api.calendly.com/invitees/old',
    })
  })

  it('marks a reschedule cancellation', () => {
    expect(readCalendlyEvent('invitee.canceled', { ...PAYLOAD, rescheduled: true })?.rescheduled).toBe(true)
    expect(readCalendlyEvent('invitee.canceled', { ...PAYLOAD, rescheduled: 'true' })?.rescheduled).toBe(false)
  })

  it('ignores a tracking value that is not a booking id: it travels through an editable URL', () => {
    expect(readCalendlyEvent('invitee.created', { ...PAYLOAD, tracking: { utm_content: 'drop table' } })?.trackingBookingId).toBeNull()
    expect(readCalendlyEvent('invitee.created', { uri: 'u' })).toMatchObject({
      trackingBookingId: null,
      eventUri: null,
      scheduledAt: null,
      email: null,
      oldInviteeUri: null,
    })
  })

  it('is unusable without an invitee uri', () => {
    expect(readCalendlyEvent('invitee.created', { ...PAYLOAD, uri: '  ' })).toBeNull()
    expect(readCalendlyEvent('invitee.created', undefined)).toBeNull()
  })
})

describe('applyCalendlyEvent', () => {
  const invitee = readCalendlyEvent('invitee.created', PAYLOAD) as CalendlyInviteeEvent

  function db(result: unknown) {
    const mock = createDbMock(createQueryBuilderMock())
    mock.rpc.mockResolvedValue(result)
    return mock
  }

  it('applies the event in one database call, completing the webhook claim with it', async () => {
    const mock = db({ data: 'applied', error: null })

    await expect(applyCalendlyEvent(mock as never, invitee, { provider: 'calendly', eventId: 'e1', token: 't1' })).resolves.toBe('applied')
    expect(mock.rpc).toHaveBeenCalledWith('apply_calendly_event', {
      p_event: 'invitee.created',
      p_invitee_uri: invitee.inviteeUri,
      p_event_uri: invitee.eventUri,
      p_scheduled_at: invitee.scheduledAt,
      p_email: invitee.email,
      p_tracking_booking: BOOKING,
      p_rescheduled: false,
      p_old_invitee_uri: invitee.oldInviteeUri,
      p_provider: 'calendly',
      p_event_id: 'e1',
      p_event_token: 't1',
    })
  })

  it('works without a webhook claim (the reconciliation retry)', async () => {
    const mock = db({ data: 'unmatched', error: null })
    await expect(applyCalendlyEvent(mock as never, invitee)).resolves.toBe('unmatched')
    expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_provider: null, p_event_id: null, p_event_token: null })
  })

  it('throws on a database error or a missing outcome', async () => {
    await expect(applyCalendlyEvent(db({ data: null, error: { message: 'down' } }) as never, invitee)).rejects.toThrow(
      'Could not apply the Calendly event: down'
    )
    await expect(applyCalendlyEvent(db({ data: null, error: null }) as never, invitee)).rejects.toThrow(/no outcome/)
  })
})
