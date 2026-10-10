/** @jest-environment node */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { applyCheckoutPayment, isCompletedCheckout, type CheckoutSessionFacts } from './payment'

const SESSION: CheckoutSessionFacts = {
  id: 'cs_1',
  status: 'complete',
  payment_status: 'no_payment_required',
  amount_total: 0,
  currency: 'aud',
}

function db(result: unknown) {
  const mock = createDbMock(createQueryBuilderMock())
  mock.rpc.mockResolvedValue(result)
  return mock
}

describe('isCompletedCheckout', () => {
  it.each([
    [{ status: 'complete', payment_status: 'paid' }, true],
    [{ status: 'complete', payment_status: 'no_payment_required' }, true],
    [{ status: 'complete', payment_status: 'unpaid' }, false],
    [{ status: 'open', payment_status: 'paid' }, false],
    [{ status: null, payment_status: null }, false],
  ])('%p → %s', (facts, expected) => {
    expect(isCompletedCheckout({ ...SESSION, ...facts })).toBe(expected)
  })
})

describe('applyCheckoutPayment', () => {
  it('calls the single payment operation the return page and the webhook share', async () => {
    const mock = db({ data: 'applied', error: null })

    await expect(applyCheckoutPayment(mock as never, { bookingId: 'b1', session: SESSION })).resolves.toBe('applied')
    expect(mock.rpc).toHaveBeenCalledWith('apply_checkout_payment', {
      p_booking_id: 'b1',
      p_session_id: 'cs_1',
      p_amount: 0,
      p_currency: 'aud',
      p_provider: null,
      p_event_id: null,
      p_event_token: null,
    })
  })

  it('passes the webhook claim so payment and completion commit together', async () => {
    const mock = db({ data: 'already_applied', error: null })

    await applyCheckoutPayment(mock as never, {
      bookingId: 'b1',
      session: SESSION,
      webhook: { provider: 'stripe', eventId: 'evt_1', token: 't1' },
    })

    expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_provider: 'stripe', p_event_id: 'evt_1', p_event_token: 't1' })
  })

  it.each(['not_ready', 'not_found', 'mismatch'])('returns the %s outcome for the caller to act on', async (outcome) => {
    await expect(applyCheckoutPayment(db({ data: outcome, error: null }) as never, { bookingId: 'b1', session: SESSION })).resolves.toBe(outcome)
  })

  it('throws on a database error or a missing outcome', async () => {
    await expect(applyCheckoutPayment(db({ data: null, error: { message: 'down' } }) as never, { bookingId: 'b', session: SESSION })).rejects.toThrow(
      'Could not record payment: down'
    )
    await expect(applyCheckoutPayment(db({ data: null, error: null }) as never, { bookingId: 'b', session: SESSION })).rejects.toThrow(
      /no outcome/
    )
  })
})
