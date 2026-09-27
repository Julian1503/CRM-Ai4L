/**
 * @jest-environment node
 */
jest.mock('server-only', () => ({}))

const mockSend = jest.fn()
jest.mock('@/lib/email/resend', () => ({
  sendTransactionalEmail: (...args: unknown[]) => mockSend(...args),
}))

import {
  getReviewNotificationConfig,
  renderReviewEmail,
  sendReviewNotification,
} from './reviewEmail'

const ENV_KEYS = [
  'RESEND_API_KEY',
  'NOTIFY_EMAIL_FROM',
  'BOOKING_EMAIL_FROM',
  'CAMPAIGN_REVIEW_EMAILS',
  'NEXT_PUBLIC_APP_URL',
] as const

const BASE = {
  scheduleName: 'Monthly newsletter',
  campaignId: 'camp-1',
  campaignName: 'Monthly newsletter — 2026-10-01',
  subject: 'AI note-taking, <safely>',
  scheduledFor: '2026-10-01',
  topicTitle: 'AI note-taking',
  generationError: null,
}

describe('reviewEmail', () => {
  const original: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    jest.clearAllMocks()
    for (const key of ENV_KEYS) original[key] = process.env[key]
    process.env.RESEND_API_KEY = 're_test'
    process.env.BOOKING_EMAIL_FROM = 'Ai4L <bookings@example.org>'
    delete process.env.NOTIFY_EMAIL_FROM
    process.env.CAMPAIGN_REVIEW_EMAILS = 'a@example.org, b@example.org'
    process.env.NEXT_PUBLIC_APP_URL = 'https://crm.example.org/'
    mockSend.mockResolvedValue({ id: 'email-1' })
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  describe('getReviewNotificationConfig', () => {
    it('reads the reviewers and falls back to the booking sender', () => {
      expect(getReviewNotificationConfig()).toEqual({
        apiKey: 're_test',
        from: 'Ai4L <bookings@example.org>',
        to: ['a@example.org', 'b@example.org'],
        appUrl: 'https://crm.example.org',
      })
    })

    it('prefers a dedicated notification sender', () => {
      process.env.NOTIFY_EMAIL_FROM = 'Ai4L CRM <crm@example.org>'

      expect(getReviewNotificationConfig()?.from).toBe('Ai4L CRM <crm@example.org>')
    })

    it('ignores entries that are not addresses', () => {
      process.env.CAMPAIGN_REVIEW_EMAILS = 'a@example.org, nonsense, , b@example.org'

      expect(getReviewNotificationConfig()?.to).toEqual(['a@example.org', 'b@example.org'])
    })

    it.each(['RESEND_API_KEY', 'CAMPAIGN_REVIEW_EMAILS', 'NEXT_PUBLIC_APP_URL'] as const)(
      'is off without %s',
      (key) => {
        delete process.env[key]

        expect(getReviewNotificationConfig()).toBeNull()
      }
    )
  })

  describe('renderReviewEmail', () => {
    it('links straight to the campaign in the CRM', () => {
      const email = renderReviewEmail(BASE, 'https://crm.example.org')

      expect(email.text).toContain('https://crm.example.org/?view=campaigns&campaign=camp-1')
      expect(email.html).toContain('href="https://crm.example.org/?view=campaigns&amp;campaign=camp-1"')
    })

    it('escapes generated text in the HTML', () => {
      const email = renderReviewEmail(BASE, 'https://crm.example.org')

      expect(email.html).toContain('&lt;safely&gt;')
      expect(email.html).not.toContain('<safely>')
    })

    it('says nothing is sent until someone approves', () => {
      expect(renderReviewEmail(BASE, 'https://crm.example.org').text).toMatch(
        /nothing is sent until/i
      )
    })

    it('flags a draft whose copy could not be written', () => {
      const email = renderReviewEmail(
        { ...BASE, subject: null, generationError: 'The model declined.' },
        'https://crm.example.org'
      )

      expect(email.subject).toMatch(/needs attention/i)
      expect(email.text).toContain('The model declined.')
    })

    it('mentions an empty topic queue', () => {
      const email = renderReviewEmail({ ...BASE, topicTitle: null }, 'https://crm.example.org')

      expect(email.text).toMatch(/no topic was queued/i)
    })
  })

  describe('sendReviewNotification', () => {
    it('emails each reviewer once per occurrence', async () => {
      const result = await sendReviewNotification(BASE)

      expect(result).toEqual({ status: 'sent', recipients: 2 })
      expect(mockSend).toHaveBeenCalledTimes(2)
      expect(mockSend.mock.calls[0][1]).toMatchObject({
        to: 'a@example.org',
        idempotencyKey: 'newsletter-review-camp-1-a@example.org',
      })
    })

    it('skips quietly when notifications are not configured', async () => {
      delete process.env.CAMPAIGN_REVIEW_EMAILS

      await expect(sendReviewNotification(BASE)).resolves.toEqual({
        status: 'skipped',
        reason: 'not_configured',
      })
      expect(mockSend).not.toHaveBeenCalled()
    })
  })
})
