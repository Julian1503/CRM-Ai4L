/** @jest-environment node */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockServerClient = jest.fn()
const mockAdmin = jest.fn()
const mockLib = {
  listItems: jest.fn(),
  createItem: jest.fn(),
  getItem: jest.fn(),
  updateItem: jest.fn(),
  findItemRow: jest.fn(),
  enqueueGeneration: jest.fn(),
  enqueueImageGeneration: jest.fn(),
  enqueueIngest: jest.fn(),
  getJob: jest.fn(),
  cancelJob: jest.fn(),
  resolveJob: jest.fn(),
  saveRevision: jest.fn(),
  duplicateVariant: jest.fn(),
  updateVariant: jest.fn(),
  reviewRevision: jest.fn(),
  exportVariant: jest.fn(),
  createUpload: jest.fn(),
  listAssets: jest.fn(),
  updateAsset: jest.fn(),
  findAssetRow: jest.fn(),
  getBrandProfile: jest.fn(),
  updateBrandProfile: jest.fn(),
}

type Lib = typeof mockLib
function mockForward(names: (keyof Lib)[]) {
  return Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => mockLib[name](...args)]))
}

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockServerClient() }))
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockAdmin() }))
jest.mock('@/lib/content-studio/repository', () => mockForward(['listItems', 'createItem', 'getItem', 'updateItem', 'findItemRow']))
jest.mock('@/lib/content-studio/jobs', () =>
  mockForward(['enqueueGeneration', 'enqueueImageGeneration', 'enqueueIngest', 'getJob', 'cancelJob', 'resolveJob'])
)
jest.mock('@/lib/content-studio/revisions', () => mockForward(['saveRevision', 'duplicateVariant', 'updateVariant']))
jest.mock('@/lib/content-studio/approvals', () => mockForward(['reviewRevision']))
jest.mock('@/lib/content-studio/variantExport', () => mockForward(['exportVariant']))
jest.mock('@/lib/content-studio/brand', () => mockForward(['getBrandProfile', 'updateBrandProfile']))
jest.mock('@/lib/content-studio/assets', () => mockForward(['createUpload', 'listAssets', 'updateAsset', 'findAssetRow']))

import { ContentDbError } from '@/lib/content-studio/errors'
import { assetRow, IDS, itemRow, SESSION } from '@/lib/content-studio/testFixtures'

import { PATCH as patchAsset } from './assets/[id]/route'
import { GET as getBrandRoute, PATCH as patchBrand } from './brand/route'
import { POST as ingest } from './assets/[id]/ingest/route'
import { GET as listAssetsRoute, POST as createUploadRoute } from './assets/route'
import { POST as generate } from './items/[id]/generate/route'
import { POST as images } from './items/[id]/images/route'
import { GET as getItemRoute, PATCH as patchItem } from './items/[id]/route'
import { GET as listItemsRoute, POST as createItemRoute } from './items/route'
import { POST as cancel } from './jobs/[id]/cancel/route'
import { POST as resolve } from './jobs/[id]/resolve/route'
import { GET as getJobRoute } from './jobs/[id]/route'
import { POST as duplicate } from './variants/[id]/duplicate/route'
import { GET as exportRoute } from './variants/[id]/export/route'
import { POST as revisions } from './variants/[id]/revisions/route'
import { POST as review } from './variants/[id]/review/route'
import { PATCH as patchVariant } from './variants/[id]/route'

const ORIGIN = 'https://crm.example.com'
const ORIGINAL_ENV = process.env
const DB = { tag: 'user-db' }
const ADMIN = { tag: 'admin-db' }
const KEY = 'key-12345678'

type AnyHandler = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>

function request(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`${ORIGIN}/api/content-studio${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json' },
  })
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

async function run(handler: AnyHandler, path: string, method = 'GET', body?: unknown, id: string = IDS.item) {
  const response = await handler(request(path, method, body), ctx(id))
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...ORIGINAL_ENV, CONTENT_STUDIO_ENABLED: 'true' }
  mockGetSession.mockResolvedValue(SESSION)
  mockServerClient.mockResolvedValue(DB)
  mockAdmin.mockReturnValue(ADMIN)
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

const EVERY_ROUTE: [string, AnyHandler, string][] = [
  ['GET brand', getBrandRoute as AnyHandler, 'GET'],
  ['PATCH brand', patchBrand as AnyHandler, 'PATCH'],
  ['GET items', listItemsRoute as AnyHandler, 'GET'],
  ['POST items', createItemRoute as AnyHandler, 'POST'],
  ['GET item', getItemRoute, 'GET'],
  ['PATCH item', patchItem, 'PATCH'],
  ['POST generate', generate, 'POST'],
  ['POST images', images, 'POST'],
  ['PATCH variant', patchVariant, 'PATCH'],
  ['POST revisions', revisions, 'POST'],
  ['POST duplicate', duplicate, 'POST'],
  ['POST review', review, 'POST'],
  ['GET export', exportRoute, 'GET'],
  ['GET assets', listAssetsRoute as AnyHandler, 'GET'],
  ['POST assets', createUploadRoute as AnyHandler, 'POST'],
  ['PATCH asset', patchAsset, 'PATCH'],
  ['POST ingest', ingest, 'POST'],
  ['GET job', getJobRoute, 'GET'],
  ['POST cancel', cancel, 'POST'],
  ['POST resolve', resolve, 'POST'],
]

describe('every content studio route', () => {
  it.each(EVERY_ROUTE)('%s refuses an unauthenticated request before touching the database', async (_name, handler, method) => {
    mockGetSession.mockResolvedValue(null)

    const result = await run(handler, '/x', method, method === 'GET' ? undefined : {})

    expect(result.status).toBe(401)
    expect(mockServerClient).not.toHaveBeenCalled()
  })

  it.each(EVERY_ROUTE)('%s answers 404 feature_disabled while the studio is off', async (_name, handler, method) => {
    process.env = { ...ORIGINAL_ENV, CONTENT_STUDIO_ENABLED: '' }
    // The brand PATCH refuses an operator (403) before anything else; an administrator sees the flag.
    mockGetSession.mockResolvedValue({ ...SESSION, role: 'admin' })

    const result = await run(handler, '/x', method, method === 'GET' ? undefined : {})

    expect(result).toMatchObject({ status: 404, body: { code: 'feature_disabled' } })
    expect(mockServerClient).not.toHaveBeenCalled()
  })

  it.each(EVERY_ROUTE.filter(([name]) => !['GET brand', 'PATCH brand', 'GET items', 'POST items', 'GET assets', 'POST assets'].includes(name)))(
    '%s answers 404 for an id that is not a UUID',
    async (_name, handler, method) => {
      const result = await run(handler, '/x', method, method === 'GET' ? undefined : {}, 'not-a-uuid')
      expect(result.status).toBe(404)
    }
  )
})

describe('items', () => {
  it('lists with bounded search, status and paging', async () => {
    mockLib.listItems.mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 10 })

    const result = await run(listItemsRoute as AnyHandler, `/items?search=${'a'.repeat(300)}&status=archived&page=2&pageSize=10`)

    expect(result.status).toBe(200)
    expect(mockLib.listItems).toHaveBeenCalledWith(DB, { page: 2, pageSize: 10, search: 'a'.repeat(200), status: 'archived' })

    await run(listItemsRoute as AnyHandler, '/items?status=weird')
    expect(mockLib.listItems.mock.calls[1][1]).toMatchObject({ search: null, status: 'active', pageSize: 20 })
  })

  it('creates an item as the session user (201) and validates the body', async () => {
    mockLib.createItem.mockResolvedValue({ id: IDS.item })
    const body = { title: 'Launch', brief: { topic: 'AI' }, channels: ['linkedin'] }

    expect(await run(createItemRoute as AnyHandler, '/items', 'POST', body)).toEqual({ status: 201, body: { item: { id: IDS.item } } })
    expect(mockLib.createItem).toHaveBeenCalledWith(DB, IDS.user, body)

    expect((await run(createItemRoute as AnyHandler, '/items', 'POST', { title: 'x' })).status).toBe(400)
    expect((await run(createItemRoute as AnyHandler, '/items', 'POST', 'not json')).body).toEqual({ error: 'Expected a JSON object.' })
  })

  it('reads and patches an item, 404 when missing', async () => {
    mockLib.getItem.mockResolvedValueOnce({ id: IDS.item }).mockResolvedValueOnce(null)
    expect((await run(getItemRoute, `/items/${IDS.item}`)).body).toEqual({ item: { id: IDS.item } })
    expect((await run(getItemRoute, `/items/${IDS.item}`)).status).toBe(404)

    mockLib.updateItem.mockResolvedValueOnce({ id: IDS.item }).mockResolvedValueOnce(null)
    expect((await run(patchItem, `/items/${IDS.item}`, 'PATCH', { archived: true })).status).toBe(200)
    expect(mockLib.updateItem).toHaveBeenCalledWith(DB, IDS.item, IDS.user, { archived: true })
    expect((await run(patchItem, `/items/${IDS.item}`, 'PATCH', { archived: true })).status).toBe(404)
    expect((await run(patchItem, `/items/${IDS.item}`, 'PATCH', {})).status).toBe(400)
  })

  it('queues generation and images with 202', async () => {
    mockLib.findItemRow.mockResolvedValue(itemRow())
    mockLib.enqueueGeneration.mockResolvedValue({ id: IDS.job })
    mockLib.enqueueImageGeneration.mockResolvedValue({ id: IDS.job })

    expect(await run(generate, '/g', 'POST', { idempotencyKey: KEY, channels: ['linkedin'] })).toEqual({ status: 202, body: { job: { id: IDS.job } } })
    expect(mockLib.enqueueGeneration).toHaveBeenCalledWith(DB, itemRow(), { idempotencyKey: KEY, channels: ['linkedin'], stylesPerChannel: 1 })
    expect((await run(images, '/i', 'POST', { idempotencyKey: KEY, prompt: 'p', count: 1 })).status).toBe(202)

    mockLib.findItemRow.mockResolvedValue(null)
    expect((await run(generate, '/g', 'POST', { idempotencyKey: KEY, channels: ['linkedin'] })).status).toBe(404)
    expect((await run(images, '/i', 'POST', { idempotencyKey: KEY, prompt: 'p', count: 1 })).status).toBe(404)
  })

  it('maps database refusals to their status and code', async () => {
    mockLib.findItemRow.mockResolvedValue(itemRow())
    mockLib.enqueueGeneration.mockRejectedValue(new ContentDbError({ code: 'CRM06', message: 'Idempotency key reused for another job.' }))

    expect(await run(generate, '/g', 'POST', { idempotencyKey: KEY, channels: ['linkedin'] })).toEqual({
      status: 409,
      body: { error: 'Idempotency key reused for another job.' },
    })
  })
})

describe('variants', () => {
  it('saves a revision (201) and surfaces stale_revision as 409 with its code', async () => {
    mockLib.saveRevision.mockResolvedValueOnce({ id: IDS.revision })
    const body = { idempotencyKey: KEY, expectedRevisionId: IDS.revision, content: { body: 'x' } }

    expect(await run(revisions, '/r', 'POST', body, IDS.variant)).toEqual({ status: 201, body: { revision: { id: IDS.revision } } })

    mockLib.saveRevision.mockRejectedValueOnce(new ContentDbError({ code: 'CRM06', hint: 'stale_revision', message: 'changed' }))
    expect(await run(revisions, '/r', 'POST', body, IDS.variant)).toEqual({ status: 409, body: { error: 'changed', code: 'stale_revision' } })
  })

  it('duplicates, reviews and exports', async () => {
    mockLib.duplicateVariant.mockResolvedValue({ id: 'v2' })
    mockLib.reviewRevision.mockResolvedValue({ id: 'r1' })
    mockLib.exportVariant.mockResolvedValue({ text: 't' })

    expect((await run(duplicate, '/d', 'POST', { idempotencyKey: KEY }, IDS.variant)).status).toBe(201)
    expect((await run(review, '/r', 'POST', { revisionId: IDS.revision, decision: 'approved' }, IDS.variant)).body).toEqual({ review: { id: 'r1' } })
    expect(mockLib.reviewRevision).toHaveBeenCalledWith(DB, IDS.variant, { revisionId: IDS.revision, decision: 'approved' })
    expect((await run(exportRoute, '/e', 'GET', undefined, IDS.variant)).body).toEqual({ export: { text: 't' } })
    expect(mockLib.exportVariant).toHaveBeenCalledWith(DB, IDS.variant)
  })
})

describe('brand profile', () => {
  const BRAND = { id: 'b1', slug: 'ai4l', name: 'AI4L' }

  it('lets every member read it and says whether they may edit', async () => {
    mockLib.getBrandProfile.mockResolvedValue(BRAND)

    expect(await run(getBrandRoute as AnyHandler, '/brand')).toEqual({ status: 200, body: { brand: BRAND, canEdit: false } })
    mockGetSession.mockResolvedValue({ ...SESSION, role: 'admin' })
    expect((await run(getBrandRoute as AnyHandler, '/brand')).body).toEqual({ brand: BRAND, canEdit: true })
  })

  it('refuses an operator with 403 before touching the database', async () => {
    const result = await run(patchBrand as AnyHandler, '/brand', 'PATCH', { tone: 'x' })

    expect(result).toEqual({ status: 403, body: { error: 'Only an administrator can change the brand profile.' } })
    expect(mockServerClient).not.toHaveBeenCalled()
  })

  it('saves a valid update for an administrator and maps database validation to 400 with its code', async () => {
    mockGetSession.mockResolvedValue({ ...SESSION, role: 'admin' })
    mockLib.updateBrandProfile.mockResolvedValueOnce({ ...BRAND, tone: 'Plain' })

    expect(await run(patchBrand as AnyHandler, '/brand', 'PATCH', { tone: 'Plain' })).toEqual({
      status: 200,
      body: { brand: { ...BRAND, tone: 'Plain' }, canEdit: true },
    })
    expect(mockLib.updateBrandProfile).toHaveBeenCalledWith(DB, { tone: 'Plain' })

    expect((await run(patchBrand as AnyHandler, '/brand', 'PATCH', {})).status).toBe(400)

    mockLib.updateBrandProfile.mockRejectedValueOnce(new ContentDbError({ code: 'CRM07', hint: 'invalid_origin', message: 'Bad origin.' }))
    expect(await run(patchBrand as AnyHandler, '/brand', 'PATCH', { tone: 'x' })).toEqual({
      status: 400,
      body: { error: 'Bad origin.', code: 'invalid_origin' },
    })
  })
})

describe('variant archive', () => {
  it('archives a variant and answers { variant }, 404 when missing, 400 without a boolean', async () => {
    mockLib.updateVariant.mockResolvedValueOnce({ id: IDS.variant, archivedAt: 'now' }).mockResolvedValueOnce(null)

    expect(await run(patchVariant, '/v', 'PATCH', { archived: true }, IDS.variant)).toEqual({
      status: 200,
      body: { variant: { id: IDS.variant, archivedAt: 'now' } },
    })
    expect(mockLib.updateVariant).toHaveBeenCalledWith(DB, IDS.variant, IDS.user, { archived: true })
    expect((await run(patchVariant, '/v', 'PATCH', { archived: false }, IDS.variant)).status).toBe(404)
    expect(await run(patchVariant, '/v', 'PATCH', { archived: 'yes' }, IDS.variant)).toEqual({
      status: 400,
      body: { error: 'archived must be true or false.' },
    })
  })
})

describe('assets', () => {
  it('lists with an item filter only when it is a UUID', async () => {
    mockLib.listAssets.mockResolvedValue({ assets: [], total: 0 })

    await run(listAssetsRoute as AnyHandler, `/assets?itemId=${IDS.item}&status=archived`)
    await run(listAssetsRoute as AnyHandler, '/assets?itemId=nope')

    expect(mockLib.listAssets.mock.calls[0]).toEqual([DB, { page: 1, pageSize: 40, itemId: IDS.item, status: 'archived' }])
    expect(mockLib.listAssets.mock.calls[1][1]).toMatchObject({ itemId: null, status: 'active' })
  })

  it('creates an upload (201) and validates the file', async () => {
    mockLib.createUpload.mockResolvedValue({ asset: { id: IDS.asset }, upload: { path: 'p' } })
    const body = { filename: 'a.png', mimeType: 'image/png', byteSize: 10 }

    expect((await run(createUploadRoute as AnyHandler, '/assets', 'POST', body)).status).toBe(201)
    expect(mockLib.createUpload).toHaveBeenCalledWith(DB, IDS.user, body)
    expect((await run(createUploadRoute as AnyHandler, '/assets', 'POST', { ...body, mimeType: 'text/html' })).status).toBe(400)
  })

  it('patches an asset and queues ingestion, 404 when missing', async () => {
    mockLib.updateAsset.mockResolvedValueOnce({ id: IDS.asset }).mockResolvedValueOnce(null)
    expect((await run(patchAsset, '/a', 'PATCH', { altText: 'x' }, IDS.asset)).status).toBe(200)
    expect((await run(patchAsset, '/a', 'PATCH', { altText: 'x' }, IDS.asset)).status).toBe(404)

    mockLib.findAssetRow.mockResolvedValueOnce(assetRow({ ingest_status: 'pending' })).mockResolvedValueOnce(null)
    mockLib.enqueueIngest.mockResolvedValue({ id: IDS.job })
    expect(await run(ingest, '/i', 'POST', undefined, IDS.asset)).toEqual({ status: 202, body: { job: { id: IDS.job } } })
    expect((await run(ingest, '/i', 'POST', undefined, IDS.asset)).status).toBe(404)
  })
})

describe('jobs', () => {
  it('reads, cancels and resolves jobs', async () => {
    mockLib.getJob.mockResolvedValueOnce({ id: IDS.job }).mockResolvedValueOnce(null)
    mockLib.cancelJob.mockResolvedValue({ id: IDS.job, status: 'cancelled' })
    mockLib.resolveJob.mockResolvedValue({ id: IDS.job, status: 'succeeded' })

    expect((await run(getJobRoute, '/j', 'GET', undefined, IDS.job)).body).toEqual({ job: { id: IDS.job } })
    expect((await run(getJobRoute, '/j', 'GET', undefined, IDS.job)).status).toBe(404)
    expect((await run(cancel, '/c', 'POST', undefined, IDS.job)).body).toEqual({ job: { id: IDS.job, status: 'cancelled' } })
    expect((await run(resolve, '/r', 'POST', { resolution: 'succeeded', note: 'seen' }, IDS.job)).status).toBe(200)
    expect(mockLib.resolveJob).toHaveBeenCalledWith(DB, IDS.job, { resolution: 'succeeded', note: 'seen' })
    expect((await run(resolve, '/r', 'POST', { resolution: 'x', note: 'seen' }, IDS.job)).status).toBe(400)
  })

  it('hides unexpected failures behind the route message', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockLib.cancelJob.mockRejectedValue(new Error('connection reset'))

    try {
      expect(await run(cancel, '/c', 'POST', undefined, IDS.job)).toEqual({ status: 500, body: { error: 'Could not cancel the job.' } })
    } finally {
      spy.mockRestore()
    }
  })
})
