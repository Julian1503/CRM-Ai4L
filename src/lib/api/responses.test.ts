/**
 * @jest-environment node
 */
const mockGetSession = jest.fn()
jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))

import { forbidden, readJsonBody, requireAdminOr403, requireSessionOr401 } from './responses'

describe('requireAdminOr403 (audit C1/H1)', () => {
  it('answers 401 without an approved session', async () => {
    mockGetSession.mockResolvedValue(null)
    const guard = await requireAdminOr403()
    expect('response' in guard && guard.response.status).toBe(401)
  })

  it('answers 403 to an approved operator', async () => {
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
    const guard = await requireAdminOr403()
    expect('response' in guard && guard.response.status).toBe(403)
  })

  it('passes an administrator through', async () => {
    const session = { userId: 'u1', email: 'a@example.com', role: 'admin' }
    mockGetSession.mockResolvedValue(session)
    await expect(requireAdminOr403()).resolves.toEqual({ session })
  })
})

describe('responses', () => {
  it('marks a 403 private and uncacheable', async () => {
    const response = forbidden()
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it('passes an approved session through the 401 guard', async () => {
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
    await expect(requireSessionOr401()).resolves.toHaveProperty('session')
  })

  it.each([
    ['an array', '[1]'],
    ['malformed JSON', '{'],
    ['null', 'null'],
  ])('reads %s as no body', async (_label, body) => {
    await expect(readJsonBody(new Request('https://x', { method: 'POST', body }))).resolves.toBeNull()
  })
})
