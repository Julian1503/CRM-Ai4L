import { buildSchedulingLink, renderConfirmationEmail } from './confirmationEmail'

const TOKEN = 'uLdKaM6-HU2rWYTDQq1yhn63iYI-DbKYTMnWl_xaKjQ'
const SUCCESS_URL = `https://old.example.com/book/${TOKEN}/scheduled?session={CHECKOUT_SESSION_ID}`

describe('buildSchedulingLink', () => {
  it('recovers the token and substitutes the real session id', () => {
    const link = buildSchedulingLink(SUCCESS_URL, 'cs_test_1')

    expect(link).toEqual({
      token: TOKEN,
      url: `https://old.example.com/book/${TOKEN}/scheduled?session=cs_test_1`,
    })
  })

  it('uses the configured origin over the success URL host', () => {
    const link = buildSchedulingLink(SUCCESS_URL, 'cs_test_1', 'https://crm.example.com/')

    expect(link?.url).toBe(`https://crm.example.com/book/${TOKEN}/scheduled?session=cs_test_1`)
  })

  it('falls back to the success URL host when the configured origin is malformed', () => {
    const link = buildSchedulingLink(SUCCESS_URL, 'cs_test_1', 'not a url')

    expect(link?.url).toContain('https://old.example.com/')
  })

  it.each([
    [null],
    [''],
    ['not a url'],
    ['https://example.com/somewhere/else'],
    [`https://example.com/book/${TOKEN}`],
    [`https://example.com/book/../admin/scheduled`],
  ])('returns null for %p', (successUrl) => {
    expect(buildSchedulingLink(successUrl, 'cs_test_1')).toBeNull()
  })

  it('returns null without a session id', () => {
    expect(buildSchedulingLink(SUCCESS_URL, '')).toBeNull()
  })
})

describe('renderConfirmationEmail', () => {
  const url = `https://crm.example.com/book/${TOKEN}/scheduled?session=cs_1`

  it('carries the scheduling link in both parts', () => {
    const email = renderConfirmationEmail({ firstName: 'Ana', schedulingUrl: url })

    expect(email.text).toContain(url)
    expect(email.html).toContain(`href="${url}"`)
    expect(email.text).toContain('Hi Ana,')
  })

  it('escapes the contact name in the HTML body', () => {
    const email = renderConfirmationEmail({
      firstName: '<script>alert(1)</script>',
      schedulingUrl: url,
    })

    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
  })

  it('greets without a name when none is known', () => {
    const email = renderConfirmationEmail({ firstName: '  ', schedulingUrl: url })

    expect(email.text.startsWith('Hi,')).toBe(true)
  })
})
