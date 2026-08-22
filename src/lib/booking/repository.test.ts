/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import {
  createBooking,
  findBookingByToken,
  markBookingCancelled,
  markBookingPaid,
  markBookingScheduled,
  markCheckoutStarted,
} from './repository'
import { hashBookingToken } from './token'

describe('createBooking', () => {
  it('stores only the hash, never the token that goes in the email', async () => {
    const builder = createQueryBuilderMock({ data: { id: 'b1' }, error: null })
    const db = createDbMock(builder)

    const { token } = await createBooking(db as never, { contactId: 'c1' })

    const insert = builder.argsFor('insert') as [Record<string, unknown>]
    expect(insert[0].token_hash).toBe(hashBookingToken(token))
    expect(JSON.stringify(insert[0])).not.toContain(token)
  })

  it('never puts the contact id in the link', async () => {
    const builder = createQueryBuilderMock({ data: { id: 'b1' }, error: null })
    // A full UUID, not a short stub: the token is 43 random base64url characters, so a
    // two-character id collides with it by chance roughly once in a hundred runs.
    const contactId = '3f2a9c74-5b1e-4d8a-9f60-7c21ab4e0d53'

    const { token } = await createBooking(createDbMock(builder) as never, { contactId })

    // Email links leak — forwarded, logged by gateways, captured by link scanners.
    expect(token).not.toContain(contactId)
  })

  it('sets an expiry', async () => {
    const builder = createQueryBuilderMock({ data: { id: 'b1' }, error: null })

    await createBooking(createDbMock(builder) as never, { contactId: 'c1', nowMs: 0 })

    const insert = builder.argsFor('insert') as [Record<string, unknown>]
    expect(Date.parse(String(insert[0].expires_at))).toBeGreaterThan(0)
  })

  it('surfaces a failure', async () => {
    const builder = createQueryBuilderMock({ data: null, error: { message: 'denied' } })

    await expect(
      createBooking(createDbMock(builder) as never, { contactId: 'c1' })
    ).rejects.toThrow(/denied/)
  })
})

describe('findBookingByToken', () => {
  it('looks up by hash, not by the raw token', async () => {
    const builder = createQueryBuilderMock({ data: { id: 'b1' }, error: null })
    const db = createDbMock(builder)

    await findBookingByToken(db as never, 'raw-token')

    expect(builder.allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['token_hash', hashBookingToken('raw-token')],
    })
  })

  it('returns null for an unknown token', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })

    await expect(
      findBookingByToken(createDbMock(builder) as never, 'nope')
    ).resolves.toBeNull()
  })
})

describe('markCheckoutStarted', () => {
  it('consumes the link so a forwarded copy cannot open a second checkout', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    await markCheckoutStarted(db as never, 'b1', 'cs_1', 'promo_1')

    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).toMatchObject({
      status: 'checkout_started',
      stripe_session_id: 'cs_1',
      stripe_promotion_code_id: 'promo_1',
      consumed_at: expect.any(String),
    })
    // Conditional on it not already being consumed.
    expect(builder.allFor('is')).toContainEqual({ method: 'is', args: ['consumed_at', null] })
  })
})

describe('markBookingPaid', () => {
  it('records the charged amount against the session', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    await markBookingPaid(db as never, 'cs_1', 0)

    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).toMatchObject({ status: 'paid', charged_amount_cents: 0 })
    expect(builder.allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['stripe_session_id', 'cs_1'],
    })
  })

  it('cannot pull an already-booked row backwards', async () => {
    // Stripe retries aggressively; a replayed completion must not undo a scheduling
    // that already happened.
    const builder = createQueryBuilderMock({ data: null, error: null })

    await markBookingPaid(createDbMock(builder) as never, 'cs_1', 0)

    expect(builder.allFor('in')).toContainEqual({
      method: 'in',
      args: ['status', ['pending', 'checkout_started']],
    })
  })
})

describe('markBookingScheduled', () => {
  const params = {
    eventUri: 'https://api.calendly.com/events/e1',
    inviteeUri: 'https://api.calendly.com/invitees/i1',
    scheduledAt: '2026-09-01T02:00:00.000Z',
  }

  it('matches on booking id when the tracking parameter survived', async () => {
    const bookings = createQueryBuilderMock({ data: [{ id: 'b1' }], error: null })
    const db = createDbMock(bookings)

    await expect(
      markBookingScheduled(db as never, { ...params, bookingId: 'b1' })
    ).resolves.toBe(true)

    const update = bookings.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).toMatchObject({ status: 'booked', calendly_invitee_uri: params.inviteeUri })
  })

  it('will not resurrect a cancelled booking', async () => {
    const bookings = createQueryBuilderMock({ data: [{ id: 'b1' }], error: null })

    await markBookingScheduled(createDbMock(bookings) as never, { ...params, bookingId: 'b1' })

    expect(bookings.allFor('neq')).toContainEqual({ method: 'neq', args: ['status', 'cancelled'] })
  })

  it('falls back to matching the invitee by email', async () => {
    // Calendly does not guarantee custom parameters come back on the webhook.
    const bookings = createQueryBuilderMock([
      { data: [], error: null }, // id match found nothing
      { data: [{ id: 'b2' }], error: null }, // email match
    ])
    const contacts = createQueryBuilderMock({ data: { id: 'c1' }, error: null })

    const db = createDbMock((table: string) => (table === 'contacts' ? contacts : bookings))

    await expect(
      markBookingScheduled(db as never, { ...params, bookingId: 'missing', email: 'A@Example.com' })
    ).resolves.toBe(true)

    expect(contacts.allFor('eq')).toContainEqual({ method: 'eq', args: ['email', 'a@example.com'] })
  })

  it('reports no match rather than inventing a booking', async () => {
    const bookings = createQueryBuilderMock({ data: [], error: null })
    const contacts = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock((table: string) => (table === 'contacts' ? contacts : bookings))

    await expect(
      markBookingScheduled(db as never, { ...params, email: 'unknown@example.com' })
    ).resolves.toBe(false)
  })
})

describe('markBookingCancelled', () => {
  it('cancels by invitee uri', async () => {
    const builder = createQueryBuilderMock({ data: [{ id: 'b1' }], error: null })
    const db = createDbMock(builder)

    await expect(markBookingCancelled(db as never, 'invitee-1')).resolves.toBe(true)

    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).toMatchObject({ status: 'cancelled', cancelled_at: expect.any(String) })
  })

  it('reports when nothing matched', async () => {
    const builder = createQueryBuilderMock({ data: [], error: null })

    await expect(markBookingCancelled(createDbMock(builder) as never, 'x')).resolves.toBe(false)
  })
})
