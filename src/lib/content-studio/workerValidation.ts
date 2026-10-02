import { isUuid } from '@/lib/contacts/tags'

import {
  CONTENT_CHANNELS,
  JOB_KINDS,
  type AssetFile,
  type AssetFiles,
  type FailOutcome,
  type JobKind,
  type JobResult,
  type WorkerCheckpointRequest,
  type WorkerClaimRequest,
  type WorkerCompleteRequest,
  type WorkerFailRequest,
  type WorkerJobRef,
} from './types'
import { isHttpsUrl, isRecord, type Body, type Parsed } from './validation'

/**
 * Validators for the worker protocol v1 bodies (docs/CONTENT_STUDIO_CONTRACTS.md §3).
 * The SQL functions re-check what matters for integrity (lease, prefixes, sizes); these
 * reject malformed input early with a 400 and keep the bridge from forwarding anything
 * that is not the documented shape — in particular, nothing that looks like a secret may
 * be stored in a checkpoint or a result.
 */

const MAX_JSON_BYTES = 256 * 1024
const MAX_CHECKPOINT_BYTES = 64 * 1024
const SECRET_KEY_PATTERN = /(access|refresh|bearer|id)_?token|secret|password|authorization/i
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/
const MAX_FILE_BYTES = 15 * 1024 * 1024
const FILE_MIME = ['image/jpeg', 'image/png', 'image/webp']

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error })

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isText(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function isOptional<T>(value: unknown, check: (entry: unknown) => entry is T): boolean {
  return value === undefined || value === null || check(value)
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/** True when any key, at any depth, is named like a credential. */
export function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, entry]) => SECRET_KEY_PATTERN.test(key) || containsSecretKey(entry))
}

export function parseClaim(body: Body): Parsed<WorkerClaimRequest> {
  if (!isText(body.workerId, 120, 1) || body.workerId.trim() === '') return fail('workerId is required.')
  if (!Array.isArray(body.kinds) || body.kinds.length === 0 || !body.kinds.every((kind) => (JOB_KINDS as readonly unknown[]).includes(kind))) {
    return fail(`kinds must list job kinds among ${JOB_KINDS.join(', ')}.`)
  }
  if (!isInt(body.limit, 1, 20)) return fail('limit must be 1 to 20.')
  if (body.leaseSeconds !== undefined && !isInt(body.leaseSeconds, 30, 900)) return fail('leaseSeconds must be 30 to 900.')

  return ok({
    workerId: body.workerId,
    kinds: [...new Set(body.kinds as JobKind[])],
    limit: body.limit,
    ...(body.leaseSeconds !== undefined ? { leaseSeconds: body.leaseSeconds as number } : {}),
  })
}

export function parseJobRef(body: Body): Parsed<WorkerJobRef & { leaseSeconds?: number }> {
  if (!isUuid(body.jobId) || !isUuid(body.claimToken)) return fail('jobId and claimToken must be UUIDs.')
  if (body.leaseSeconds !== undefined && !isInt(body.leaseSeconds, 30, 900)) return fail('leaseSeconds must be 30 to 900.')

  return ok({
    jobId: body.jobId,
    claimToken: body.claimToken,
    ...(body.leaseSeconds !== undefined ? { leaseSeconds: body.leaseSeconds as number } : {}),
  })
}

export function parseCheckpoint(body: Body): Parsed<WorkerCheckpointRequest> {
  const ref = parseJobRef(body)
  if (!ref.ok) return ref
  if (!isRecord(body.checkpoint)) return fail('checkpoint must be an object.')
  if (jsonSize(body.checkpoint) > MAX_CHECKPOINT_BYTES) return fail('checkpoint is too large.')
  if (containsSecretKey(body.checkpoint)) return fail('A checkpoint must never carry a credential.')

  return ok({ jobId: ref.value.jobId, claimToken: ref.value.claimToken, checkpoint: body.checkpoint })
}

export function parseComplete(body: Body): Parsed<WorkerCompleteRequest> {
  const ref = parseJobRef(body)
  if (!ref.ok) return ref
  if (!isRecord(body.result)) return fail('result must be an object.')
  if (jsonSize(body.result) > MAX_JSON_BYTES) return fail('result is too large.')
  if (containsSecretKey(body.result)) return fail('A result must never carry a credential.')

  return ok({ jobId: ref.value.jobId, claimToken: ref.value.claimToken, result: body.result as unknown as JobResult })
}

export function parseFail(body: Body): Parsed<WorkerFailRequest> {
  const ref = parseJobRef(body)
  if (!ref.ok) return ref
  const outcome = body.outcome
  if (outcome !== 'retry' && outcome !== 'failed' && outcome !== 'uncertain') return fail('outcome must be retry, failed or uncertain.')
  if (typeof body.errorCode !== 'string' || !ERROR_CODE_PATTERN.test(body.errorCode)) return fail('errorCode must be a short code.')
  if (!isText(body.message, 1000)) return fail('message must be at most 1000 characters.')
  if (!isOptional(body.providerRequestId, (value): value is string => isText(value, 200, 1))) {
    return fail('providerRequestId must be at most 200 characters.')
  }

  return ok({
    jobId: ref.value.jobId,
    claimToken: ref.value.claimToken,
    outcome: outcome as FailOutcome,
    errorCode: body.errorCode,
    message: body.message,
    ...(typeof body.providerRequestId === 'string' ? { providerRequestId: body.providerRequestId } : {}),
  })
}

// --- Results, per job kind ----------------------------------------------------------

function isAssetFile(value: unknown): value is AssetFile {
  return (
    isRecord(value) &&
    isText(value.path, 500, 1) &&
    !value.path.includes('..') &&
    FILE_MIME.includes(value.mimeType as string) &&
    isInt(value.byteSize, 1, MAX_FILE_BYTES) &&
    isInt(value.width, 1, 8192) &&
    isInt(value.height, 1, 8192) &&
    typeof value.checksum === 'string' &&
    /^[0-9a-f]{64}$/.test(value.checksum)
  )
}

function isAssetFiles(value: unknown): value is AssetFiles {
  if (!isRecord(value) || !isAssetFile(value.original)) return false
  const renditions = value.renditions ?? {}
  return (
    isRecord(renditions) &&
    Object.entries(renditions).every(([purpose, file]) => (purpose === 'social' || purpose === 'email') && isAssetFile(file))
  )
}

function isStringList(value: unknown, maxItems: number, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= maxItems && value.every((entry) => isText(entry, maxLength))
}

function isUsage(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number'))
}

function isGeneratedVariant(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    (CONTENT_CHANNELS as readonly unknown[]).includes(value.channel) &&
    isText(value.style, 40, 1) &&
    isText(value.body, 10000) &&
    isStringList(value.hashtags, 30, 60) &&
    isOptional(value.callToAction, (entry): entry is string => isText(entry, 500)) &&
    isOptional(value.linkUrl, (entry): entry is string => typeof entry === 'string' && isHttpsUrl(entry)) &&
    (value.fields === undefined || (isRecord(value.fields) && Object.values(value.fields).every((entry) => isText(entry, 10000)))) &&
    isStringList(value.violations, 50, 500) &&
    isOptional(value.promptVersion, (entry): entry is string => isText(entry, 100, 1))
  )
}

function isGenerationFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    (CONTENT_CHANNELS as readonly unknown[]).includes(value.channel) &&
    isText(value.errorCode, 80, 1) &&
    isText(value.message, 1000)
  )
}

function checkGenerateText(result: Body): string | null {
  if (!Array.isArray(result.variants) || result.variants.length === 0 || result.variants.length > 12) {
    return 'variants must list 1 to 12 generated variants; report a total failure with fail.'
  }
  if (!result.variants.every(isGeneratedVariant)) return 'A generated variant has an invalid shape.'
  if (!Array.isArray(result.failures) || !result.failures.every(isGenerationFailure)) return 'failures must list channel failures.'
  if (!isText(result.promptVersion, 100, 1) || !isText(result.model, 100, 1)) return 'promptVersion and model are required.'
  if (result.warnings !== undefined && !isStringList(result.warnings, 50, 500)) return 'warnings must list short messages.'
  return null
}

function checkGenerateImage(result: Body): string | null {
  if (!Array.isArray(result.assets) || result.assets.length === 0 || result.assets.length > 4) return 'assets must list 1 to 4 images.'
  const valid = result.assets.every(
    (asset) => isRecord(asset) && isAssetFiles(asset.files) && isOptional(asset.alt, (alt): alt is string => isText(alt, 500))
  )
  if (!valid) return 'An image has an invalid file description.'
  return isText(result.model, 100, 1) ? null : 'model is required.'
}

function checkIngest(result: Body): string | null {
  if (result.status === 'rejected') return isText(result.reason, 500, 1) ? null : 'A rejection needs a reason.'
  if (result.status === 'ready') return isAssetFiles(result.files) ? null : 'files has an invalid file description.'
  return 'status must be ready or rejected.'
}

function checkPublish(result: Body): string | null {
  if (!isText(result.externalId, 500, 1)) return 'externalId is required; report an unnamed post as uncertain.'
  if (!isOptional(result.permalink, (entry): entry is string => typeof entry === 'string' && isHttpsUrl(entry))) {
    return 'permalink must be an https URL or null.'
  }
  return null
}

const RESULT_CHECKS: Record<JobKind, (result: Body) => string | null> = {
  generate_text: checkGenerateText,
  generate_image: checkGenerateImage,
  ingest_asset: checkIngest,
  publish_social: checkPublish,
}

/** Validates a completion result against the job's kind. */
export function validateJobResult(kind: JobKind, result: unknown): Parsed<JobResult> {
  if (!isRecord(result)) return fail('result must be an object.')
  const problem = RESULT_CHECKS[kind](result)
  if (problem) return fail(problem)
  if (!isOptional(result.providerRequestId, (entry): entry is string => isText(entry, 200, 1)) || !isUsage(result.usage)) {
    return fail('providerRequestId or usage has an invalid shape.')
  }
  return ok(result as unknown as JobResult)
}
