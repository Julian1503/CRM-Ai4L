/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { BUILT_IN_TEMPLATE_SLOTS } from '@/lib/marketing/templates'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { GET, POST } from './route'

const TEMPLATE = {
  id: 't1',
  name: 'August free courses',
  provider_automation_id: 'b690d44a-a0dd-11f1-9fa9-7381a1ee33bd',
}

function withBuilder(response: unknown) {
  const builder = createQueryBuilderMock(response)
  mockCreateServerClient.mockResolvedValue(createDbMock(builder))
  return builder
}

function get(url = 'https://crm.example.com/api/templates') {
  return GET(new NextRequest(url))
}

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/templates', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  )
}

describe('/api/templates', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  describe('GET', () => {
    it('refuses an unauthenticated request', async () => {
      mockGetSession.mockResolvedValue(null)

      expect((await get()).status).toBe(401)
      expect(mockCreateServerClient).not.toHaveBeenCalled()
    })

    it('lists the registered templates', async () => {
      withBuilder({ data: [TEMPLATE], error: null })

      expect((await (await get()).json()).templates).toEqual([TEMPLATE])
    })

    it('hides archived templates, which is what archiving is for', async () => {
      const builder = withBuilder({ data: [], error: null })

      await get()

      expect(builder.argsFor('is')).toEqual(['archived_at', null])
    })

    it('includes archived templates only when asked', async () => {
      const builder = withBuilder({ data: [], error: null })

      await get('https://crm.example.com/api/templates?includeArchived=true')

      expect(builder.allFor('is')).toHaveLength(0)
    })

    it('reports a database failure instead of an empty list', async () => {
      // An empty picker and a broken query look identical on screen otherwise.
      withBuilder({ data: null, error: { message: 'relation does not exist' } })

      expect((await get()).status).toBe(500)
    })
  })

  describe('POST', () => {
    it('refuses an unauthenticated request', async () => {
      mockGetSession.mockResolvedValue(null)

      expect((await post({ name: 'x', providerAutomationId: 'a' })).status).toBe(401)
    })

    it('stores the name against the automation id', async () => {
      const builder = withBuilder({ data: TEMPLATE, error: null })

      const response = await post({
        name: '  August free courses  ',
        description: ' The seasonal one. ',
        providerAutomationId: '  b690d44a-a0dd-11f1-9fa9-7381a1ee33bd  ',
      })

      expect(response.status).toBe(200)
      expect(builder.argsFor('insert')?.[0]).toMatchObject({
        name: 'August free courses',
        description: 'The seasonal one.',
        provider_automation_id: 'b690d44a-a0dd-11f1-9fa9-7381a1ee33bd',
      })
    })

    it('starts every template on the built-in merge-field contract', async () => {
      // The table rejects an empty slots array, and a row with the wrong slots would
      // ask the copywriter for tags the template does not merge.
      const builder = withBuilder({ data: TEMPLATE, error: null })

      await post({ name: 'n', providerAutomationId: 'a' })

      expect(builder.argsFor('insert')?.[0]).toMatchObject({
        slots: BUILT_IN_TEMPLATE_SLOTS,
      })
    })

    it('requires a name', async () => {
      const response = await post({ name: '   ', providerAutomationId: 'a' })

      expect(response.status).toBe(400)
      expect(mockCreateServerClient).not.toHaveBeenCalled()
    })

    it('requires an automation id, since a named nothing cannot send', async () => {
      const response = await post({ name: 'August', providerAutomationId: '  ' })

      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/automation ID/i)
    })

    it('names the clash when two templates would share a name', async () => {
      // The picker shows names; two identical ones make the choice a coin flip.
      withBuilder({ data: null, error: { code: '23505', message: 'duplicate key' } })

      const response = await post({ name: 'August', providerAutomationId: 'a' })

      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('August')
    })

    it('does not verify the id, so a slow provider cannot block a correct save', async () => {
      const builder = withBuilder({ data: TEMPLATE, error: null })

      await post({ name: 'n', providerAutomationId: 'a' })

      // No provider round trip: verification is its own route, and its `unknown`
      // answer must never masquerade as "this name is wrong".
      expect(builder.argsFor('insert')).toBeDefined()
    })
  })
})
