/**
 * Typed browser client for the Content Studio and social publishing endpoints.
 *
 * The contract lives in src/lib/content-studio/types.ts; every path here is the one
 * documented above the matching DTO. Errors come back as `{ error, code? }` and are
 * raised as ApiError so callers can branch on `status` and `code` (stale_revision,
 * feature_disabled…) instead of parsing messages.
 */

import type {
  ContentApiErrorCode,
  ContentItem,
  ContentJob,
  ContentRevision,
  ContentVariant,
  CreateItemRequest,
  CreateUploadRequest,
  CreateUploadResponse,
  DuplicateVariantRequest,
  GenerateImagesRequest,
  GenerateRequest,
  ListAccountsResponse,
  ListAssetsResponse,
  ListItemsResponse,
  PublishPreflight,
  PublishRequest,
  ResolveJobRequest,
  ReviewRequest,
  SaveRevisionRequest,
  SocialPublication,
  UpdateItemRequest,
  VariantExport,
} from '@/lib/content-studio/types'

const STUDIO = '/api/content-studio'
const SOCIAL = '/api/social'

/** A Record, so adding a code to ContentApiErrorCode without listing it here fails tsc. */
const CODE_SET: Record<ContentApiErrorCode, true> = {
  stale_revision: true,
  not_approved: true,
  account_not_connected: true,
  channel_mismatch: true,
  asset_mismatch: true,
  asset_not_ready: true,
  already_published: true,
  feature_disabled: true,
  preflight_failed: true,
  archived: true,
  blocked_content: true,
  asset_not_pending: true,
  snapshot_content_locked: true,
}
const KNOWN_CODES = Object.keys(CODE_SET) as ContentApiErrorCode[]

export class ApiError extends Error {
  readonly status: number
  readonly code: ContentApiErrorCode | null

  constructor(message: string, status: number, code: ContentApiErrorCode | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** A route that is not deployed yet, or a feature switched off by flag. */
export function isUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === 'feature_disabled')
}

/** A poll that can never succeed by waiting: no session, no permission, gone, or switched off. */
export function isFatalPollError(error: unknown): boolean {
  return error instanceof ApiError && ([401, 403, 404].includes(error.status) || error.code === 'feature_disabled')
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function fallbackMessage(status: number): string {
  if (status === 401 || status === 403) return 'You do not have access to this.'
  if (status === 404) return 'Not found.'
  if (status === 409) return 'This changed since you loaded it.'
  if (status === 429) return 'Too many requests. Wait a moment and try again.'
  if (status >= 500) return 'The server could not complete the request.'
  return 'The request failed.'
}

function readCode(value: unknown): ContentApiErrorCode | null {
  return typeof value === 'string' && (KNOWN_CODES as readonly string[]).includes(value)
    ? (value as ContentApiErrorCode)
    : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

type Method = 'GET' | 'POST' | 'PATCH'

async function request(path: string, method: Method = 'GET', body?: unknown): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      // Reads must reflect the save that just happened, never a cached copy.
      cache: method === 'GET' ? 'no-store' : undefined,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0)
  }

  const parsed = await readBody(response)
  if (!response.ok) {
    const record = asRecord(parsed)
    const message = typeof record?.error === 'string' && record.error ? record.error : fallbackMessage(response.status)
    throw new ApiError(message, response.status, readCode(record?.code))
  }
  return parsed
}

/**
 * Takes `body[key]` when the envelope carries it, otherwise the body itself. The routes
 * are written in parallel with this client; tolerating a bare body costs nothing and
 * keeps the UI working if a route skips the envelope.
 */
function unwrap<T>(body: unknown, key: string): T {
  const record = asRecord(body)
  if (record && key in record) return record[key] as T
  return body as T
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(name, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

const enc = encodeURIComponent

// --- Items ------------------------------------------------------------------

export type ListItemsParams = {
  search?: string
  status?: 'active' | 'archived' | 'review'
  page?: number
  pageSize?: number
}

export async function listItems(params: ListItemsParams = {}): Promise<ListItemsResponse> {
  const body = await request(`${STUDIO}/items${query(params)}`)
  return body as ListItemsResponse
}

export async function createItem(input: CreateItemRequest): Promise<ContentItem> {
  return unwrap<ContentItem>(await request(`${STUDIO}/items`, 'POST', input), 'item')
}

export async function getItem(id: string): Promise<ContentItem> {
  return unwrap<ContentItem>(await request(`${STUDIO}/items/${enc(id)}`), 'item')
}

export async function updateItem(id: string, input: UpdateItemRequest): Promise<ContentItem> {
  return unwrap<ContentItem>(await request(`${STUDIO}/items/${enc(id)}`, 'PATCH', input), 'item')
}

export async function generate(itemId: string, input: GenerateRequest): Promise<ContentJob> {
  return unwrap<ContentJob>(await request(`${STUDIO}/items/${enc(itemId)}/generate`, 'POST', input), 'job')
}

export async function generateImages(itemId: string, input: GenerateImagesRequest): Promise<ContentJob> {
  return unwrap<ContentJob>(await request(`${STUDIO}/items/${enc(itemId)}/images`, 'POST', input), 'job')
}

// --- Variants ---------------------------------------------------------------

export async function saveRevision(variantId: string, input: SaveRevisionRequest): Promise<ContentRevision> {
  const body = await request(`${STUDIO}/variants/${enc(variantId)}/revisions`, 'POST', input)
  return unwrap<ContentRevision>(body, 'revision')
}

export async function duplicateVariant(variantId: string, input: DuplicateVariantRequest): Promise<ContentVariant> {
  const body = await request(`${STUDIO}/variants/${enc(variantId)}/duplicate`, 'POST', input)
  return unwrap<ContentVariant>(body, 'variant')
}

export async function reviewRevision(variantId: string, input: ReviewRequest): Promise<void> {
  await request(`${STUDIO}/variants/${enc(variantId)}/review`, 'POST', input)
}

/** Not in the typed contract yet: PATCH /api/content-studio/variants/[id] { archived }. */
export async function setVariantArchived(variantId: string, archived: boolean): Promise<void> {
  await request(`${STUDIO}/variants/${enc(variantId)}`, 'PATCH', { archived })
}

export async function exportVariant(variantId: string): Promise<VariantExport> {
  return unwrap<VariantExport>(await request(`${STUDIO}/variants/${enc(variantId)}/export`), 'export')
}

// --- Assets -----------------------------------------------------------------

export async function listAssets(params: { itemId?: string; page?: number; pageSize?: number } = {}): Promise<ListAssetsResponse> {
  return (await request(`${STUDIO}/assets${query(params)}`)) as ListAssetsResponse
}

export async function createUpload(input: CreateUploadRequest): Promise<CreateUploadResponse> {
  return (await request(`${STUDIO}/assets`, 'POST', input)) as CreateUploadResponse
}

/** Sends the bytes straight to Storage; the CRM never proxies the file. */
export async function uploadToSignedUrl(signedUrl: string, file: File): Promise<void> {
  let response: Response
  try {
    response = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type, 'x-upsert': 'false' },
      body: file,
    })
  } catch {
    throw new ApiError('The upload could not reach storage. Try again.', 0)
  }
  if (!response.ok) {
    throw new ApiError('Storage refused the upload. Try again, or pick a different file.', response.status)
  }
}

export async function ingestAsset(assetId: string): Promise<ContentJob> {
  return unwrap<ContentJob>(await request(`${STUDIO}/assets/${enc(assetId)}/ingest`, 'POST', {}), 'job')
}

// --- Jobs -------------------------------------------------------------------

export async function getJob(id: string): Promise<ContentJob> {
  return unwrap<ContentJob>(await request(`${STUDIO}/jobs/${enc(id)}`), 'job')
}

export async function cancelJob(id: string): Promise<ContentJob> {
  return unwrap<ContentJob>(await request(`${STUDIO}/jobs/${enc(id)}/cancel`, 'POST', {}), 'job')
}

export async function resolveJob(id: string, input: ResolveJobRequest): Promise<ContentJob> {
  return unwrap<ContentJob>(await request(`${STUDIO}/jobs/${enc(id)}/resolve`, 'POST', input), 'job')
}

// --- Social -----------------------------------------------------------------

export async function listAccounts(): Promise<ListAccountsResponse> {
  const body = asRecord(await request(`${SOCIAL}/accounts`))
  return {
    accounts: Array.isArray(body?.accounts) ? (body.accounts as ListAccountsResponse['accounts']) : [],
    enabledPlatforms: Array.isArray(body?.enabledPlatforms)
      ? (body.enabledPlatforms as ListAccountsResponse['enabledPlatforms'])
      : [],
  }
}

export async function preflightPublication(input: PublishRequest): Promise<PublishPreflight> {
  return unwrap<PublishPreflight>(await request(`${SOCIAL}/publications/preflight`, 'POST', input), 'preflight')
}

export async function createPublication(input: PublishRequest): Promise<SocialPublication> {
  return unwrap<SocialPublication>(await request(`${SOCIAL}/publications`, 'POST', input), 'publication')
}

export async function listPublications(itemId?: string): Promise<SocialPublication[]> {
  const body = unwrap<unknown>(await request(`${SOCIAL}/publications${query({ itemId })}`), 'publications')
  return Array.isArray(body) ? (body as SocialPublication[]) : []
}

