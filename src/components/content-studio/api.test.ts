import * as api from './api'
import { ApiError, errorMessage, isUnavailable } from './api'
import { bodyOf, errorResponse, jsonResponse, makeItem, makeJob, routeFetch } from './testUtils'

describe('content studio api client', () => {
  it('lists items with only the query params that are set', async () => {
    const mock = routeFetch({ 'GET /api/content-studio/items': jsonResponse({ items: [], total: 0, page: 1, pageSize: 25 }) })

    await api.listItems({ search: 'spring', status: 'active', page: 2 })
    await api.listItems()

    expect(mock.mock.calls[0][0]).toBe('/api/content-studio/items?search=spring&status=active&page=2')
    expect(mock.mock.calls[1][0]).toBe('/api/content-studio/items')
  })

  it('unwraps the documented envelopes', async () => {
    const item = makeItem()
    const job = makeJob()
    const mock = routeFetch({
      'POST /api/content-studio/items': jsonResponse({ item }, 201),
      'GET /api/content-studio/items/item-1': jsonResponse({ item }),
      'PATCH /api/content-studio/items/item-1': jsonResponse({ item }),
      'POST /api/content-studio/items/item-1/generate': jsonResponse({ job }, 202),
      'POST /api/content-studio/items/item-1/images': jsonResponse({ job }, 202),
      'POST /api/content-studio/variants/var-1/revisions': jsonResponse({ revision: { id: 'rev-2' } }, 201),
      'POST /api/content-studio/variants/var-1/duplicate': jsonResponse({ variant: { id: 'var-2' } }, 201),
      'POST /api/content-studio/variants/var-1/review': jsonResponse({ review: {} }, 201),
      'PATCH /api/content-studio/variants/var-1': jsonResponse({}),
      'GET /api/content-studio/variants/var-1/export': jsonResponse({ export: { text: 'hi' } }),
      'POST /api/content-studio/assets/asset-1/ingest': jsonResponse({ job }, 202),
      'GET /api/content-studio/jobs/job-1': jsonResponse({ job }),
      'POST /api/content-studio/jobs/job-1/cancel': jsonResponse({ job }),
      'POST /api/content-studio/jobs/job-1/resolve': jsonResponse({ job }),
    })

    await expect(api.createItem({ title: 't', brief: { topic: 'x' }, channels: ['email'] })).resolves.toEqual(item)
    await expect(api.getItem('item-1')).resolves.toEqual(item)
    await expect(api.updateItem('item-1', { archived: true })).resolves.toEqual(item)
    await expect(api.generate('item-1', { idempotencyKey: 'k', channels: ['facebook'] })).resolves.toEqual(job)
    await expect(api.generateImages('item-1', { idempotencyKey: 'k', prompt: 'p', count: 2 })).resolves.toEqual(job)
    await expect(
      api.saveRevision('var-1', {
        idempotencyKey: 'k',
        expectedRevisionId: 'rev-1',
        content: { body: '', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] },
      })
    ).resolves.toEqual({ id: 'rev-2' })
    await expect(api.duplicateVariant('var-1', { idempotencyKey: 'k' })).resolves.toEqual({ id: 'var-2' })
    await expect(api.reviewRevision('var-1', { revisionId: 'rev-1', decision: 'approved' })).resolves.toBeUndefined()
    await expect(api.setVariantArchived('var-1', true)).resolves.toBeUndefined()
    await expect(api.exportVariant('var-1')).resolves.toEqual({ text: 'hi' })
    await expect(api.ingestAsset('asset-1')).resolves.toEqual(job)
    await expect(api.getJob('job-1')).resolves.toEqual(job)
    await expect(api.cancelJob('job-1')).resolves.toEqual(job)
    await expect(api.resolveJob('job-1', { resolution: 'failed', note: 'n' })).resolves.toEqual(job)

    expect(bodyOf(mock, 'PATCH', '/api/content-studio/variants/var-1')).toEqual({ archived: true })
    expect(bodyOf(mock, 'POST', '/api/content-studio/items/item-1/generate')).toEqual({ idempotencyKey: 'k', channels: ['facebook'] })
    const [, init] = mock.mock.calls[0]
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('accepts a bare body when a route skips the envelope', async () => {
    routeFetch({ 'POST /api/social/publications/preflight': jsonResponse({ ok: true, issues: [] }) })

    await expect(api.preflightPublication({ revisionId: 'r', accountId: 'a', idempotencyKey: 'k' })).resolves.toEqual({ ok: true, issues: [] })
  })

  it('reads assets, uploads and accounts', async () => {
    const mock = routeFetch({
      'GET /api/content-studio/assets': jsonResponse({ assets: [], total: 0 }),
      'POST /api/content-studio/assets': jsonResponse({ asset: { id: 'a' }, upload: { signedUrl: 'https://s/u', token: 't', path: 'p' } }, 201),
      'GET /api/social/accounts': jsonResponse({ accounts: [{ id: 'acct' }], enabledPlatforms: ['facebook'] }),
      'POST /api/social/publications': jsonResponse({ publication: { id: 'pub' } }, 202),
      'GET /api/social/publications': jsonResponse({ publications: [{ id: 'pub' }] }),
    })

    await api.listAssets({ itemId: 'item-1', pageSize: 10 })
    expect(mock.mock.calls[0][0]).toBe('/api/content-studio/assets?itemId=item-1&pageSize=10')
    await expect(api.createUpload({ filename: 'a.png', mimeType: 'image/png', byteSize: 3 })).resolves.toMatchObject({ asset: { id: 'a' } })
    await expect(api.listAccounts()).resolves.toEqual({ accounts: [{ id: 'acct' }], enabledPlatforms: ['facebook'] })
    await expect(api.createPublication({ revisionId: 'r', accountId: 'a', idempotencyKey: 'k' })).resolves.toEqual({ id: 'pub' })
    await expect(api.listPublications('item-1')).resolves.toEqual([{ id: 'pub' }])
    expect(mock.mock.calls.at(-1)?.[0]).toBe('/api/social/publications?itemId=item-1')
  })

  it('defaults missing account lists and non-array publications', async () => {
    routeFetch({
      'GET /api/social/accounts': jsonResponse({}),
      'GET /api/social/publications': jsonResponse({ publications: null }),
    })

    await expect(api.listAccounts()).resolves.toEqual({ accounts: [], enabledPlatforms: [] })
    await expect(api.listPublications()).resolves.toEqual([])
  })

  it('raises the server message and a known code', async () => {
    routeFetch({ 'POST /api/content-studio/variants/var-1/revisions': errorResponse(409, 'Stale', 'stale_revision') })

    const error = await api
      .saveRevision('var-1', {
        idempotencyKey: 'k',
        expectedRevisionId: null,
        content: { body: '', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] },
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: 'Stale', status: 409, code: 'stale_revision' })
  })

  it.each([
    [401, 'You do not have access to this.'],
    [404, 'Not found.'],
    [409, 'This changed since you loaded it.'],
    [429, 'Too many requests. Wait a moment and try again.'],
    [503, 'The server could not complete the request.'],
    [400, 'The request failed.'],
  ])('falls back to a message for status %i', async (status, message) => {
    global.fetch = jest.fn(async () => ({ ok: false, status, json: async () => ({ code: 'unknown_code' }) })) as unknown as typeof fetch

    await expect(api.getItem('x')).rejects.toMatchObject({ message, status, code: null })
  })

  it('survives a body that is not JSON', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('bad') } })) as unknown as typeof fetch

    await expect(api.getJob('x')).rejects.toMatchObject({ status: 500 })
  })

  it('reports a network failure as status 0', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch

    await expect(api.listAccounts()).rejects.toMatchObject({ status: 0 })
  })

  it('puts the file straight to the signed URL', async () => {
    const mock = jest.fn(async () => ({ ok: true, status: 200 }))
    global.fetch = mock as unknown as typeof fetch
    const file = new File(['abc'], 'a.png', { type: 'image/png' })

    await api.uploadToSignedUrl('https://storage.test/upload', file)

    expect(mock).toHaveBeenCalledWith('https://storage.test/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
      body: file,
    })
  })

  it('reports storage refusals and unreachable storage', async () => {
    const file = new File(['abc'], 'a.png', { type: 'image/png' })
    global.fetch = jest.fn(async () => ({ ok: false, status: 400 })) as unknown as typeof fetch
    await expect(api.uploadToSignedUrl('https://s', file)).rejects.toMatchObject({ status: 400 })

    global.fetch = jest.fn(async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    await expect(api.uploadToSignedUrl('https://s', file)).rejects.toMatchObject({ status: 0 })
  })

  it('never serves reads from the HTTP cache', async () => {
    const mock = routeFetch({ 'GET /api/content-studio/items/item-1': jsonResponse({ item: makeItem() }), 'POST /api/content-studio/jobs/j/cancel': jsonResponse({ job: {} }) })
    await api.getItem('item-1')
    await api.cancelJob('j')
    expect(mock.mock.calls[0][1].cache).toBe('no-store')
    expect(mock.mock.calls[1][1].cache).toBeUndefined()
  })

  it.each(['archived', 'blocked_content', 'asset_not_pending', 'snapshot_content_locked'])('recognises the %s code', async (code) => {
    routeFetch({ 'GET /api/content-studio/items/x': errorResponse(409, 'Refused', code) })
    await expect(api.getItem('x')).rejects.toMatchObject({ code })
  })

  it('knows which poll errors are final', () => {
    expect(api.isFatalPollError(new ApiError('x', 401))).toBe(true)
    expect(api.isFatalPollError(new ApiError('x', 403))).toBe(true)
    expect(api.isFatalPollError(new ApiError('x', 404))).toBe(true)
    expect(api.isFatalPollError(new ApiError('x', 503, 'feature_disabled'))).toBe(true)
    expect(api.isFatalPollError(new ApiError('x', 500))).toBe(false)
    expect(api.isFatalPollError(new Error('x'))).toBe(false)
  })

  it('classifies unavailable features and formats messages', () => {
    expect(isUnavailable(new ApiError('x', 404))).toBe(true)
    expect(isUnavailable(new ApiError('x', 403, 'feature_disabled'))).toBe(true)
    expect(isUnavailable(new ApiError('x', 500))).toBe(false)
    expect(isUnavailable(new Error('x'))).toBe(false)
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom')
    expect(errorMessage('nope', 'fallback')).toBe('fallback')
  })
})
