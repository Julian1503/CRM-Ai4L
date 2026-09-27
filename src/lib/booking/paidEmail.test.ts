/**
 * @jest-environment node
 */
const mockFindBookingByToken = jest.fn()
const mockGetResendConfig = jest.fn()
const mockSendTransactionalEmail = jest.fn()

jest.mock('./repository', () => ({
  findBookingByToken: (...args: unknown[]) => mockFindBookingByToken(...args),
}))
jest.mock('@/lib/email/resend', () => ({
  getResendConfig: () => mockGetResendConfig(),
  sendTransactionalEmail: (...args: unknown[]) => mockSendTransactionalEmail(...args),
}))

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

import { sendBookingPaidEmail } from './paidEmail'

const db = {} as SupabaseClient<Database>
const TOKEN = 'uLdKaM6-HU2rWYTDQq1yhn63iYI-DbKYTMnWl_xaKjQ'
const session = {
  id: 'cs_1',
  success_url: `https://crm.example.com/book/${TOKEN}/scheduled?session={CHECKOUT_SESSION_ID}`,
}
const booking = {
  id: 'b1',
  contact: { id: 'c1', email: 'ana@example.com', first_name: 'Ana', last_name: 'Lopez' },
}

describe('sendBookingPaidEmail', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.NEXT_PUBLIC_APP_URL
    mockGetResendConfig.mockReturnValue({ apiKey: 're_test', from: 'Ai4L <b@example.com>' })
    mockFindBookingByToken.mockResolvedValue(booking)
    mockSendTransactionalEmail.mockResolvedValue({ id: 'email_1' })
  })

  afterAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
  })

  it('sends the scheduling link to the booking contact, once per booking', async () => {
    const result = await sendBookingPaidEmail(db, session, 'b1')

    expect(result).toEqual({ status: 'sent', emailId: 'email_1' })
    expect(mockFindBookingByToken).toHaveBeenCalledWith(db, TOKEN)
    const [, email] = mockSendTransactionalEmail.mock.calls[0]
    expect(email).toMatchObject({ to: 'ana@example.com', idempotencyKey: 'booking-paid-b1' })
    expect(email.text).toContain(
      `https://crm.example.com/book/${TOKEN}/scheduled?session=cs_1`
    )
  })

  it('builds the link on the configured app origin', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.org'

    await sendBookingPaidEmail(db, session, 'b1')

    const [, email] = mockSendTransactionalEmail.mock.calls[0]
    expect(email.text).toContain(`https://app.example.org/book/${TOKEN}/scheduled`)
  })

  it('skips when Resend is not configured', async () => {
    mockGetResendConfig.mockReturnValue(null)

    await expect(sendBookingPaidEmail(db, session, 'b1')).resolves.toEqual({
      status: 'skipped',
      reason: 'not_configured',
    })
    expect(mockSendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('skips when the success URL is not a scheduling URL', async () => {
    const result = await sendBookingPaidEmail(
      db,
      { id: 'cs_1', success_url: 'https://example.com/thanks' },
      'b1'
    )

    expect(result).toEqual({ status: 'skipped', reason: 'no_link' })
  })

  it('refuses to email when the token resolves to a different booking', async () => {
    mockFindBookingByToken.mockResolvedValue({ ...booking, id: 'someone-else' })

    const result = await sendBookingPaidEmail(db, session, 'b1')

    expect(result).toEqual({ status: 'skipped', reason: 'booking_mismatch' })
    expect(mockSendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('skips a contact with no email address', async () => {
    mockFindBookingByToken.mockResolvedValue({ ...booking, contact: null })

    await expect(sendBookingPaidEmail(db, session, 'b1')).resolves.toEqual({
      status: 'skipped',
      reason: 'no_email',
    })
  })

  it('propagates a delivery failure to the caller', async () => {
    mockSendTransactionalEmail.mockRejectedValue(new Error('Resend down'))

    await expect(sendBookingPaidEmail(db, session, 'b1')).rejects.toThrow('Resend down')
  })
})
