import { type BookingDetailRecord, type OutboxRecord, type ReconciliationRecord, buildBookingTimeline } from './timeline'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')

function record(overrides: Partial<BookingDetailRecord> = {}): BookingDetailRecord {
  return {
    id: 'b1',
    status: 'pending',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    expires_at: '2026-10-30T00:00:00.000Z',
    consumed_at: null,
    stripe_session_id: null,
    calendly_event_uri: null,
    calendly_invitee_uri: null,
    calendly_superseded_invitees: [],
    scheduled_at: null,
    cancelled_at: null,
    list_amount_cents: 50_000,
    charged_amount_cents: null,
    currency: 'AUD',
    contact: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    campaign: { id: 'k1', name: 'Spring offer' },
    ...overrides,
  }
}

function outbox(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: 'n1',
    kind: 'booking_paid_confirmation',
    status: 'sent',
    attempts: 1,
    last_error: null,
    created_at: '2026-10-02T00:00:00.000Z',
    sent_at: '2026-10-02T00:01:00.000Z',
    ...overrides,
  }
}

const titles = (entries: { title: string }[]) => entries.map((entry) => entry.title)

describe('buildBookingTimeline', () => {
  it('shows a fresh link with its campaign', () => {
    const [created, ...rest] = buildBookingTimeline(record(), [], [], NOW)
    expect(created).toMatchObject({ title: 'Booking link sent', detail: 'Campaign: Spring offer', at: '2026-10-01T00:00:00.000Z' })
    expect(rest).toEqual([])
  })

  it('walks a booking through checkout, the $0 claim, the email and the appointment', () => {
    const entries = buildBookingTimeline(
      record({
        status: 'booked',
        consumed_at: '2026-10-01T05:00:00.000Z',
        charged_amount_cents: 0,
        scheduled_at: '2026-10-20T01:00:00.000Z',
      }),
      [outbox()],
      [],
      NOW
    )

    expect(titles(entries)).toEqual([
      'Booking link sent',
      'Checkout opened',
      'Free offer claimed — $0 charged',
      'Confirmation email sent',
      'Consultation scheduled',
    ])
    expect(entries[2]).toMatchObject({ at: '2026-10-02T00:00:00.000Z', detail: 'List price $500' })
    expect(entries[4].at).toBeNull()
  })

  it('records reschedules and cancellations', () => {
    const entries = buildBookingTimeline(
      record({
        status: 'cancelled',
        charged_amount_cents: 0,
        scheduled_at: '2026-10-20T01:00:00.000Z',
        cancelled_at: '2026-10-15T00:00:00.000Z',
        calendly_superseded_invitees: ['old-1', 'old-2'],
      }),
      [],
      [],
      NOW
    )
    expect(titles(entries)).toContain('Consultation rescheduled')
    expect(entries.find((entry) => entry.key === 'scheduled')?.detail).toMatch(/moved 2 times/)
    // No email row: the claim is shown, but its moment is not recorded.
    expect(entries.find((entry) => entry.key === 'claimed')?.at).toBeNull()
    expect(entries.at(-1)).toMatchObject({ title: 'Consultation cancelled', tone: 'danger' })
  })

  it('says a single reschedule in the singular', () => {
    const entries = buildBookingTimeline(
      record({ status: 'booked', scheduled_at: '2026-10-20T01:00:00.000Z', calendly_superseded_invitees: ['old'] }),
      [],
      [],
      NOW
    )
    expect(entries.find((entry) => entry.key === 'scheduled')?.detail).toMatch(/moved 1 time$/)
  })

  it.each([
    [{ status: 'failed' as const, last_error: 'Mailbox full', sent_at: null }, 'Confirmation email failed', 'Mailbox full'],
    [{ status: 'failed' as const, last_error: null, sent_at: null, attempts: 5 }, 'Confirmation email failed', 'Gave up after 5 attempts.'],
    [{ status: 'skipped' as const, last_error: 'unsupported', sent_at: null }, 'Confirmation email not sent', 'unsupported'],
    [{ status: 'pending' as const, attempts: 0, sent_at: null }, 'Confirmation email queued', undefined],
    [{ status: 'processing' as const, attempts: 2, last_error: 'timeout', sent_at: null }, 'Confirmation email retrying', 'timeout'],
    [{ status: 'skipped' as const, last_error: null, sent_at: null }, 'Confirmation email not sent', undefined],
  ])('describes the email outcome %#', (overrides, title, detail) => {
    const entries = buildBookingTimeline(record(), [outbox(overrides)], [], NOW)
    expect(entries[1]).toMatchObject({ title, detail })
  })

  it('shows unmatched and later-matched Calendly updates', () => {
    const rows: ReconciliationRecord[] = [
      { id: 'r1', event_type: 'invitee.created', reason: 'no booking matched', scheduled_at: '2026-10-20T01:00:00.000Z', created_at: '2026-10-03T00:00:00.000Z', resolved_at: null, resolution: null },
      { id: 'r2', event_type: 'invitee.canceled', reason: 'x', scheduled_at: null, created_at: '2026-10-04T00:00:00.000Z', resolved_at: '2026-10-05T00:00:00.000Z', resolution: 'applied' },
    ]
    const entries = buildBookingTimeline(record(), [], rows, NOW)
    expect(entries[1]).toMatchObject({ title: 'Calendly update not matched', tone: 'warning' })
    expect(entries[1].detail).toMatch(/^invitee\.created · for .* · no booking matched$/)
    expect(entries[2]).toMatchObject({ title: 'Calendly update matched later', detail: 'invitee.canceled · applied', tone: 'neutral' })
  })

  it('marks a link that expired, by status or by date', () => {
    expect(buildBookingTimeline(record({ status: 'expired' }), [], [], NOW).at(-1)?.title).toBe('Booking link expired')
    expect(buildBookingTimeline(record({ expires_at: '2026-10-05T00:00:00.000Z' }), [], [], NOW).at(-1)?.title).toBe('Booking link expired')
  })

  it('omits the campaign line when the campaign is gone and keeps unparseable times as given', () => {
    const entries = buildBookingTimeline(
      record({ campaign: null, status: 'booked', scheduled_at: 'not a date' }),
      [],
      [],
      NOW
    )
    expect(entries[0].detail).toBeUndefined()
    expect(entries.find((entry) => entry.key === 'scheduled')?.detail).toBe('For not a date')
  })
})
