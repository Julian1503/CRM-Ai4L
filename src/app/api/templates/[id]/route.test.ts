/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { PATCH } from './route'

function withBuilder(response: unknown) {
  const builder = createQueryBuilderMock(response)
  mockCreateServerClient.mockResolvedValue(createDbMock(builder))
  return builder
}

function patch(body: unknown, id = 't1') {
  return PATCH(
    new NextRequest(`https://crm.example.com/api/templates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

describe('PATCH /api/templates/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    withBuilder({ data: { id: 't1', name: 'August' }, error: null })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await patch({ name: 'x' })).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('renames a template', async () => {
    const builder = withBuilder({ data: { id: 't1' }, error: null })

    await patch({ name: '  September intake  ' })

    expect(builder.argsFor('update')?.[0]).toMatchObject({ name: 'September intake' })
    expect(builder.argsFor('eq')).toEqual(['id', 't1'])
  })

  it('re-points a template at another automation', async () => {
    const builder = withBuilder({ data: { id: 't1' }, error: null })

    await patch({ providerAutomationId: ' auto-2 ' })

    expect(builder.argsFor('update')?.[0]).toMatchObject({
      provider_automation_id: 'auto-2',
    })
  })

  it('moves a template to the other stream', async () => {
    const builder = withBuilder({ data: { id: 't1' }, error: null })

    await patch({ consentStream: 'programs' })

    expect(builder.argsFor('update')?.[0]).toMatchObject({ consent_stream: 'programs' })
  })

  it('refuses a stream it does not recognise instead of guessing', async () => {
    const response = await patch({ consentStream: 'courses' })

    expect(response.status).toBe(400)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('archives and un-archives rather than deleting', async () => {
    // A sent campaign still points at its template; deleting the row would leave its
    // copy uninterpretable, which is why the table grants no delete policy.
    const LIVE = { id: 't1', name: 'August', archived_at: null, removed_at: null }
    const ARCHIVED = { ...LIVE, archived_at: '2026-09-01T00:00:00.000Z' }

    // Loaded, checked for live schedules, then written.
    const archiving = withBuilder([
      { data: LIVE, error: null },
      { data: [], error: null },
      { data: { id: 't1' }, error: null },
    ])
    expect((await patch({ archived: true })).status).toBe(200)
    expect(archiving.argsFor('update')?.[0]).toMatchObject({
      archived_at: expect.any(String),
    })

    const restoring = withBuilder([{ data: ARCHIVED, error: null }, { data: { id: 't1' }, error: null }])
    expect((await patch({ archived: false })).status).toBe(200)
    expect(restoring.argsFor('update')?.[0]).toMatchObject({ archived_at: null })

    const removing = withBuilder([{ data: ARCHIVED, error: null }, { data: { id: 't1' }, error: null }])
    expect((await patch({ removed: true })).status).toBe(200)
    expect(removing.argsFor('update')?.[0]).toMatchObject({ removed_at: expect.any(String), removed_by: 'u1' })
    expect(removing.argsFor('delete')).toBeUndefined()
  })

  it('refuses to archive a template a live schedule drafts with, naming it', async () => {
    const builder = withBuilder([
      { data: { id: 't1', name: 'August', archived_at: null, removed_at: null }, error: null },
      { data: [{ name: 'Monthly' }], error: null },
    ])

    const response = await patch({ archived: true })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('"Monthly"')
    expect(builder.argsFor('update')).toBeUndefined()
  })

  it('treats a removed template as not found', async () => {
    withBuilder({ data: { id: 't1', name: 'x', archived_at: 'a', removed_at: 'b' }, error: null })

    expect((await patch({ archived: false })).status).toBe(404)
  })

  it('refuses an archive flag mixed with an edit', async () => {
    expect((await patch({ archived: true, name: 'x' })).status).toBe(400)
  })

  it('refuses to blank a name or an automation id', async () => {
    expect((await patch({ name: '   ' })).status).toBe(400)
    expect((await patch({ providerAutomationId: '' })).status).toBe(400)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('rejects a patch that would change nothing', async () => {
    const response = await patch({ unknownField: 'x' })

    expect(response.status).toBe(400)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('answers 404 for a template that does not exist', async () => {
    withBuilder({ data: null, error: null })

    expect((await patch({ name: 'x' })).status).toBe(404)
  })

  it('reports a name clash as a conflict', async () => {
    withBuilder({ data: null, error: { code: '23505', message: 'duplicate key' } })

    expect((await patch({ name: 'August' })).status).toBe(409)
  })

  it('stamps updated_at, which no trigger maintains for this table', async () => {
    const builder = withBuilder({ data: { id: 't1' }, error: null })

    await patch({ name: 'x' })

    expect(builder.argsFor('update')?.[0]).toMatchObject({ updated_at: expect.any(String) })
  })
})
