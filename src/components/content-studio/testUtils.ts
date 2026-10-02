/**
 * Fixtures and a fetch router for the Content Studio suites. Not a test file itself.
 */

import type {
  ContentAsset,
  ContentItem,
  ContentItemSummary,
  ContentJob,
  ContentRevision,
  ContentVariant,
  SocialAccount,
  SocialPublication,
} from '@/lib/content-studio/types'

export type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

export function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

export function errorResponse(status: number, error: string, code?: string): FakeResponse {
  return jsonResponse(code ? { error, code } : { error }, status)
}

type Handler = FakeResponse | ((init: RequestInit | undefined, url: string) => FakeResponse | Promise<FakeResponse>)

/**
 * Routes `fetch` by "METHOD /path" (query string ignored unless the key includes it).
 * Unrouted requests answer 404, which is also how a not-yet-deployed route looks.
 */
export function routeFetch(handlers: Record<string, Handler>): jest.Mock {
  const mock = jest.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    const handler = handlers[`${method} ${url}`] ?? handlers[`${method} ${url.split('?')[0]}`]
    if (!handler) return errorResponse(404, 'Not found')
    return typeof handler === 'function' ? handler(init, url) : handler
  })
  global.fetch = mock as unknown as typeof fetch
  return mock
}

export function bodyOf(mock: jest.Mock, method: string, path: string): unknown {
  const call = mock.mock.calls.find(([url, init]) => String(url).split('?')[0] === path && (init?.method ?? 'GET') === method)
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : undefined
}

export function callsTo(mock: jest.Mock, method: string, path: string): number {
  return mock.mock.calls.filter(([url, init]) => String(url).split('?')[0] === path && (init?.method ?? 'GET') === method).length
}

const NOW = '2026-09-30T10:00:00.000Z'

export function makeRevision(overrides: Partial<ContentRevision> = {}): ContentRevision {
  return {
    id: 'rev-1',
    variantId: 'var-1',
    revisionNumber: 1,
    parentRevisionId: null,
    origin: 'generated',
    facts: [],
    sources: [],
    violations: [],
    promptVersion: 'v1',
    jobId: 'job-1',
    checksum: 'abc',
    createdBy: null,
    createdAt: NOW,
    review: 'pending',
    reviewedAt: null,
    reviewReason: null,
    body: 'Join our workshop next Tuesday.',
    hashtags: ['#workshop'],
    callToAction: 'Book now',
    linkUrl: 'https://example.com/book',
    fields: {},
    assets: [],
    ...overrides,
  }
}

export function makeVariant(overrides: Partial<ContentVariant> = {}): ContentVariant {
  const current = overrides.current === undefined ? makeRevision() : overrides.current
  return {
    id: 'var-1',
    itemId: 'item-1',
    channel: 'facebook',
    style: 'direct',
    currentRevisionId: current?.id ?? null,
    conflictOfRevisionId: null,
    createdAt: NOW,
    archivedAt: null,
    ...overrides,
    current,
  }
}

export function makeJob(overrides: Partial<ContentJob> = {}): ContentJob {
  return {
    id: 'job-1',
    kind: 'generate_text',
    status: 'running',
    itemId: 'item-1',
    variantId: null,
    assetId: null,
    publicationId: null,
    attempts: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    cancelRequestedAt: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    failures: [],
    warnings: [],
    ...overrides,
  }
}

export function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'item-1',
    brandId: 'brand-1',
    title: 'Spring workshop',
    brief: { topic: 'Spring workshop launch', audience: 'Owners' },
    channels: ['facebook'],
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    variants: [makeVariant()],
    jobs: [],
    publications: [],
    ...overrides,
  }
}

export function makeSummary(overrides: Partial<ContentItemSummary> = {}): ContentItemSummary {
  return {
    id: 'item-1',
    title: 'Spring workshop',
    channels: ['facebook', 'linkedin'],
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    variantCount: 2,
    approvedCount: 0,
    pendingReviewCount: 1,
    activeJobCount: 0,
    ...overrides,
  }
}

export function makeAsset(overrides: Partial<ContentAsset> = {}): ContentAsset {
  return {
    id: 'asset-1',
    itemId: 'item-1',
    origin: 'upload',
    ingestStatus: 'ready',
    rejectionReason: null,
    mimeType: 'image/jpeg',
    byteSize: 1000,
    width: 1200,
    height: 800,
    checksum: 'sum',
    altText: 'People at a workshop',
    originalFilename: 'workshop.jpg',
    generationPrompt: null,
    createdAt: NOW,
    archivedAt: null,
    previewUrl: 'https://storage.test/preview/asset-1.jpg',
    activeJobId: null,
    ...overrides,
  }
}

export function makeAccount(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: 'acct-1',
    platform: 'facebook',
    provider: 'meta',
    externalId: 'page-1',
    displayName: 'AI4L Page',
    authorKind: 'page',
    scopes: [],
    status: 'connected',
    lastError: null,
    healthCheckedAt: null,
    createdAt: NOW,
    ...overrides,
  }
}

export function makePublication(overrides: Partial<SocialPublication> = {}): SocialPublication {
  return {
    id: 'pub-1',
    revisionId: 'rev-1',
    variantId: 'var-1',
    accountId: 'acct-1',
    jobId: 'job-pub-1',
    status: 'published',
    externalId: 'ext-1',
    permalink: 'https://facebook.com/post/1',
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    dispatchStartedAt: NOW,
    finishedAt: NOW,
    resolutionNote: null,
    ...overrides,
  }
}
