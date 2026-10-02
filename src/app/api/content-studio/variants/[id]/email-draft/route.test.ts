/** @jest-environment node */
import { NextRequest } from 'next/server'

import { ContentDbError, ContentHttpError } from '@/lib/content-studio/errors'

const mockGetSession = jest.fn()
const mockServerClient = jest.fn()
const mockCreate = jest.fn()
const mockPropose = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockServerClient() }))
jest.mock('@/lib/marketing/studioEmail', () => ({
  createStudioEmail: (...args: unknown[]) => mockCreate(...args),
  proposeStudioEmail: (...args: unknown[]) => mockPropose(...args),
}))

import { POST as exportPost } from '../email-export/route'
import { GET, POST } from './route'

const VARIANT = '44444444-4444-4444-8444-444444444444'
const REVISION = '11111111-1111-4111-8111-111111111111'
const TEMPLATE = '22222222-2222-4222-8222-222222222222'

const BODY = {
  idempotencyKey: 'key-123456',
  revisionId: REVISION,
  templateId: TEMPLATE,
  campaignName: 'News',
  subject: 'Update',
  ctaMode: 'none',
  fields: { Preheader: 'p', Headline: 'h', Intro: 'i', Body: 'b', CtaLabel: '' },
  assets: [],
}

function context(id = VARIANT) {
  return { params: Promise.resolve({ id }) }
}

function request(body: unknown, path = 'email-draft') {
  return new NextRequest(`https://crm.example.com/api/content-studio/variants/${VARIANT}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const get = () => GET(new NextRequest(`https://crm.example.com/api/content-studio/variants/${VARIANT}/email-draft`), context())

describe('Content Studio email routes', () => {
  const env = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.CONTENT_STUDIO_ENABLED = 'true'
    process.env.CONTENT_EMAIL_BRIDGE_ENABLED = 'true'
    mockGetSession.mockResolvedValue({ userId: 'user-1', email: 'o@example.com', role: 'operator' })
    mockServerClient.mockResolvedValue({ db: true })
  })

  afterAll(() => {
    process.env = env
  })

  it('refuses a caller without a session before anything else', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await get()).status).toBe(401)
    expect((await POST(request(BODY), context())).status).toBe(401)
    expect((await exportPost(request(BODY, 'email-export'), context())).status).toBe(401)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('is off unless both the studio and the email bridge are enabled', async () => {
    process.env.CONTENT_EMAIL_BRIDGE_ENABLED = 'false'

    const response = await POST(request(BODY), context())
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'feature_disabled' })
    expect((await exportPost(request(BODY, 'email-export'), context())).status).toBe(404)
    expect((await get()).status).toBe(404)
  })

  it('404s an id that is not a uuid', async () => {
    expect((await GET(new NextRequest('https://crm.example.com/x'), context('nope'))).status).toBe(404)
    expect((await exportPost(request(BODY, 'email-export'), context('nope'))).status).toBe(404)
  })

  it('returns the proposal', async () => {
    mockPropose.mockResolvedValue({ variantId: VARIANT })

    const response = await get()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ proposal: { variantId: VARIANT } })
    expect(mockPropose).toHaveBeenCalledWith({ db: true }, VARIANT)
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/)
  })

  it('creates a draft (201) and answers a replay with 200', async () => {
    mockCreate.mockResolvedValueOnce({ campaignId: 'c1', snapshotId: 's1', created: true, contentHash: 'h', html: '<p>', text: 't' })

    const created = await POST(request(BODY), context())
    expect(created.status).toBe(201)
    await expect(created.json()).resolves.toEqual({ campaignId: 'c1', snapshotId: 's1', created: true, contentHash: 'h' })
    expect(mockCreate).toHaveBeenCalledWith({ db: true }, VARIANT, 'user-1', expect.objectContaining({ templateId: TEMPLATE }), 'campaign')

    mockCreate.mockResolvedValueOnce({ campaignId: 'c1', snapshotId: 's1', created: false, contentHash: 'h', html: '', text: '' })
    expect((await POST(request(BODY), context())).status).toBe(200)
  })

  it('validates the body', async () => {
    expect((await POST(request('not json'), context())).status).toBe(400)
    const response = await POST(request({ ...BODY, templateId: undefined }), context())
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'Choose an email template.' })
  })

  it('maps service errors', async () => {
    mockCreate.mockRejectedValueOnce(new ContentHttpError(409, 'stale', 'stale_revision'))
    const stale = await POST(request(BODY), context())
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ code: 'stale_revision' })

    mockCreate.mockRejectedValueOnce(new ContentDbError({ code: 'CRM07', message: 'Choose an active template.', hint: 'template_unavailable' }))
    expect((await POST(request(BODY), context())).status).toBe(422)

    mockPropose.mockRejectedValueOnce(new Error('boom'))
    expect((await get()).status).toBe(500)
  })

  it('exports HTML as a recorded export, never a delivery', async () => {
    mockCreate.mockResolvedValue({ campaignId: null, snapshotId: 's2', created: true, contentHash: 'h', html: '<html>', text: 'plain' })

    const response = await exportPost(request({ ...BODY, templateId: undefined, campaignName: undefined }, 'email-export'), context())

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ html: '<html>', text: 'plain', snapshotId: 's2', contentHash: 'h' })
    expect(mockCreate).toHaveBeenCalledWith({ db: true }, VARIANT, 'user-1', expect.objectContaining({ templateId: null }), 'export')
  })

  it('refuses a booking button on an export and maps export failures', async () => {
    expect((await exportPost(request({ ...BODY, ctaMode: 'booking' }, 'email-export'), context())).status).toBe(400)
    expect((await exportPost(request('x', 'email-export'), context())).status).toBe(400)

    mockCreate.mockRejectedValueOnce(new Error('boom'))
    expect((await exportPost(request(BODY, 'email-export'), context())).status).toBe(500)
  })
})
