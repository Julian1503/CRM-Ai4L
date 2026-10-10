/**
 * @jest-environment node
 *
 * Webhook recovery, payment and Calendly ordering against the real database, through
 * the same lib functions the webhook routes and the return page call (audit H10, H11,
 * M4). The SQL rules are verified in supabase/tests/verify_20261005000000.sql inside one
 * transaction; these cases need separate connections: a process that dies after its
 * claim, deliveries racing each other, a database failure between claim and completion.
 *
 * Fixtures carry unique names and are never physically deleted.
 */
import { randomBytes } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import { applyCalendlyEvent, type CalendlyInviteeEvent } from '@/lib/booking/calendly'
import { applyCheckoutPayment, type CheckoutSessionFacts } from '@/lib/booking/payment'
import type { Database } from '@/lib/db/types'
import { describeIntegration, must, serviceClient, uniqueTag, withRpcFaults } from '@/test/integration'

import { claimWebhookEvent, completeWebhookEvent } from './idempotency'

jest.setTimeout(60_000)

type Db = SupabaseClient<Database>

async function newContact(db: Db): Promise<{ id: string; email: string }> {
  const email = `${uniqueTag('wh')}@example.invalid`
  const row = await must(db.from('contacts').insert({ first_name: 'Web', last_name: 'Hook', email }).select('id').single())
  return { id: String(row.id), email }
}

async function newBooking(db: Db, contactId: string, status: 'checkout_started' | 'paid', sessionId: string | null): Promise<string> {
  const row = await must(
    db
      .from('bookings')
      .insert({
        token_hash: randomBytes(32).toString('hex'),
        contact_id: contactId,
        status,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        stripe_session_id: sessionId,
      } as never)
      .select('id')
      .single()
  )
  return String((row as { id: string }).id)
}

function session(id: string): CheckoutSessionFacts {
  return { id, status: 'complete', payment_status: 'no_payment_required', amount_total: 0, currency: 'aud' }
}

async function expireLease(db: Db, provider: string, eventId: string): Promise<void> {
  const { error } = await db
    .from('webhook_events')
    .update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() } as never)
    .eq('provider', provider)
    .eq('event_id', eventId)
  if (error) throw new Error(error.message)
}

async function eventStatus(db: Db, provider: string, eventId: string) {
  return must(db.from('webhook_events').select('status, attempts').eq('provider', provider).eq('event_id', eventId).single()) as Promise<{
    status: string
    attempts: number
  }>
}

async function bookingState(db: Db, id: string) {
  return must(db.from('bookings').select('status, calendly_invitee_uri').eq('id', id).single())
}

async function outboxCount(db: Db, bookingId: string): Promise<number> {
  // notification_outbox is not in the hand-written Database types; read it untyped.
  const { count, error } = await (db as unknown as SupabaseClient).from('notification_outbox').select('id', { count: 'exact', head: true }).eq('booking_id', bookingId)
  if (error) throw new Error(error.message)
  return count ?? 0
}

describeIntegration('webhook recovery against Postgres', () => {
  it('a worker killed after its claim leaves the event recoverable; the redelivery processes it once', async () => {
    const db = serviceClient()
    const contact = await newContact(db)
    const sessionId = uniqueTag('cs')
    const bookingId = await newBooking(db, contact.id, 'checkout_started', sessionId)
    const eventId = uniqueTag('evt')

    // First delivery claims, then the process dies before doing anything else.
    const dead = await claimWebhookEvent(db, 'stripe', eventId, 'checkout.session.completed')
    expect(dead.outcome).toBe('claimed')

    // A redelivery while the lease is live is told to retry, not that it is done.
    await expect(claimWebhookEvent(db, 'stripe', eventId, 'checkout.session.completed')).resolves.toEqual({ outcome: 'in_progress' })

    // The lease runs out; the next redelivery takes over and completes the work.
    await expireLease(db, 'stripe', eventId)
    const live = await claimWebhookEvent(db, 'stripe', eventId, 'checkout.session.completed')
    if (live.outcome !== 'claimed') throw new Error('the redelivery did not take over')
    const claim = { provider: 'stripe', eventId, token: live.token }
    await expect(applyCheckoutPayment(db, { bookingId, session: session(sessionId), webhook: claim })).resolves.toBe('applied')

    // The dead worker coming back cannot settle anything any more.
    await completeWebhookEvent(db, { provider: 'stripe', eventId, token: (dead as { token: string }).token }, 'failed_retryable', 'late')
    await expect(eventStatus(db, 'stripe', eventId)).resolves.toEqual({ status: 'completed', attempts: 2 })
    await expect(claimWebhookEvent(db, 'stripe', eventId, 'checkout.session.completed')).resolves.toEqual({ outcome: 'completed' })
    await expect(bookingState(db, bookingId)).resolves.toMatchObject({ status: 'paid' })
    await expect(outboxCount(db, bookingId)).resolves.toBe(1)
  })

  it('a database failure before completion leaves the event retryable and loses no work', async () => {
    const db = serviceClient()
    const contact = await newContact(db)
    const sessionId = uniqueTag('cs')
    const bookingId = await newBooking(db, contact.id, 'checkout_started', sessionId)
    const eventId = uniqueTag('evt')
    const faulty = withRpcFaults(db, (fn, _args, call) => (fn === 'apply_checkout_payment' && call === 1 ? { message: 'connection reset' } : null))

    const first = await claimWebhookEvent(faulty, 'stripe', eventId, 'checkout.session.completed')
    if (first.outcome !== 'claimed') throw new Error('not claimed')
    await expect(
      applyCheckoutPayment(faulty, { bookingId, session: session(sessionId), webhook: { provider: 'stripe', eventId, token: first.token } })
    ).rejects.toThrow(/connection reset/)
    // The route records the failure as retryable.
    await completeWebhookEvent(faulty, { provider: 'stripe', eventId, token: first.token }, 'failed_retryable', 'connection reset')
    await expect(bookingState(db, bookingId)).resolves.toMatchObject({ status: 'checkout_started' })

    const retry = await claimWebhookEvent(faulty, 'stripe', eventId, 'checkout.session.completed')
    if (retry.outcome !== 'claimed') throw new Error('the retry was not taken over')
    await expect(
      applyCheckoutPayment(faulty, { bookingId, session: session(sessionId), webhook: { provider: 'stripe', eventId, token: retry.token } })
    ).resolves.toBe('applied')
    await expect(eventStatus(db, 'stripe', eventId)).resolves.toEqual({ status: 'completed', attempts: 2 })
  })

  it('concurrent duplicate deliveries: exactly one is processed', async () => {
    const db = serviceClient()
    const eventId = uniqueTag('evt')

    const claims = await Promise.all(Array.from({ length: 6 }, () => claimWebhookEvent(db, 'calendly', eventId, 'invitee.created')))

    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1)
    expect(claims.filter((claim) => claim.outcome === 'in_progress')).toHaveLength(5)
  })
})

describeIntegration('payment race against Postgres', () => {
  it.each(['browser first', 'webhook first'])('%s, and both at once, converge on one payment and one email', async (order) => {
    const db = serviceClient()
    const contact = await newContact(db)
    const sessionId = uniqueTag('cs')
    const bookingId = await newBooking(db, contact.id, 'checkout_started', sessionId)
    const eventId = uniqueTag('evt')

    const browser = () => applyCheckoutPayment(db, { bookingId, session: session(sessionId) })
    const webhook = async () => {
      const claimed = await claimWebhookEvent(db, 'stripe', eventId, 'checkout.session.completed')
      if (claimed.outcome !== 'claimed') return claimed.outcome
      return applyCheckoutPayment(db, { bookingId, session: session(sessionId), webhook: { provider: 'stripe', eventId, token: claimed.token } })
    }

    const outcomes = order === 'browser first' ? [await browser(), await webhook()] : [await webhook(), await browser()]
    expect(outcomes).toEqual(['applied', 'already_applied'])

    // Both at once on a fresh booking: one applies, the other sees it applied.
    const raceSession = uniqueTag('cs')
    const raceBooking = await newBooking(db, contact.id, 'checkout_started', raceSession)
    const race = await Promise.all([
      applyCheckoutPayment(db, { bookingId: raceBooking, session: session(raceSession) }),
      applyCheckoutPayment(db, { bookingId: raceBooking, session: session(raceSession) }),
    ])
    expect([...race].sort()).toEqual(['already_applied', 'applied'])

    await expect(outboxCount(db, bookingId)).resolves.toBe(1)
    await expect(outboxCount(db, raceBooking)).resolves.toBe(1)
    await expect(eventStatus(db, 'stripe', eventId)).resolves.toMatchObject({ status: 'completed' })
  })

  it('a different checkout cannot claim the booking', async () => {
    const db = serviceClient()
    const contact = await newContact(db)
    const sessionId = uniqueTag('cs')
    const bookingId = await newBooking(db, contact.id, 'checkout_started', sessionId)

    await expect(applyCheckoutPayment(db, { bookingId, session: session(uniqueTag('cs-other')) })).resolves.toBe('mismatch')
    await expect(bookingState(db, bookingId)).resolves.toMatchObject({ status: 'checkout_started' })
    await expect(outboxCount(db, bookingId)).resolves.toBe(0)
  })
})

describeIntegration('Calendly orderings against Postgres', () => {
  function invitee(overrides: Partial<CalendlyInviteeEvent>): CalendlyInviteeEvent {
    return {
      event: 'invitee.created',
      inviteeUri: uniqueTag('inv'),
      eventUri: null,
      scheduledAt: null,
      email: null,
      trackingBookingId: null,
      rescheduled: false,
      oldInviteeUri: null,
      ...overrides,
    }
  }

  /** What the scheduled worker does with a parked event (src/lib/jobs/runJobs.ts). */
  async function retryParked(db: Db, inviteeUri: string, event: CalendlyInviteeEvent['event']) {
    const parked = await must(
      db
        .from('booking_reconciliation')
        .select('event_type, invitee_uri, event_uri, email, scheduled_at, tracking_booking_id, old_invitee_uri, rescheduled')
        .eq('invitee_uri', inviteeUri)
        .eq('event_type', event)
        .is('resolved_at', null)
        .single()
    )
    const row = parked as unknown as {
      event_type: CalendlyInviteeEvent['event']
      invitee_uri: string
      event_uri: string | null
      email: string | null
      scheduled_at: string | null
      tracking_booking_id: string | null
      old_invitee_uri: string | null
      rescheduled: boolean
    }
    return applyCalendlyEvent(db, {
      event: row.event_type,
      inviteeUri: row.invitee_uri,
      eventUri: row.event_uri,
      scheduledAt: row.scheduled_at,
      email: row.email,
      trackingBookingId: row.tracking_booking_id,
      rescheduled: row.rescheduled,
      oldInviteeUri: row.old_invitee_uri,
    })
  }

  it('create then cancel, with the webhook claim completed in the same call', async () => {
    const db = serviceClient()
    const contact = await newContact(db)
    const bookingId = await newBooking(db, contact.id, 'paid', null)
    const created = invitee({ email: contact.email, trackingBookingId: bookingId })
    const eventId = uniqueTag('evt')

    const claimed = await claimWebhookEvent(db, 'calendly', eventId, 'invitee.created')
    if (claimed.outcome !== 'claimed') throw new Error('not claimed')
    await expect(applyCalendlyEvent(db, created, { provider: 'calendly', eventId, token: claimed.token })).resolves.toBe('applied')
    await expect(eventStatus(db, 'calendly', eventId)).resolves.toMatchObject({ status: 'completed' })
    await expect(bookingState(db, bookingId)).resolves.toEqual({ status: 'booked', calendly_invitee_uri: created.inviteeUri })

    await expect(applyCalendlyEvent(db, { ...created, event: 'invitee.canceled' })).resolves.toBe('applied')
    await expect(bookingState(db, bookingId)).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('cancel before create is parked, then converges on the scheduled retry', async () => {
    const db = serviceClient()
    const contact = await newContact(db)
    const bookingId = await newBooking(db, contact.id, 'paid', null)
    const inviteeUri = uniqueTag('inv')

    await expect(applyCalendlyEvent(db, invitee({ event: 'invitee.canceled', inviteeUri }))).resolves.toBe('unmatched')
    await expect(applyCalendlyEvent(db, invitee({ inviteeUri, email: contact.email }))).resolves.toBe('applied')
    await expect(retryParked(db, inviteeUri, 'invitee.canceled')).resolves.toBe('applied')
    await expect(bookingState(db, bookingId)).resolves.toMatchObject({ status: 'cancelled' })
  })

  it.each(['old cancel first', 'replacement first'])('a reschedule (%s) keeps the booking on the replacement', async (order) => {
    const db = serviceClient()
    const contact = await newContact(db)
    const bookingId = await newBooking(db, contact.id, 'paid', null)
    const original = invitee({ email: contact.email, trackingBookingId: bookingId })
    await applyCalendlyEvent(db, original)

    const cancelOld = () => applyCalendlyEvent(db, { ...original, event: 'invitee.canceled', rescheduled: true })
    const replacement = invitee({ email: contact.email, oldInviteeUri: original.inviteeUri })
    const createNew = () => applyCalendlyEvent(db, replacement)

    if (order === 'old cancel first') {
      await expect(cancelOld()).resolves.toBe('applied')
      await expect(createNew()).resolves.toBe('applied')
    } else {
      await expect(createNew()).resolves.toBe('applied')
      await expect(cancelOld()).resolves.toBe('ignored')
    }

    // Duplicates and the old invitee's late events change nothing.
    await expect(createNew()).resolves.toBe('ignored')
    await expect(applyCalendlyEvent(db, { ...original, event: 'invitee.canceled' })).resolves.toBe('ignored')
    await expect(bookingState(db, bookingId)).resolves.toEqual({ status: 'booked', calendly_invitee_uri: replacement.inviteeUri })
  })

  it('a reschedule whose events all arrive before the payment converges once retried', async () => {
    const db = serviceClient()
    const contact = await newContact(db)
    const bookingId = await newBooking(db, contact.id, 'checkout_started', uniqueTag('cs'))
    const original = invitee({ email: contact.email })
    const replacement = invitee({ email: contact.email, oldInviteeUri: original.inviteeUri })

    // Calendly is quicker than the payment: everything is parked.
    await expect(applyCalendlyEvent(db, original)).resolves.toBe('unmatched')
    await expect(applyCalendlyEvent(db, { ...original, event: 'invitee.canceled', rescheduled: true })).resolves.toBe('unmatched')
    await expect(applyCalendlyEvent(db, replacement)).resolves.toBe('unmatched')

    await must(db.from('bookings').update({ status: 'paid' } as never).eq('id', bookingId).select('id').single())

    // The scheduled worker replays them oldest first.
    await expect(retryParked(db, original.inviteeUri, 'invitee.created')).resolves.toBe('applied')
    await expect(retryParked(db, original.inviteeUri, 'invitee.canceled')).resolves.toBe('applied')
    await expect(retryParked(db, replacement.inviteeUri, 'invitee.created')).resolves.toBe('applied')
    await expect(bookingState(db, bookingId)).resolves.toEqual({ status: 'booked', calendly_invitee_uri: replacement.inviteeUri })
  })

  it('an unrelated appointment cannot modify a scheduled booking', async () => {
    const db = serviceClient()
    const contact = await newContact(db)
    const bookingId = await newBooking(db, contact.id, 'paid', null)
    const booked = invitee({ email: contact.email, trackingBookingId: bookingId })
    await applyCalendlyEvent(db, booked)

    await expect(applyCalendlyEvent(db, invitee({ email: contact.email }))).resolves.toBe('unmatched')
    await expect(applyCalendlyEvent(db, invitee({ email: 'stranger@example.invalid', trackingBookingId: bookingId }))).resolves.toBe('unmatched')
    await expect(bookingState(db, bookingId)).resolves.toEqual({ status: 'booked', calendly_invitee_uri: booked.inviteeUri })
  })
})
