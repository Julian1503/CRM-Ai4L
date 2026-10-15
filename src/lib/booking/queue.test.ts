/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

import { fetchBookingDetail, fetchBookingQueue, readSchedulingHealth, resolveFlaggedBookings, resolveSearchContacts } from './queue'
import { parseBookingFilters } from './query'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const B1 = '11111111-1111-4111-8111-111111111111'
const B2 = '22222222-2222-4222-8222-222222222222'
const B3 = '33333333-3333-4333-8333-333333333333'

type Responses = Record<string, unknown | unknown[]>

/**
 * A db whose builders are created per `.from(table)`, answering from `responses[table]`.
 * A list answers successive `.from(table)` calls in order, repeating its last entry.
 */
function dbFor(responses: Responses) {
  const built: { table: string; builder: QueryBuilderMock }[] = []
  const queues = new Map(Object.entries(responses).map(([table, value]) => [table, Array.isArray(value) ? [...value] : [value]]))
  const next = (table: string) => {
    const queue = queues.get(table)
    if (!queue) return { data: [], error: null, count: 0 }
    return queue.length > 1 ? queue.shift() : queue[0]
  }
  const db = createDbMock((table: string) => {
    const builder = createQueryBuilderMock(next(table))
    built.push({ table, builder })
    return builder
  })
  const of = (table: string) => built.filter((entry) => entry.table === table).map((entry) => entry.builder)
  return { db: db as never, of }
}

describe('resolveSearchContacts', () => {
  it('requires every word to match a name or the email, escaping LIKE characters', async () => {
    const { db, of } = dbFor({ contacts: { data: [{ id: 'c1' }], error: null } })

    await expect(resolveSearchContacts(db, '  Ada  Love%lace ')).resolves.toEqual(['c1'])

    const ors = of('contacts')[0].allFor('or').map((call) => call.args[0])
    expect(ors).toEqual([
      'first_name.ilike."%Ada%",last_name.ilike."%Ada%",email.ilike."%Ada%"',
      'first_name.ilike."%Love\\\\%lace%",last_name.ilike."%Love\\\\%lace%",email.ilike."%Love\\\\%lace%"',
    ])
  })

  it('reports a failed search', async () => {
    const { db } = dbFor({ contacts: { data: null, error: { message: 'boom' } } })
    await expect(resolveSearchContacts(db, 'x')).rejects.toThrow('Could not search contacts: boom')
  })
})

describe('resolveFlaggedBookings', () => {
  it('collects failed emails, parked events by tracking id, and parked events by email', async () => {
    const { db, of } = dbFor({
      notification_outbox: { data: [{ booking_id: B1 }], error: null },
      booking_reconciliation: {
        data: [
          { tracking_booking_id: B2, email: 'x@example.com' },
          { tracking_booking_id: null, email: 'ada@example.com' },
          { tracking_booking_id: null, email: null },
        ],
        error: null,
      },
      contacts: { data: [{ id: 'c1' }], error: null },
      bookings: { data: [{ id: B3 }], error: null },
    })

    const flagged = await resolveFlaggedBookings(db)

    expect([...flagged.emailFailed]).toEqual([B1])
    expect([...flagged.unmatchedCalendly].sort()).toEqual([B2, B3])
    expect(of('contacts')[0].argsFor('in')).toEqual(['email', ['ada@example.com']])
    expect(of('bookings')[0].allFor('in')).toContainEqual({ method: 'in', args: ['status', ['paid', 'booked']] })
  })

  it('skips the email lookups when nothing is parked by email, or no contact matches', async () => {
    const none = dbFor({ booking_reconciliation: { data: [{ tracking_booking_id: B2, email: 'x' }], error: null } })
    await resolveFlaggedBookings(none.db)
    expect(none.of('contacts')).toHaveLength(0)

    const noContact = dbFor({ booking_reconciliation: { data: [{ tracking_booking_id: null, email: 'x' }], error: null } })
    await resolveFlaggedBookings(noContact.db)
    expect(noContact.of('bookings')).toHaveLength(0)
  })

  it.each([
    ['notification_outbox', 'Could not read notifications'],
    ['booking_reconciliation', 'Could not read Calendly reconciliation'],
  ])('reports a failure reading %s', async (table, message) => {
    const { db } = dbFor({ [table]: { data: null, error: { message: 'denied' } } })
    await expect(resolveFlaggedBookings(db)).rejects.toThrow(message)
  })

  it.each([['contacts'], ['bookings']])('reports a failure matching emails through %s', async (table) => {
    const { db } = dbFor({
      booking_reconciliation: { data: [{ tracking_booking_id: null, email: 'ada@example.com' }], error: null },
      contacts: { data: [{ id: 'c1' }], error: null },
      [table]: { data: null, error: { message: 'denied' } },
    })
    await expect(resolveFlaggedBookings(db)).rejects.toThrow('Could not match Calendly emails')
  })
})

const ROW = {
  id: B1,
  status: 'paid',
  updated_at: '2026-10-10T00:00:00.000Z',
  consumed_at: '2026-10-09T00:00:00.000Z',
  contact: null,
  campaign: null,
}

describe('fetchBookingQueue', () => {
  it('filters the list to the queue, attaches reasons, and counts the queue', async () => {
    const { db, of } = dbFor({
      notification_outbox: { data: [{ booking_id: B1 }], error: null },
      bookings: { data: [ROW], error: null, count: 7 },
    })

    const page = await fetchBookingQueue(db, parseBookingFilters(new URLSearchParams('queue=needs_action')), NOW)

    expect(page.rows[0].reasons).toEqual(['stalled_claim', 'email_failed'])
    expect(page.total).toBe(7)
    expect(page.needsActionCount).toBe(7)
    const [list, count] = of('bookings')
    expect(String(list.argsFor('or')?.[0])).toContain(`id.in.(${B1})`)
    expect(count.argsFor('select')).toEqual(['id', { count: 'exact', head: true }])
  })

  it('applies search and the date range, and shows everything without the queue filter', async () => {
    const { db, of } = dbFor({ contacts: { data: [{ id: 'c1' }], error: null } })
    const filters = parseBookingFilters(new URLSearchParams('q=ada&dateField=scheduled&from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z'))

    await fetchBookingQueue(db, filters, NOW)

    const list = of('bookings')[0]
    expect(list.allFor('in')).toContainEqual({ method: 'in', args: ['contact_id', ['c1']] })
    expect(list.argsFor('gte')).toEqual(['scheduled_at', '2026-10-01T00:00:00.000Z'])
    expect(list.argsFor('lt')).toEqual(['scheduled_at', '2026-10-08T00:00:00.000Z'])
    expect(list.argsFor('or')).toBeUndefined()
  })

  it('returns an empty page without querying bookings when the search matches no one', async () => {
    const { db, of } = dbFor({ contacts: { data: [], error: null } })
    const page = await fetchBookingQueue(db, parseBookingFilters(new URLSearchParams('q=nobody')), NOW)
    expect(page.rows).toEqual([])
    expect(page.total).toBe(0)
    // Only the queue count touched bookings.
    expect(of('bookings')).toHaveLength(1)
  })

  it('reports a failed queue count', async () => {
    const { db } = dbFor({ bookings: [{ data: [], error: null, count: 0 }, { data: null, error: { message: 'x' }, count: null }] })
    await expect(fetchBookingQueue(db, parseBookingFilters(new URLSearchParams()), NOW)).rejects.toThrow(/need action/)
  })
})

describe('readSchedulingHealth', () => {
  it('is delayed when Calendly events are parked or deliveries failed in the last day', async () => {
    const { db, of } = dbFor({
      booking_reconciliation: { data: null, error: null, count: 2 },
      webhook_events: { data: null, error: null, count: 1 },
    })

    await expect(readSchedulingHealth(db, NOW)).resolves.toEqual({ delayed: true, unmatchedEvents: 2, failedDeliveries: 1 })
    expect(of('webhook_events')[0].argsFor('gte')).toEqual(['received_at', '2026-10-11T12:00:00.000Z'])
  })

  it('is healthy with nothing parked or failed', async () => {
    const { db } = dbFor({})
    await expect(readSchedulingHealth(db, NOW)).resolves.toEqual({ delayed: false, unmatchedEvents: 0, failedDeliveries: 0 })
  })

  it('answers null rather than failing the list when it cannot tell', async () => {
    const failed = dbFor({ webhook_events: { data: null, error: { message: 'x' }, count: null } })
    await expect(readSchedulingHealth(failed.db, NOW)).resolves.toBeNull()

    const thrown = { from: () => { throw new Error('offline') } }
    await expect(readSchedulingHealth(thrown as never, NOW)).resolves.toBeNull()
  })
})

describe('fetchBookingDetail', () => {
  const DETAIL = {
    ...ROW,
    created_at: '2026-10-01T00:00:00.000Z',
    expires_at: '2026-10-30T00:00:00.000Z',
    stripe_session_id: 'cs_1',
    calendly_event_uri: null,
    calendly_invitee_uri: null,
    calendly_superseded_invitees: [],
    scheduled_at: null,
    cancelled_at: null,
    list_amount_cents: 50_000,
    charged_amount_cents: 0,
    currency: 'AUD',
    contact: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
  }

  it('returns the booking, its reasons and its timeline, without the token hash', async () => {
    const { db, of } = dbFor({
      bookings: [{ data: DETAIL, error: null }, { data: [], error: null }],
      // The drawer's own read first, then the flagged-bookings lookup.
      notification_outbox: [
        { data: [{ id: 'n1', kind: 'booking_paid_confirmation', status: 'failed', attempts: 5, last_error: 'bounced', created_at: '2026-10-02T00:00:00.000Z', sent_at: null }], error: null },
        { data: [{ booking_id: B1 }], error: null },
      ],
    })

    const detail = await fetchBookingDetail(db, B1, NOW)

    expect(detail?.booking.id).toBe(B1)
    expect(detail?.reasons).toEqual(['stalled_claim', 'email_failed'])
    expect(detail?.timeline.map((entry) => entry.title)).toContain('Confirmation email failed')
    expect(String(of('bookings')[0].argsFor('select')?.[0])).not.toContain('token_hash')
    expect(of('booking_reconciliation')[0].argsFor('or')).toEqual([`tracking_booking_id.eq.${B1},email.eq."ada@example.com"`])
  })

  it('matches Calendly rows by tracking id only when the contact is gone', async () => {
    const { db, of } = dbFor({ bookings: { data: { ...DETAIL, contact: null }, error: null } })
    await fetchBookingDetail(db, B1, NOW)
    expect(of('booking_reconciliation')[0].argsFor('or')).toEqual([`tracking_booking_id.eq.${B1}`])
  })

  it('returns null for a booking the session cannot see', async () => {
    const { db } = dbFor({ bookings: { data: null, error: null } })
    await expect(fetchBookingDetail(db, B1, NOW)).resolves.toBeNull()
  })

  it.each([
    [{ bookings: { data: null, error: { message: 'x' } } }, 'Could not load booking'],
    [{ bookings: { data: DETAIL, error: null }, notification_outbox: [{ data: null, error: { message: 'x' } }, { data: [], error: null }] }, 'Could not read notifications'],
    [{ bookings: { data: DETAIL, error: null }, booking_reconciliation: [{ data: null, error: { message: 'x' } }, { data: [], error: null }] }, 'Could not read Calendly reconciliation'],
  ])('reports read failures %#', async (responses, message) => {
    const { db } = dbFor(responses as Responses)
    await expect(fetchBookingDetail(db, B1, NOW)).rejects.toThrow(message)
  })
})
