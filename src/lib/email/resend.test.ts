/**
 * @jest-environment node
 */

import { getResendConfig, sendTransactionalEmail } from './resend'

const config = { apiKey: 're_test', from: 'Ai4L <bookings@example.com>' }
const email = {
  to: 'ana@example.com',
  subject: 'Subject',
  html: '<p>Hi</p>',
  text: 'Hi',
  idempotencyKey: 'booking-paid-b1',
}

describe('getResendConfig', () => {
  const original = { ...process.env }

  afterEach(() => {
    process.env = { ...original }
  })

  it('returns null unless both key and sender are set', () => {
    process.env.RESEND_API_KEY = 're_test'
    delete process.env.BOOKING_EMAIL_FROM

    expect(getResendConfig()).toBeNull()
  })

  it('reads trimmed values', () => {
    process.env.RESEND_API_KEY = ' re_test '
    process.env.BOOKING_EMAIL_FROM = ' Ai4L <b@example.com> '

    expect(getResendConfig()).toEqual({ apiKey: 're_test', from: 'Ai4L <b@example.com>' })
  })
})

describe('sendTransactionalEmail', () => {
  it('posts the message with auth and idempotency headers', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_1' }), { status: 200 })
    )

    const result = await sendTransactionalEmail(config, email, fetchMock)

    expect(result).toEqual({ id: 'email_1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test',
      'Idempotency-Key': 'booking-paid-b1',
    })
    expect(JSON.parse(init.body)).toEqual({
      from: config.from,
      to: ['ana@example.com'],
      subject: 'Subject',
      html: '<p>Hi</p>',
      text: 'Hi',
    })
  })

  it('throws with the provider detail on a rejection', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response('{"message":"domain is not verified"}', { status: 403 })
    )

    await expect(sendTransactionalEmail(config, email, fetchMock)).rejects.toThrow(
      /403.*domain is not verified/
    )
  })
})
