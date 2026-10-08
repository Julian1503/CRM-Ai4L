/** @jest-environment node */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockSend = jest.fn()
jest.mock('./paidEmail', () => ({ sendBookingPaidEmail: (...args: unknown[]) => mockSend(...args) }))

import { processNotifications } from './notifications'

const NOTE = { id: 'n1', claim_token: 't1', kind: 'booking_paid_confirmation', booking_id: 'b1', stripe_session_id: 'cs_1' }

function db(claimed: unknown[], complete: { error: { message: string } | null } = { error: null }) {
  const mock = createDbMock(createQueryBuilderMock())
  mock.rpc.mockImplementation(async (fn: string) =>
    fn === 'claim_notifications' ? { data: claimed, error: null } : { data: true, error: complete.error }
  )
  return mock
}

const retrieveCheckout = jest.fn(async (id: string) => ({ id, success_url: 'https://crm/book/t?session_id={CHECKOUT_SESSION_ID}' }))

function settled(mock: ReturnType<typeof db>) {
  return mock.rpc.mock.calls.filter(([fn]) => fn === 'complete_notification').map(([, args]) => args)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('processNotifications', () => {
  it('sends a confirmation and settles it as sent', async () => {
    mockSend.mockResolvedValue({ status: 'sent', emailId: 'e1' })
    const mock = db([NOTE])

    await expect(processNotifications(mock as never, { retrieveCheckout, limit: 5 })).resolves.toEqual({ claimed: 1, sent: 1, skipped: 0, retried: 0 })
    expect(mock.rpc).toHaveBeenCalledWith('claim_notifications', { p_limit: 5 })
    expect(retrieveCheckout).toHaveBeenCalledWith('cs_1')
    expect(mockSend).toHaveBeenCalledWith(mock, expect.objectContaining({ id: 'cs_1' }), 'b1')
    expect(settled(mock)).toEqual([{ p_id: 'n1', p_token: 't1', p_status: 'sent', p_error: null }])
  })

  it('claims 20 by default', async () => {
    const mock = db([])
    await expect(processNotifications(mock as never, { retrieveCheckout })).resolves.toEqual({ claimed: 0, sent: 0, skipped: 0, retried: 0 })
    expect(mock.rpc).toHaveBeenCalledWith('claim_notifications', { p_limit: 20 })
  })

  it('keeps the email queued while email or Stripe is not configured', async () => {
    mockSend.mockResolvedValue({ status: 'skipped', reason: 'not_configured' })
    const mock = db([NOTE, { ...NOTE, id: 'n2' }])

    await processNotifications(mock as never, { retrieveCheckout })
    const noStripe = db([NOTE])
    await processNotifications(noStripe as never, { retrieveCheckout: null })

    expect(settled(mock).map((args) => [args.p_status, args.p_error])).toEqual([
      ['retry', 'email is not configured'],
      ['retry', 'email is not configured'],
    ])
    expect(settled(noStripe)[0]).toMatchObject({ p_status: 'retry', p_error: 'Stripe is not configured' })
  })

  it('skips a send that should not happen, and an unsupported or incomplete row', async () => {
    mockSend.mockResolvedValue({ status: 'skipped', reason: 'booking_mismatch' })
    const mock = db([NOTE, { ...NOTE, id: 'n2', kind: 'other' }, { ...NOTE, id: 'n3', stripe_session_id: null }])

    await expect(processNotifications(mock as never, { retrieveCheckout })).resolves.toMatchObject({ skipped: 3 })
    expect(settled(mock).map((args) => args.p_error)).toEqual([
      'booking_mismatch',
      'unsupported or incomplete notification',
      'unsupported or incomplete notification',
    ])
  })

  it('retries a delivery failure independently of the payment', async () => {
    mockSend.mockRejectedValueOnce(new Error('Resend 500')).mockRejectedValueOnce('odd')
    const mock = db([NOTE, { ...NOTE, id: 'n2' }])

    await expect(processNotifications(mock as never, { retrieveCheckout })).resolves.toMatchObject({ retried: 2 })
    expect(settled(mock).map((args) => [args.p_status, args.p_error])).toEqual([
      ['retry', 'Resend 500'],
      ['retry', 'send failed'],
    ])
  })

  it('logs a failure to settle and carries on', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockSend.mockResolvedValue({ status: 'sent', emailId: null })
    try {
      await expect(processNotifications(db([NOTE], { error: { message: 'down' } }) as never, { retrieveCheckout })).resolves.toMatchObject({ sent: 1 })
      expect(spy).toHaveBeenCalledWith('Could not settle a notification:', 'down')
    } finally {
      spy.mockRestore()
    }
  })

  it('throws when nothing can be claimed', async () => {
    const mock = createDbMock(createQueryBuilderMock())
    mock.rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    await expect(processNotifications(mock as never, { retrieveCheckout })).rejects.toThrow('Could not claim notifications: down')
  })
})
