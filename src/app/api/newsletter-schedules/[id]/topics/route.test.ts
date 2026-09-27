/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { DELETE, PATCH } from './[topicId]/route'
import { GET, POST } from './route'

const params = { params: Promise.resolve({ id: 's1' }) }

function setup(topics: unknown[], schedule: unknown = { id: 's1' }) {
  const tables: Record<string, QueryBuilderMock> = {
    newsletter_schedules: createQueryBuilderMock({ data: schedule, error: null }),
    newsletter_topics: createQueryBuilderMock(topics),
  }
  mockCreateServerClient.mockResolvedValue(createDbMock((table: string) => tables[table]))
  return tables
}

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/newsletter-schedules/s1/topics', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    params
  )
}

describe('newsletter topics', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('refuses unauthenticated requests', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ title: 'x' })).status).toBe(401)
  })

  it('lists the queue before the history', async () => {
    const tables = setup([{ data: [], error: null }])

    await GET(new NextRequest('https://crm.example.com/api/newsletter-schedules/s1/topics'), params)

    expect(tables.newsletter_topics.argsFor('order')).toEqual([
      'used_at',
      { ascending: false, nullsFirst: true },
    ])
  })

  it('adds a topic to the back of the queue', async () => {
    const tables = setup([
      { data: { position: 4 }, error: null },
      { data: { id: 't9' }, error: null },
    ])

    const response = await post({ title: ' AI in onboarding ', details: 'Two examples' })

    expect(response.status).toBe(200)
    expect(tables.newsletter_topics.argsFor('insert')?.[0]).toEqual({
      schedule_id: 's1',
      title: 'AI in onboarding',
      details: 'Two examples',
      position: 5,
    })
  })

  it('requires a title', async () => {
    setup([])

    expect((await post({ details: 'x' })).status).toBe(400)
  })

  it('answers 404 for an unknown schedule', async () => {
    setup([], null)

    expect((await post({ title: 'x' })).status).toBe(404)
  })

  it('will not delete a topic that has already been used', async () => {
    const tables = setup([{ data: [], error: null }])

    const response = await DELETE(
      new NextRequest('https://crm.example.com/api/newsletter-schedules/s1/topics/t1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 's1', topicId: 't1' }) }
    )

    expect(response.status).toBe(409)
    expect(tables.newsletter_topics.argsFor('is')).toEqual(['used_at', null])
  })

  describe('editing a queued topic', () => {
    function patch(body: unknown) {
      return PATCH(
        new NextRequest('https://crm.example.com/api/newsletter-schedules/s1/topics/t1', {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: 's1', topicId: 't1' }) }
      )
    }

    it('refuses an unauthenticated request', async () => {
      mockGetSession.mockResolvedValue(null)

      expect((await patch({ title: 'x' })).status).toBe(401)
    })

    it('moves a topic up the queue', async () => {
      const tables = setup([{ data: { id: 't1', position: 0 }, error: null }])

      expect((await patch({ position: 0 })).status).toBe(200)
      expect(tables.newsletter_topics.argsFor('update')?.[0]).toEqual({ position: 0 })
      expect(tables.newsletter_topics.argsFor('is')).toEqual(['used_at', null])
    })

    it('will not rewrite a topic an issue was already written about', async () => {
      setup([{ data: null, error: null }])

      expect((await patch({ title: 'Rewritten' })).status).toBe(409)
    })

    it('rejects an empty edit', async () => {
      setup([])

      expect((await patch({})).status).toBe(400)
    })
  })

  it('removes an unused topic', async () => {
    setup([{ data: [{ id: 't1' }], error: null }])

    const response = await DELETE(
      new NextRequest('https://crm.example.com/api/newsletter-schedules/s1/topics/t1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 's1', topicId: 't1' }) }
    )

    expect(response.status).toBe(200)
  })
})
