/**
 * @jest-environment node
 */
import { isAuthorisedCronRequest } from './cron'

const ORIGINAL = process.env.CRON_SECRET

describe('isAuthorisedCronRequest', () => {
  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL
  })

  it('accepts exactly the bearer secret', () => {
    process.env.CRON_SECRET = 's3cret-value'
    expect(isAuthorisedCronRequest('Bearer s3cret-value')).toBe(true)
  })

  it.each([
    ['no header', null],
    ['a wrong secret', 'Bearer nope'],
    ['a prefix of the secret', 'Bearer s3cret'],
    ['the bare secret', 's3cret-value'],
  ])('refuses %s', (_label, header) => {
    process.env.CRON_SECRET = 's3cret-value'
    expect(isAuthorisedCronRequest(header)).toBe(false)
  })

  it('fails closed when the secret is not configured', () => {
    delete process.env.CRON_SECRET
    expect(isAuthorisedCronRequest('Bearer ')).toBe(false)
    expect(isAuthorisedCronRequest('Bearer undefined')).toBe(false)
  })
})
