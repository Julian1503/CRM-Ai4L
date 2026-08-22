import { createConsultationCheckout } from './checkout'

function stripeDouble(result = { id: 'cs_1', url: 'https://checkout.stripe.com/x' }) {
  const create = jest.fn().mockResolvedValue(result)
  return { stripe: { checkout: { sessions: { create } } }, create }
}

const params = {
  priceId: 'price_1',
  couponId: 'coupon_1',
  bookingId: 'b1',
  email: 'lead@example.com',
  successUrl: 'https://crm.example.com/book/tok/scheduled?session={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://crm.example.com/book/tok',
}

describe('createConsultationCheckout', () => {
  it('charges the $500 price and discounts it to zero', async () => {
    // The client's position is "valued at $500, yours free" — the list price has to be
    // on the session, not silently replaced by a $0 product.
    const { stripe, create } = stripeDouble()

    await createConsultationCheckout(stripe, params)

    const args = create.mock.calls[0][0]
    expect(args.line_items).toEqual([{ price: 'price_1', quantity: 1 }])
    expect(args.discounts).toEqual([{ coupon: 'coupon_1' }])
  })

  it('does not send payment_method_collection, which Stripe allows only in subscription mode', async () => {
    // The parameter reads as exactly what this flow wants ("do not collect a card when
    // the total is 0"), which is why it was here. But the Stripe API restricts it to
    // `mode: 'subscription'`, so sending it from a `payment`-mode session risks the
    // create call being rejected outright -- and a rejected session means the lead
    // sees "Could not start booking" instead of a checkout.
    //
    // It is also unnecessary: a payment-mode session whose total is 0 already skips
    // payment-method collection on Stripe's side.
    const { stripe, create } = stripeDouble()

    await createConsultationCheckout(stripe, params)

    expect(create.mock.calls[0][0]).not.toHaveProperty('payment_method_collection')
  })

  it('carries the booking id so the webhook can attribute the payment', async () => {
    const { stripe, create } = stripeDouble()

    await createConsultationCheckout(stripe, params)

    expect(create.mock.calls[0][0].metadata).toEqual({ booking_id: 'b1' })
  })

  it('does not set payment_intent_data, which a $0 session has no intent for', async () => {
    const { stripe, create } = stripeDouble()

    await createConsultationCheckout(stripe, params)

    expect(create.mock.calls[0][0]).not.toHaveProperty('payment_intent_data')
  })

  it('prefills the email so the lead does not retype it', async () => {
    const { stripe, create } = stripeDouble()

    await createConsultationCheckout(stripe, params)

    expect(create.mock.calls[0][0].customer_email).toBe('lead@example.com')
  })

  it('returns the redirect target', async () => {
    const { stripe } = stripeDouble()

    await expect(createConsultationCheckout(stripe, params)).resolves.toEqual({
      sessionId: 'cs_1',
      url: 'https://checkout.stripe.com/x',
    })
  })
})
