/**
 * @jest-environment node
 *
 * Template contracts through the registry and the provider field check.
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockListTags = jest.fn()
const mockCreateField = jest.fn()
const mockCredentials = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockCreateServerClient() }))
jest.mock('@/lib/marketing/providers/emailOctopus', () => ({
  listMergeTags: (...args: unknown[]) => mockListTags(...args),
  createMergeField: (...args: unknown[]) => mockCreateField(...args),
}))
jest.mock('@/lib/marketing/providers/credentials', () => ({ loadEmailOctopusCredentials: () => mockCredentials() }))

import { GET as getFields, POST as postFields } from '../integrations/emailoctopus/fields/route'
import { PATCH } from './[id]/route'
import { POST } from './route'

function withBuilder(response: unknown) {
  const builder = createQueryBuilderMock(response)
  mockCreateServerClient.mockResolvedValue(createDbMock(builder))
  return builder
}

const REGISTRATION = { name: 'Studio news', providerAutomationId: 'auto-1', consentStream: 'newsletter' }

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com' })
  mockCredentials.mockResolvedValue({ apiKey: 'k', listId: 'l' })
})

describe('registering a template with a contract', () => {
  it('pins the chosen contract and mirrors its slots', async () => {
    const builder = withBuilder({ data: { id: 't1' }, error: null })

    await POST(new NextRequest('https://crm/api/templates', { method: 'POST', body: JSON.stringify({ ...REGISTRATION, contractId: 'studio-static-v1' }) }))

    const [row] = builder.argsFor('insert') as [Record<string, unknown>]
    expect(row).toMatchObject({ contract_id: 'studio-static-v1', contract_version: 1, slots: [expect.objectContaining({ tag: 'PrefsUrl' })] })
  })

  it('defaults to legacy-v1 and refuses an unknown contract', async () => {
    const builder = withBuilder({ data: { id: 't1' }, error: null })
    await POST(new NextRequest('https://crm/api/templates', { method: 'POST', body: JSON.stringify(REGISTRATION) }))
    expect((builder.argsFor('insert') as [Record<string, unknown>])[0]).toMatchObject({ contract_id: 'legacy-v1' })

    const response = await POST(new NextRequest('https://crm/api/templates', { method: 'POST', body: JSON.stringify({ ...REGISTRATION, contractId: 'nope' }) }))
    expect(response.status).toBe(400)
  })
})

describe('changing a template contract', () => {
  function patch(body: unknown) {
    return PATCH(new NextRequest('https://crm/api/templates/t1', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 't1' }) })
  }

  it('is allowed while unused', async () => {
    const builder = withBuilder({ data: { id: 't1' }, error: null })

    expect((await patch({ contractId: 'studio-newsletter-v1' })).status).toBe(200)
    expect((builder.argsFor('update') as [Record<string, unknown>])[0]).toMatchObject({ contract_id: 'studio-newsletter-v1', contract_version: 1 })
  })

  it('answers 409 when campaigns use the template (CRM06)', async () => {
    withBuilder({ data: null, error: { code: 'CRM06', message: 'in use', hint: 'template_in_use' } })

    const response = await patch({ contractId: 'studio-static-v1' })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/used by campaigns/) })
  })

  it('refuses an unknown contract', async () => {
    withBuilder({ data: null, error: null })
    expect((await patch({ contractId: 'x' })).status).toBe(400)
  })
})

describe('provider fields for a template', () => {
  function fieldsRequest(templateId?: string, method = 'GET') {
    return new NextRequest(`https://crm/api/integrations/emailoctopus/fields${templateId ? `?templateId=${templateId}` : ''}`, { method })
  }

  it('checks the fields the template contract needs', async () => {
    withBuilder({ data: { id: 't1', contract_id: 'studio-static-v1', contract_version: 1, removed_at: null }, error: null })
    mockListTags.mockResolvedValue({ ok: true, tags: ['PrefsUrl'] })

    const body = await (await getFields(fieldsRequest('t1'))).json()

    expect(body).toMatchObject({ contract: 'studio-static-v1', required: ['PrefsUrl', 'Newsletter', 'Courses'], missing: ['Newsletter', 'Courses'], ready: false })
  })

  it('creates only those fields', async () => {
    withBuilder({ data: { id: 't1', contract_id: 'studio-static-v1', contract_version: 1, removed_at: null }, error: null })
    mockListTags.mockResolvedValue({ ok: true, tags: ['PrefsUrl', 'Newsletter'] })
    mockCreateField.mockResolvedValue({ ok: true })

    const body = await (await postFields(fieldsRequest('t1', 'POST'))).json()

    expect(body).toEqual({ created: ['Courses'], failed: [], ready: true })
    expect(mockCreateField).toHaveBeenCalledWith(expect.objectContaining({ tag: 'Courses', label: 'Subscribed to courses' }))
  })

  it('refuses an unknown template, and a template on an unknown contract', async () => {
    withBuilder({ data: null, error: null })
    expect((await getFields(fieldsRequest('t9'))).status).toBe(400)

    withBuilder({ data: { id: 't1', contract_id: 'future-v1', contract_version: 1, removed_at: null }, error: null })
    expect((await postFields(fieldsRequest('t1', 'POST'))).status).toBe(409)
  })
})
