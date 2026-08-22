/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import {
  BOOKING_URL_MERGE_FIELD,
  CAMPAIGN_COPY_FIELDS,
} from '@/lib/marketing/mergeFields'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockListTags = jest.fn()
const mockCreateField = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))
jest.mock('@/lib/marketing/providers/emailOctopus', () => ({
  listMergeTags: (...args: unknown[]) => mockListTags(...args),
  createMergeField: (...args: unknown[]) => mockCreateField(...args),
}))

import { GET, POST } from './route'

const ALL_TAGS = [
  'EmailAddress',
  'FirstName',
  'LastName',
  ...CAMPAIGN_COPY_FIELDS.map((field) => field.tag),
  BOOKING_URL_MERGE_FIELD,
]

function withCredentials(
  rows: { key: string; value: string }[] = [
    { key: 'emailoctopus_api_key', value: 'eo-key' },
    { key: 'emailoctopus_list_id', value: 'list-1' },
  ]
) {
  mockCreateServerClient.mockResolvedValue(
    createDbMock(createQueryBuilderMock({ data: rows, error: null }))
  )
}

function post() {
  return POST(
    new NextRequest('https://crm.example.com/api/integrations/emailoctopus/fields', {
      method: 'POST',
    })
  )
}

describe('/api/integrations/emailoctopus/fields', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    withCredentials()
    mockListTags.mockResolvedValue({ ok: true, tags: ALL_TAGS })
    mockCreateField.mockResolvedValue({ ok: true })
  })

  describe('GET', () => {
    it('refuses an unauthenticated request', async () => {
      mockGetSession.mockResolvedValue(null)

      expect((await GET()).status).toBe(401)
      expect(mockListTags).not.toHaveBeenCalled()
    })

    it('reports a fully configured list as ready', async () => {
      const body = await (await GET()).json()

      expect(body.ready).toBe(true)
      expect(body.missing).toEqual([])
    })

    it('names every missing tag, which is the silent failure this catches', async () => {
      mockListTags.mockResolvedValue({
        ok: true,
        tags: ['EmailAddress', 'FirstName', 'LastName'],
      })

      const body = await (await GET()).json()

      expect(body.ready).toBe(false)
      expect(body.missing).toContain(BOOKING_URL_MERGE_FIELD)
      expect(body.missing).toContain('Headline')
    })

    it('refuses when EmailOctopus is not configured', async () => {
      withCredentials([])

      expect((await GET()).status).toBe(409)
    })

    it('surfaces a provider read failure', async () => {
      mockListTags.mockResolvedValue({ ok: false, error: 'Resource not found.' })

      const response = await GET()

      expect(response.status).toBe(500)
      expect((await response.json()).error).toContain('Resource not found.')
    })

    it('is not cacheable — it reflects live provider state', async () => {
      expect((await GET()).headers.get('Cache-Control')).toBe('private, no-store')
    })
  })

  describe('POST', () => {
    it('refuses an unauthenticated request', async () => {
      mockGetSession.mockResolvedValue(null)

      expect((await post()).status).toBe(401)
      expect(mockCreateField).not.toHaveBeenCalled()
    })

    it('creates only what is missing', async () => {
      mockListTags.mockResolvedValue({
        ok: true,
        tags: [...ALL_TAGS.filter((tag) => tag !== 'Headline')],
      })

      const body = await (await post()).json()

      expect(mockCreateField).toHaveBeenCalledTimes(1)
      expect(body.created).toEqual(['Headline'])
    })

    it('does nothing when the list is already complete', async () => {
      const body = await (await post()).json()

      expect(mockCreateField).not.toHaveBeenCalled()
      expect(body.created).toEqual([])
      expect(body.ready).toBe(true)
    })

    it('labels the booking link rather than falling back to its tag', async () => {
      mockListTags.mockResolvedValue({
        ok: true,
        tags: ALL_TAGS.filter((tag) => tag !== BOOKING_URL_MERGE_FIELD),
      })

      await post()

      expect(mockCreateField).toHaveBeenCalledWith(
        expect.objectContaining({ tag: BOOKING_URL_MERGE_FIELD, label: 'Booking link' })
      )
    })

    it('keeps going after one field fails, and reports which', async () => {
      mockListTags.mockResolvedValue({ ok: true, tags: ['EmailAddress'] })
      mockCreateField
        .mockResolvedValueOnce({ ok: false, error: 'Unprocessable content.' })
        .mockResolvedValue({ ok: true })

      const body = await (await post()).json()

      expect(body.ready).toBe(false)
      expect(body.failed).toHaveLength(1)
      expect(body.created.length).toBeGreaterThan(0)
    })
  })
})
