import { isUuid } from '@/lib/contacts/tags'

import {
  CONTENT_CHANNELS,
  type ApprovedFact,
  type BrandProfile,
  type ContentBrief,
  type ContentChannel,
  type CreateItemRequest,
  type CreateUploadRequest,
  type DuplicateVariantRequest,
  type GenerateImagesRequest,
  type GenerateRequest,
  type ResolveJobRequest,
  type ReviewRequest,
  type RevisionAssetRef,
  type RevisionContent,
  type SaveRevisionRequest,
  type UpdateItemRequest,
  type UpdateVariantRequest,
} from './types'

/**
 * Narrowing validators for every Content Studio request body. The repo has no schema
 * library; these follow the hand-written style of src/lib/contacts/tags.ts and return a
 * discriminated result instead of throwing, so a handler answers 400 with the message.
 *
 * Limits mirror the database constraints (20261007000000_content_studio.sql) so a request
 * the database would refuse is refused here first, with a readable reason.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
export type Body = Record<string, unknown>

export const ALLOWED_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:._-]{8,200}$/

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })

function oneOf<T extends string | number>(value: unknown, options: readonly T[]): value is T {
  return (options as readonly unknown[]).includes(value)
}
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error })

export function isRecord(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string within bounds (trimmed when `trim`), or undefined when absent/null and optional. */
function readString(
  body: Body,
  key: string,
  options: { max: number; min?: number; required?: boolean; trim?: boolean }
): Parsed<string | undefined> {
  const raw = body[key]
  if (raw === undefined || raw === null) {
    return options.required ? fail(`${key} is required.`) : ok(undefined)
  }
  if (typeof raw !== 'string') return fail(`${key} must be a string.`)

  const value = options.trim === false ? raw : raw.trim()
  if (value.length < (options.min ?? 0)) return fail(`${key} is required.`)
  if (value.length > options.max) return fail(`${key} must be at most ${options.max} characters.`)
  return ok(value)
}

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname !== '' && !/\s/.test(value)
  } catch {
    return false
  }
}

function readHttpsUrl(body: Body, key: string): Parsed<string | null | undefined> {
  if (body[key] === null) return ok(null)
  const parsed = readString(body, key, { max: 2000 })
  if (!parsed.ok || parsed.value === undefined) return parsed
  if (parsed.value === '') return ok(null)
  return isHttpsUrl(parsed.value) ? ok(parsed.value) : fail(`${key} must be an https:// URL.`)
}

function readStringList(body: Body, key: string, maxItems: number, maxLength: number): Parsed<string[] | undefined> {
  const raw = body[key]
  if (raw === undefined || raw === null) return ok(undefined)
  if (!Array.isArray(raw) || raw.length > maxItems) return fail(`${key} must be a list of at most ${maxItems} entries.`)
  if (!raw.every((entry) => typeof entry === 'string' && entry.length <= maxLength)) {
    return fail(`Every ${key} entry must be text of at most ${maxLength} characters.`)
  }
  return ok(raw as string[])
}

export function readIdempotencyKey(body: Body): Parsed<string> {
  const key = body.idempotencyKey
  return typeof key === 'string' && IDEMPOTENCY_KEY_PATTERN.test(key)
    ? ok(key)
    : fail('idempotencyKey must be 8 to 200 characters of letters, digits, ":", ".", "_" or "-".')
}

function readOptionalUuid(body: Body, key: string): Parsed<string | undefined> {
  const raw = body[key]
  if (raw === undefined || raw === null) return ok(undefined)
  return isUuid(raw) ? ok(raw) : fail(`${key} must be a UUID.`)
}

export function parseChannels(raw: unknown): Parsed<ContentChannel[]> {
  if (!Array.isArray(raw) || raw.length === 0) return fail('Choose at least one channel.')
  if (!raw.every((entry) => (CONTENT_CHANNELS as readonly unknown[]).includes(entry))) {
    return fail(`Channels must be among ${CONTENT_CHANNELS.join(', ')}.`)
  }
  const unique = CONTENT_CHANNELS.filter((channel) => raw.includes(channel))
  return unique.length === raw.length ? ok(unique) : fail('A channel can appear only once.')
}

/** Collects the first failure of a set of parsed fields, or their values. */
function collect<T extends Record<string, Parsed<unknown>>>(
  fields: T
): Parsed<{ [K in keyof T]: T[K] extends Parsed<infer V> ? V : never }> {
  const failure = Object.values(fields).find((field) => !field.ok)
  if (failure && !failure.ok) return fail(failure.error)

  const values = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, (field as { ok: true; value: unknown }).value])
  )
  return ok(values as { [K in keyof T]: T[K] extends Parsed<infer V> ? V : never })
}

/** Drops undefined values so the stored JSON carries only what was given. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

export function parseBrief(raw: unknown): Parsed<ContentBrief> {
  if (!isRecord(raw)) return fail('brief must be an object.')

  const fields = collect({
    topic: readString(raw, 'topic', { min: 1, max: 500, required: true }),
    audience: readString(raw, 'audience', { max: 300 }),
    objective: readString(raw, 'objective', { max: 500 }),
    notes: readString(raw, 'notes', { max: 4000 }),
    referenceUrl: readHttpsUrl(raw, 'referenceUrl'),
    sourceFacts: readStringList(raw, 'sourceFacts', 20, 500),
  })
  if (!fields.ok) return fields

  const { referenceUrl, ...rest } = fields.value
  return ok(compact({ ...rest, topic: rest.topic as string, referenceUrl: referenceUrl ?? undefined }))
}

export function parseCreateItem(body: Body): Parsed<CreateItemRequest> {
  const fields = collect({
    title: readString(body, 'title', { min: 1, max: 200, required: true }),
    brief: parseBrief(body.brief),
    channels: parseChannels(body.channels),
  })
  if (!fields.ok) return fields
  return ok({ ...fields.value, title: fields.value.title as string })
}

export function parseUpdateItem(body: Body): Parsed<UpdateItemRequest> {
  if (body.archived !== undefined && typeof body.archived !== 'boolean') return fail('archived must be true or false.')

  const fields = collect({
    title: readString(body, 'title', { min: 1, max: 200 }),
    brief: body.brief === undefined ? ok(undefined) : parseBrief(body.brief),
    channels: body.channels === undefined ? ok(undefined) : parseChannels(body.channels),
  })
  if (!fields.ok) return fields

  const update = compact({ ...fields.value, archived: body.archived as boolean | undefined })
  return Object.keys(update).length > 0 ? ok(update) : fail('Nothing to update.')
}

export function parseGenerate(body: Body): Parsed<GenerateRequest> {
  const styles = body.stylesPerChannel ?? 1
  if (!oneOf(styles, [1, 2, 3] as const)) return fail('stylesPerChannel must be 1, 2 or 3.')

  const fields = collect({
    idempotencyKey: readIdempotencyKey(body),
    channels: parseChannels(body.channels),
    variantId: readOptionalUuid(body, 'variantId'),
    baseRevisionId: readOptionalUuid(body, 'baseRevisionId'),
    instruction: readString(body, 'instruction', { max: 2000 }),
  })
  if (!fields.ok) return fields
  if ((fields.value.variantId === undefined) !== (fields.value.baseRevisionId === undefined)) {
    return fail('A regeneration needs both variantId and baseRevisionId.')
  }
  if (fields.value.variantId !== undefined && fields.value.channels.length !== 1) {
    return fail('A regeneration targets exactly one channel.')
  }
  return ok(compact({ ...fields.value, stylesPerChannel: styles }))
}

export function parseGenerateImages(body: Body): Parsed<GenerateImagesRequest> {
  const count = body.count
  if (count !== 1 && count !== 2 && count !== 3 && count !== 4) return fail('count must be 1 to 4.')
  const quality = body.quality ?? 'medium'
  if (quality !== 'low' && quality !== 'medium' && quality !== 'high') return fail('quality must be low, medium or high.')

  const fields = collect({
    idempotencyKey: readIdempotencyKey(body),
    prompt: readString(body, 'prompt', { min: 1, max: 4000, required: true }),
  })
  if (!fields.ok) return fields
  return ok({ idempotencyKey: fields.value.idempotencyKey, prompt: fields.value.prompt as string, count, quality })
}

function parseAssetRefs(raw: unknown): Parsed<RevisionAssetRef[]> {
  if (raw === undefined || raw === null) return ok([])
  if (!Array.isArray(raw) || raw.length > 10) return fail('A revision can use at most 10 images.')

  const refs = raw.map((entry, index) =>
    isRecord(entry) && isUuid(entry.assetId) && (entry.alt === undefined || (typeof entry.alt === 'string' && entry.alt.length <= 500))
      ? { assetId: entry.assetId, alt: (entry.alt as string | undefined) ?? '', order: Number.isInteger(entry.order) ? (entry.order as number) : index }
      : null
  )
  if (refs.some((ref) => ref === null)) return fail('Every image needs an assetId and alt text of at most 500 characters.')

  const ids = refs.map((ref) => (ref as RevisionAssetRef).assetId)
  return new Set(ids).size === ids.length ? ok(refs as RevisionAssetRef[]) : fail('An image can appear once per revision.')
}

function parseFields(raw: unknown): Parsed<Record<string, string>> {
  if (raw === undefined || raw === null) return ok({})
  if (!isRecord(raw) || Object.keys(raw).length > 30) return fail('fields must be an object with at most 30 entries.')

  const valid = Object.entries(raw).every(
    ([key, value]) => /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(key) && typeof value === 'string' && value.length <= 10000
  )
  return valid ? ok(raw as Record<string, string>) : fail('Every field needs a simple name and a text value.')
}

export function parseRevisionContent(raw: unknown): Parsed<RevisionContent> {
  if (!isRecord(raw)) return fail('content must be an object.')

  const fields = collect({
    body: readString(raw, 'body', { max: 10000, required: true, trim: false }),
    hashtags: readStringList(raw, 'hashtags', 30, 60),
    callToAction: readString(raw, 'callToAction', { max: 500 }),
    linkUrl: readHttpsUrl(raw, 'linkUrl'),
    fields: parseFields(raw.fields),
    assets: parseAssetRefs(raw.assets),
  })
  if (!fields.ok) return fields

  const value = fields.value
  return ok({
    body: value.body as string,
    hashtags: value.hashtags ?? [],
    callToAction: value.callToAction || null,
    linkUrl: value.linkUrl ?? null,
    fields: value.fields,
    assets: value.assets,
  })
}

export function parseSaveRevision(body: Body): Parsed<SaveRevisionRequest> {
  const expected = body.expectedRevisionId
  if (expected !== null && !isUuid(expected)) return fail('expectedRevisionId must be a UUID or null.')

  const fields = collect({ idempotencyKey: readIdempotencyKey(body), content: parseRevisionContent(body.content) })
  if (!fields.ok) return fields
  return ok({ ...fields.value, expectedRevisionId: expected })
}

export function parseDuplicateVariant(body: Body): Parsed<DuplicateVariantRequest> {
  const key = readIdempotencyKey(body)
  return key.ok ? ok({ idempotencyKey: key.value }) : key
}

export function parseReview(body: Body): Parsed<ReviewRequest> {
  const decision = body.decision
  if (!isUuid(body.revisionId)) return fail('revisionId must be a UUID.')
  if (!oneOf(decision, ['approved', 'rejected'] as const)) return fail('decision must be approved or rejected.')

  const reason = readString(body, 'reason', { max: 1000 })
  if (!reason.ok) return reason
  if (decision === 'rejected' && !reason.value) return fail('Say why the revision is rejected.')
  return ok<ReviewRequest>(compact({ revisionId: body.revisionId, decision, reason: reason.value || undefined }))
}

export function parseCreateUpload(body: Body): Parsed<CreateUploadRequest> {
  if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly unknown[]).includes(body.mimeType)) {
    return fail('Upload a JPEG, PNG, WebP or GIF image.')
  }
  const size = body.byteSize
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
    return fail('Images must be at most 15 MiB.')
  }

  const fields = collect({
    filename: readString(body, 'filename', { min: 1, max: 255, required: true }),
    itemId: readOptionalUuid(body, 'itemId'),
  })
  if (!fields.ok) return fields
  return ok(compact({ filename: fields.value.filename as string, mimeType: body.mimeType as string, byteSize: size, itemId: fields.value.itemId }))
}

export type UpdateAssetRequest = { altText?: string; archived?: boolean }

export function parseUpdateAsset(body: Body): Parsed<UpdateAssetRequest> {
  if (body.archived !== undefined && typeof body.archived !== 'boolean') return fail('archived must be true or false.')
  const alt = readString(body, 'altText', { max: 500 })
  if (!alt.ok) return alt

  const update = compact({ altText: alt.value, archived: body.archived as boolean | undefined })
  return Object.keys(update).length > 0 ? ok(update) : fail('Nothing to update.')
}

export function parseResolveJob(body: Body): Parsed<ResolveJobRequest> {
  const resolution = body.resolution
  if (!oneOf(resolution, ['succeeded', 'failed'] as const)) return fail('resolution must be succeeded or failed.')

  const fields = collect({
    note: readString(body, 'note', { min: 1, max: 1000, required: true }),
    externalId: readString(body, 'externalId', { max: 200 }),
    permalink: readHttpsUrl(body, 'permalink'),
  })
  if (!fields.ok) return fields
  return ok<ResolveJobRequest>(
    compact({
      resolution,
      note: fields.value.note as string,
      externalId: fields.value.externalId || undefined,
      permalink: fields.value.permalink ?? undefined,
    })
  )
}

export function parseUpdateVariant(body: Body): Parsed<UpdateVariantRequest> {
  return typeof body.archived === 'boolean' ? ok({ archived: body.archived }) : fail('archived must be true or false.')
}

// --- Brand profile (administrators) ---------------------------------------------------

export type BrandProfileUpdate = Partial<
  Pick<BrandProfile, 'name' | 'tone' | 'audience' | 'region' | 'imageDirection' | 'approvedFacts' | 'channelRules' | 'hashtagSeeds' | 'allowedLinkOrigins'>
>

export const MAX_APPROVED_FACTS = 100
export const ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/i

function parseFacts(raw: unknown): Parsed<ApprovedFact[] | undefined> {
  if (raw === undefined) return ok(undefined)
  if (!Array.isArray(raw) || raw.length > MAX_APPROVED_FACTS) return fail(`List at most ${MAX_APPROVED_FACTS} approved facts.`)

  const facts = raw.map((entry) =>
    isRecord(entry) &&
    typeof entry.id === 'string' && entry.id.trim() !== '' && entry.id.length <= 80 &&
    typeof entry.text === 'string' && entry.text.trim() !== '' && entry.text.length <= 500 &&
    (entry.source === undefined || entry.source === null || (typeof entry.source === 'string' && entry.source.length <= 500))
      ? compact({ id: entry.id.trim(), text: entry.text.trim(), source: typeof entry.source === 'string' && entry.source.trim() ? entry.source.trim() : undefined })
      : null
  )
  if (facts.some((fact) => fact === null)) return fail('Each approved fact needs a text of at most 500 characters.')
  const ids = facts.map((fact) => (fact as ApprovedFact).id)
  return new Set(ids).size === ids.length ? ok(facts as ApprovedFact[]) : fail('Approved fact ids must be unique.')
}

function parseChannelRules(raw: unknown): Parsed<BrandProfile['channelRules'] | undefined> {
  if (raw === undefined) return ok(undefined)
  if (!isRecord(raw)) return fail('channelRules must be an object.')

  const entries = Object.entries(raw)
  if (!entries.every(([channel]) => (CONTENT_CHANNELS as readonly string[]).includes(channel))) {
    return fail(`Channel rules may only name ${CONTENT_CHANNELS.join(', ')}.`)
  }
  const valid = entries.every(
    ([, rule]) =>
      isRecord(rule) &&
      (rule.cta === undefined || (typeof rule.cta === 'string' && rule.cta.length <= 300)) &&
      (rule.structure === undefined || (typeof rule.structure === 'string' && rule.structure.length <= 1000))
  )
  if (!valid) return fail('A channel rule has a call to action of at most 300 and a structure of at most 1000 characters.')

  return ok(
    Object.fromEntries(
      entries.map(([channel, rule]) => {
        const { cta, structure } = rule as { cta?: string; structure?: string }
        return [channel, compact({ cta: cta?.trim() || undefined, structure: structure?.trim() || undefined })]
      })
    )
  )
}

function parseOrigins(raw: unknown): Parsed<string[] | undefined> {
  if (raw === undefined) return ok(undefined)
  if (!Array.isArray(raw) || raw.length > 20) return fail('List at most 20 allowed link origins.')
  const origins = raw.map((entry) => (typeof entry === 'string' ? entry.trim().replace(/\/$/, '').toLowerCase() : ''))
  return origins.every((origin) => ORIGIN_PATTERN.test(origin))
    ? ok([...new Set(origins)])
    : fail('Allowed link origins must look like https://example.com, without a path.')
}

export function parseBrandUpdate(body: Body): Parsed<BrandProfileUpdate> {
  const fields = collect({
    name: readString(body, 'name', { min: 1, max: 120 }),
    tone: readString(body, 'tone', { max: 2000 }),
    audience: readString(body, 'audience', { max: 2000 }),
    region: readString(body, 'region', { max: 200 }),
    imageDirection: readString(body, 'imageDirection', { max: 2000 }),
    hashtagSeeds: readStringList(body, 'hashtagSeeds', 30, 60),
    approvedFacts: parseFacts(body.approvedFacts),
    channelRules: parseChannelRules(body.channelRules),
    allowedLinkOrigins: parseOrigins(body.allowedLinkOrigins),
  })
  if (!fields.ok) return fields

  const update = compact(fields.value) as BrandProfileUpdate
  return Object.keys(update).length > 0 ? ok(update) : fail('Nothing to update.')
}
