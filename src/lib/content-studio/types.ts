/**
 * Content Studio shared contract (CRM side).
 *
 * The single source of truth for:
 *   - domain types mirrored from supabase/migrations/20261007000000_content_studio.sql
 *   - the browser ⇄ CRM API DTOs (src/app/api/content-studio/*, src/app/api/social/*)
 *   - the CRM ⇄ content-engine worker protocol v1 (src/app/api/internal/content-worker/v1/*)
 *
 * The Python side mirrors the worker protocol in services/content-engine/app/contracts.py.
 * Both sides test against shared/content-contracts/fixtures, so a drift fails a test on
 * whichever side changed. See docs/CONTENT_STUDIO_CONTRACTS.md.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export const CONTENT_CHANNELS = ['facebook', 'instagram', 'linkedin', 'email'] as const
export type ContentChannel = (typeof CONTENT_CHANNELS)[number]

export const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'linkedin'] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

export const JOB_KINDS = ['generate_text', 'generate_image', 'ingest_asset', 'publish_social'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

/** Terminal states: the UI stops polling. 'uncertain' needs a person, not a poll. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled', 'uncertain']

export type RevisionOrigin = 'generated' | 'regenerated' | 'edited' | 'duplicated'
export type ReviewDecision = 'approved' | 'rejected'

/** Derived per revision: the latest review decides; no review means pending. */
export type ReviewState = 'pending' | ReviewDecision

export type AssetOrigin = 'upload' | 'generated'
export type IngestStatus = 'pending' | 'ready' | 'rejected'
export type RenditionPurpose = 'social' | 'email'

export type SocialProvider = 'meta' | 'linkedin' | 'mock'
export type SocialAuthorKind = 'page' | 'instagram_business' | 'organization' | 'member'
export type SocialAccountStatus = 'connected' | 'needs_reauth' | 'disconnected'
export type PublicationStatus = 'queued' | 'dispatching' | 'published' | 'failed' | 'uncertain' | 'cancelled'

/** Length and count limits enforced by preflight in both TS and Python (publishing/rules). */
export interface PlatformLimits {
  maxChars: number
  maxHashtags: number
  maxImages: number
  requiresImage: boolean
}

export interface ContentBrief {
  topic: string
  audience?: string
  objective?: string
  notes?: string
  /** https only; fetched by the worker behind SSRF limits, treated as untrusted data. */
  referenceUrl?: string
  /** Facts the operator vouches for. Merged with the brand profile's approved facts. */
  sourceFacts?: string[]
}

export interface ApprovedFact {
  id: string
  text: string
  source?: string
}

export interface ChannelRule {
  cta?: string
  structure?: string
}

export interface BrandProfile {
  id: string
  slug: string
  name: string
  tone: string
  audience: string
  region: string
  approvedFacts: ApprovedFact[]
  channelRules: Partial<Record<ContentChannel, ChannelRule>>
  hashtagSeeds: string[]
  imageDirection: string
  allowedLinkOrigins: string[]
}

/** One selected image on a revision, in display order, with its alt text. */
export interface RevisionAssetRef {
  assetId: string
  alt: string
  order: number
}

/**
 * Structured email slots, produced by generation for the 'email' channel or by the
 * social→email adaptation. Keys follow the `studio-newsletter-v1` template contract
 * (src/lib/marketing/templateContracts.ts).
 */
export type RevisionFields = Record<string, string>

/** The editable content of a revision. Everything here is covered by the checksum. */
export interface RevisionContent {
  body: string
  hashtags: string[]
  callToAction: string | null
  linkUrl: string | null
  fields: RevisionFields
  assets: RevisionAssetRef[]
}

export interface ContentRevision extends RevisionContent {
  id: string
  variantId: string
  revisionNumber: number
  parentRevisionId: string | null
  origin: RevisionOrigin
  facts: unknown[]
  sources: unknown[]
  /** Validation messages from generation (length, missing CTA…). Informational. */
  violations: string[]
  promptVersion: string | null
  jobId: string | null
  checksum: string
  createdBy: string | null
  createdAt: string
  review: ReviewState
  reviewedAt: string | null
  reviewReason: string | null
}

export interface ContentVariant {
  id: string
  itemId: string
  channel: ContentChannel
  style: string
  currentRevisionId: string | null
  conflictOfRevisionId: string | null
  createdAt: string
  archivedAt: string | null
  current: ContentRevision | null
}

export interface ContentItemSummary {
  id: string
  title: string
  channels: ContentChannel[]
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  variantCount: number
  approvedCount: number
  pendingReviewCount: number
  activeJobCount: number
}

export interface ContentItem {
  id: string
  brandId: string
  title: string
  brief: ContentBrief
  channels: ContentChannel[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  variants: ContentVariant[]
  jobs: ContentJob[]
  publications: SocialPublication[]
}

export interface AssetFile {
  path: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  byteSize: number
  width: number
  height: number
  /** sha256 hex of the stored bytes. */
  checksum: string
}

export interface ContentAsset {
  id: string
  itemId: string | null
  origin: AssetOrigin
  ingestStatus: IngestStatus
  rejectionReason: string | null
  mimeType: string | null
  byteSize: number | null
  width: number | null
  height: number | null
  checksum: string | null
  altText: string
  originalFilename: string | null
  generationPrompt: string | null
  createdAt: string
  archivedAt: string | null
  /** Short-lived signed URL for a member preview. Never stored, never used in email. */
  previewUrl: string | null
  /** The ingest/generation job still working on this asset, so a reopened page can poll it. */
  activeJobId: string | null
}

export interface ContentJob {
  id: string
  kind: JobKind
  status: JobStatus
  itemId: string | null
  variantId: string | null
  assetId: string | null
  publicationId: string | null
  attempts: number
  maxAttempts: number
  errorCode: string | null
  errorMessage: string | null
  cancelRequestedAt: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Partial generation failures by channel, so only those can be repeated. */
  failures: GenerationFailure[]
  /** Non-fatal notes from the worker (e.g. an unreadable reference URL). */
  warnings: string[]
}

export interface SocialAccount {
  id: string
  platform: SocialPlatform
  provider: SocialProvider
  externalId: string
  displayName: string
  authorKind: SocialAuthorKind
  scopes: string[]
  status: SocialAccountStatus
  lastError: string | null
  healthCheckedAt: string | null
  createdAt: string
}

export interface SocialPublication {
  id: string
  revisionId: string
  variantId: string
  accountId: string
  jobId: string | null
  status: PublicationStatus
  externalId: string | null
  permalink: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  dispatchStartedAt: string | null
  finishedAt: string | null
  resolutionNote: string | null
}

// ---------------------------------------------------------------------------
// Browser ⇄ CRM API
// ---------------------------------------------------------------------------
// Errors use the CRM envelope `{ error: string }` (src/lib/api/responses.ts), plus an
// optional `code` for the cases the UI branches on.

export type ContentApiErrorCode =
  | 'stale_revision'
  | 'not_approved'
  | 'account_not_connected'
  | 'channel_mismatch'
  | 'asset_mismatch'
  | 'asset_not_ready'
  | 'already_published'
  | 'feature_disabled'
  | 'preflight_failed'
  | 'archived'
  | 'blocked_content'
  | 'asset_not_pending'
  | 'snapshot_content_locked'

export interface ContentApiError {
  error: string
  code?: ContentApiErrorCode
}

/** GET /api/content-studio/items?search=&status=active|archived&page=&pageSize= */
export interface ListItemsResponse {
  items: ContentItemSummary[]
  total: number
  page: number
  pageSize: number
}

/** POST /api/content-studio/items → 201 { item } */
export interface CreateItemRequest {
  title: string
  brief: ContentBrief
  channels: ContentChannel[]
}

/** PATCH /api/content-studio/items/[id] */
export interface UpdateItemRequest {
  title?: string
  brief?: ContentBrief
  channels?: ContentChannel[]
  archived?: boolean
}

/** GET /api/content-studio/items/[id] → { item: ContentItem } */
export interface ItemResponse {
  item: ContentItem
}

/**
 * POST /api/content-studio/items/[id]/generate → 202 { job }
 * Omit variantId for a fresh generation; pass variantId + baseRevisionId to regenerate.
 * `channels` repeats only the channels that failed last time, when needed.
 */
export interface GenerateRequest {
  idempotencyKey: string
  channels: ContentChannel[]
  stylesPerChannel?: 1 | 2 | 3
  variantId?: string
  baseRevisionId?: string
  instruction?: string
}

/** POST /api/content-studio/items/[id]/images → 202 { job } */
export interface GenerateImagesRequest {
  idempotencyKey: string
  prompt: string
  count: 1 | 2 | 3 | 4
  quality?: 'low' | 'medium' | 'high'
}

/** POST /api/content-studio/variants/[id]/revisions → 201 { revision } */
export interface SaveRevisionRequest {
  idempotencyKey: string
  expectedRevisionId: string | null
  content: RevisionContent
}

/** PATCH /api/content-studio/variants/[id] → { variant }. Archive only; content changes are revisions. */
export interface UpdateVariantRequest {
  archived: boolean
}

/** POST /api/content-studio/variants/[id]/duplicate → 201 { variant } */
export interface DuplicateVariantRequest {
  idempotencyKey: string
}

/** POST /api/content-studio/variants/[id]/review → 201 { review } */
export interface ReviewRequest {
  revisionId: string
  decision: ReviewDecision
  reason?: string
}

/** GET /api/content-studio/variants/[id]/export → text/asset export for manual posting. */
export interface VariantExport {
  channel: ContentChannel
  revisionId: string
  text: string
  assets: { assetId: string; alt: string; downloadUrl: string }[]
}

/**
 * POST /api/content-studio/assets → 201 { asset, upload }
 * The browser uploads the bytes straight to Storage with the signed URL, then calls
 * POST /api/content-studio/assets/[id]/ingest → 202 { job }.
 */
export interface CreateUploadRequest {
  filename: string
  mimeType: string
  byteSize: number
  itemId?: string
}

export interface CreateUploadResponse {
  asset: ContentAsset
  upload: { signedUrl: string; token: string; path: string }
}

/** GET /api/content-studio/assets?itemId=&page=&pageSize= */
export interface ListAssetsResponse {
  assets: ContentAsset[]
  total: number
}

/** GET /api/content-studio/jobs/[id] → { job }; POST .../cancel; POST .../resolve */
export interface ResolveJobRequest {
  resolution: 'succeeded' | 'failed'
  note: string
  externalId?: string
  permalink?: string
}

/** GET /api/social/accounts → { accounts, enabledPlatforms } */
export interface ListAccountsResponse {
  accounts: SocialAccount[]
  enabledPlatforms: SocialPlatform[]
}

/**
 * GET /api/social/publications?itemId= → { publications: SocialPublication[] }
 * Without itemId: the most recent publications across items (Publications tab).
 * POST /api/social/publications/preflight → { preflight: PublishPreflight }
 * POST /api/social/publications → 202 { publication: SocialPublication }
 */
export interface PublishRequest {
  revisionId: string
  accountId: string
  idempotencyKey: string
}

export interface PreflightIssue {
  code: string
  message: string
  blocking: boolean
}

export interface PublishPreflight {
  ok: boolean
  platform: SocialPlatform
  composedText: string
  limits: PlatformLimits
  issues: PreflightIssue[]
}

// ---------------------------------------------------------------------------
// CRM ⇄ content-engine worker protocol v1
// ---------------------------------------------------------------------------
// All endpoints: POST /api/internal/content-worker/v1/<op>, JSON body, signed with
// CONTENT_WORKER_SECRET (see src/lib/content-studio/workerAuth.ts):
//   X-Content-Worker-Timestamp: <unix seconds>
//   X-Content-Worker-Signature: v1=<hex hmac_sha256(secret, `${ts}.${METHOD}.${path}.${body}`)>
// Tolerance 300 s. Every mutation also carries the job's claim token.

export const WORKER_PROTOCOL_VERSION = 'v1'
export const WORKER_OPS = ['claim', 'heartbeat', 'context', 'checkpoint', 'begin-dispatch', 'complete', 'fail'] as const
export type WorkerOp = (typeof WORKER_OPS)[number]

export interface WorkerClaimRequest {
  workerId: string
  kinds: JobKind[]
  limit: number
  leaseSeconds?: number
}

export interface ClaimedJob {
  jobId: string
  kind: JobKind
  claimToken: string
  attempt: number
  input: JobInput
  checkpoint: Record<string, unknown>
}

export interface WorkerClaimResponse {
  jobs: ClaimedJob[]
}

export interface WorkerJobRef {
  jobId: string
  claimToken: string
}

export interface WorkerHeartbeatResponse {
  state: 'ok' | 'cancel_requested' | 'lost'
}

export interface WorkerCheckpointRequest extends WorkerJobRef {
  checkpoint: Record<string, unknown>
}

export interface WorkerBeginDispatchResponse {
  decision: 'go' | 'lost' | 'refused'
}

export interface WorkerCompleteRequest extends WorkerJobRef {
  result: JobResult
}

export type FailOutcome = 'retry' | 'failed' | 'uncertain'

export interface WorkerFailRequest extends WorkerJobRef {
  outcome: FailOutcome
  errorCode: string
  message: string
  providerRequestId?: string
}

/** Result of complete/fail/checkpoint: false means the lease was lost. */
export interface WorkerAckResponse {
  accepted: boolean
}

// --- Job inputs (stored in content_jobs.input — never a secret) ---------------

export interface GenerateTextInput {
  itemId: string
  channels: ContentChannel[]
  stylesPerChannel: number
  brief: ContentBrief
  variantId?: string
  baseRevisionId?: string
  instruction?: string
}

export interface GenerateImageInput {
  itemId: string
  prompt: string
  count: number
  quality: 'low' | 'medium' | 'high'
}

export interface IngestAssetInput {
  assetId: string
  quarantinePath: string
}

export interface PublishSocialInput {
  publicationId: string
}

export type JobInput = GenerateTextInput | GenerateImageInput | IngestAssetInput | PublishSocialInput

// --- Job context (built fresh by the CRM for the lease holder) ----------------

/**
 * Upload targets are created with upsert, so a retried job can rewrite the same path.
 * The CRM cannot know whether an image stays PNG (transparency) or becomes JPEG, so it
 * offers both extensions for `original` and `email` (original.jpg/original.png,
 * email.jpg/email.png) plus social.jpg; the worker writes only the ones it needs,
 * matched by file name. Generated images use generated/<jobId>/<n>/<same names>.
 */
export interface SignedUpload {
  /** Storage path the worker must write; complete() is refused for any other prefix. */
  path: string
  signedUrl: string
  token: string
}

export interface GenerateTextContext {
  kind: 'generate_text'
  brand: BrandProfile
  input: GenerateTextInput
  /** The revision being regenerated, if any, so the model can improve on it. */
  baseRevision: RevisionContent | null
  platformLimits: Record<ContentChannel, PlatformLimits>
}

export interface GenerateImageContext {
  kind: 'generate_image'
  brand: BrandProfile
  input: GenerateImageInput
  /** Destination prefix: generated/<jobId>/ ; one signed upload per file to write. */
  uploadPrefix: string
  uploads: SignedUpload[]
}

export interface IngestAssetContext {
  kind: 'ingest_asset'
  assetId: string
  source: { signedUrl: string; mimeType: string; byteSize: number; filename: string | null }
  /** Destination prefix: library/<assetId>/ */
  uploadPrefix: string
  uploads: SignedUpload[]
  maxDimension: number
}

export interface PublishImage {
  url: string
  alt: string
  mimeType: string
  width: number
  height: number
}

export interface PublishSocialContext {
  kind: 'publish_social'
  publicationId: string
  platform: SocialPlatform
  account: {
    id: string
    provider: SocialProvider
    externalId: string
    authorKind: SocialAuthorKind
    displayName: string
    /** Decrypted for this lease only. Never logged, never echoed back, never stored in a job. */
    accessToken: string
  }
  text: string
  linkUrl: string | null
  images: PublishImage[]
  checkpoint: Record<string, unknown>
}

export type JobContext = GenerateTextContext | GenerateImageContext | IngestAssetContext | PublishSocialContext

/** Response of POST .../v1/context. 409 { error } when the claim token no longer holds. */
export interface WorkerContextResponse {
  context: JobContext
}

// --- Job results ----------------------------------------------------------------

export interface GeneratedVariant {
  channel: ContentChannel
  style: string
  body: string
  hashtags: string[]
  callToAction: string | null
  linkUrl?: string | null
  fields?: RevisionFields
  violations: string[]
  promptVersion?: string
}

export interface GenerationFailure {
  channel: ContentChannel
  errorCode: string
  message: string
}

export interface GenerateTextResult {
  variants: GeneratedVariant[]
  failures: GenerationFailure[]
  promptVersion: string
  model: string
  providerRequestId?: string
  usage?: Record<string, number>
  /** Non-fatal notes for the operator, e.g. a reference URL that could not be read. */
  warnings?: string[]
}

export interface AssetFiles {
  original: AssetFile
  renditions: Partial<Record<RenditionPurpose, AssetFile>>
}

export interface GenerateImageResult {
  assets: { files: AssetFiles; alt?: string }[]
  model: string
  providerRequestId?: string
  usage?: Record<string, number>
}

export type IngestAssetResult = { status: 'ready'; files: AssetFiles } | { status: 'rejected'; reason: string }

export interface PublishSocialResult {
  externalId: string
  permalink: string | null
  providerRequestId?: string
}

export type JobResult = GenerateTextResult | GenerateImageResult | IngestAssetResult | PublishSocialResult
