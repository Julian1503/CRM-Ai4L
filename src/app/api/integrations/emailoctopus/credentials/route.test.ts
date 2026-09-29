/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
let credentialsTable: QueryBuilderMock

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => createDbMock(credentialsTable),
}))

import { GET, PUT } from './route'

const SAVED = [
  { key: 'emailoctopus_api_key', value: 'eo-secret-key' },
  { key: 'emailoctopus_list_id', value: 'list-1' },
]

function put(body: unknown) {
  return PUT(
    new Request('https://crm.example.com/api/integrations/emailoctopus/credentials', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  )
}

describe('/api/integrations/emailoctopus/credentials (audit H1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    credentialsTable = createQueryBuilderMock({ data: SAVED, error: null })
  })

  describe('GET', () => {
    it('refuses a caller without an approved session', async () => {
      mockGetSession.mockResolvedValue(null)
      expect((await GET()).status).toBe(401)
    })

    it('reports configuration without ever returning the key', async () => {
      mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })

      const response = await GET()
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(JSON.parse(text)).toEqual({
        apiKeyConfigured: true,
        listId: 'list-1',
        configured: true,
        canEdit: false,
      })
      expect(text).not.toContain('eo-secret-key')
    })

    it('lets an administrator edit', async () => {
      mockGetSession.mockResolvedValue({ userId: 'u1', email: 'a@example.com', role: 'admin' })
      await expect((await GET()).json()).resolves.toMatchObject({ canEdit: true })
    })

    it('does not leak the database error text', async () => {
      mockGetSession.mockResolvedValue({ userId: 'u1', email: 'a@example.com', role: 'admin' })
      credentialsTable = createQueryBuilderMock({ data: null, error: { message: 'relation secret_table' } })
      jest.spyOn(console, 'error').mockImplementation(() => undefined)

      const response = await GET()

      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain('secret_table')
    })
  })

  describe('PUT', () => {
    it('is forbidden to an operator', async () => {
      mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })

      const response = await put({ apiKey: { action: 'replace', value: 'k' }, listId: 'l' })

      expect(response.status).toBe(403)
      expect(credentialsTable.allFor('upsert')).toHaveLength(0)
    })

    it('replaces the key when asked, and answers with status only', async () => {
      mockGetSession.mockResolvedValue({ userId: 'u1', email: 'a@example.com', role: 'admin' })

      const response = await put({ apiKey: { action: 'replace', value: ' new-key ' }, listId: 'list-2' })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(credentialsTable.argsFor('upsert')?.[0]).toEqual([
        { key: 'emailoctopus_list_id', value: 'list-2' },
        { key: 'emailoctopus_api_key', value: 'new-key' },
      ])
      expect(text).not.toContain('new-key')
      expect(text).not.toContain('eo-secret-key')
    })

    it('leaves the saved key alone when it is unchanged', async () => {
      mockGetSession.mockResolvedValue({ userId: 'u1', email: 'a@example.com', role: 'admin' })

      await put({ apiKey: { action: 'unchanged' }, listId: 'list-2' })

      expect(credentialsTable.argsFor('upsert')?.[0]).toEqual([
        { key: 'emailoctopus_list_id', value: 'list-2' },
      ])
    })

    it('clears the key only on an explicit clear, by blanking rather than deleting', async () => {
      mockGetSession.mockResolvedValue({ userId: 'u1', email: 'a@example.com', role: 'admin' })

      await put({ apiKey: { action: 'clear' }, listId: 'list-1' })

      expect(credentialsTable.argsFor('upsert')?.[0]).toContainEqual({
        key: 'emailoctopus_api_key',
        value: '',
      })
      expect(credentialsTable.allFor('delete')).toHaveLength(0)
    })

    it.each([
      ['a replace with no value', { apiKey: { action: 'replace', value: '  ' }, listId: 'l' }],
      ['an unknown action', { apiKey: { action: 'reveal' }, listId: 'l' }],
      ['no list id', { apiKey: { action: 'unchanged' } }],
      ['an oversized key', { apiKey: { action: 'replace', value: 'x'.repeat(600) }, listId: 'l' }],
    ])('rejects %s', async (_label, body) => {
      mockGetSession.mockResolvedValue({ userId: 'u1', email: 'a@example.com', role: 'admin' })

      expect((await put(body)).status).toBe(400)
      expect(credentialsTable.allFor('upsert')).toHaveLength(0)
    })
  })
})
