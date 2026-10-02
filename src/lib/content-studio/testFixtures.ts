/**
 * Row factories for Content Studio unit tests. Test-only: imported by *.test.ts files.
 */
import type {
  ContentAssetRow,
  ContentBrandProfileRow,
  ContentItemRow,
  ContentJobRow,
  ContentPublishedAssetRow,
  ContentReviewRow,
  ContentVariantRevisionRow,
  ContentVariantRow,
  SocialAccountRow,
  SocialPublicationRow,
} from '@/lib/db/types'

export const IDS = {
  brand: '00000000-0000-4000-8000-00000000b001',
  item: '00000000-0000-4000-8000-00000000c001',
  variant: '00000000-0000-4000-8000-00000000d001',
  revision: '00000000-0000-4000-8000-00000000e001',
  revision2: '00000000-0000-4000-8000-00000000e002',
  asset: '00000000-0000-4000-8000-00000000a001',
  asset2: '00000000-0000-4000-8000-00000000a002',
  job: '00000000-0000-4000-8000-00000000f001',
  token: '00000000-0000-4000-8000-0000000070c1',
  account: '00000000-0000-4000-8000-000000000ac1',
  publication: '00000000-0000-4000-8000-000000000b0b',
  published: '00000000-0000-4000-8000-000000000bb1',
  user: '00000000-0000-4000-8000-000000000001',
} as const

const T = '2026-10-07T00:00:00.000Z'

export function brandRow(overrides: Partial<ContentBrandProfileRow> = {}): ContentBrandProfileRow {
  return {
    id: IDS.brand,
    slug: 'ai4l',
    name: 'AI4L',
    tone: 'Clear',
    audience: 'Businesses',
    region: 'AU',
    approved_facts: [{ id: 'f1', text: 'Founded 2020', source: 'site' }],
    channel_rules: { linkedin: { cta: 'Book a call' } },
    hashtag_seeds: ['AI4L'],
    image_direction: 'Warm',
    allowed_link_origins: ['https://ai4l.example'],
    created_at: T,
    updated_at: T,
    archived_at: null,
    ...overrides,
  }
}

export function itemRow(overrides: Partial<ContentItemRow> = {}): ContentItemRow {
  return {
    id: IDS.item,
    brand_id: IDS.brand,
    title: 'Launch',
    brief: { topic: 'AI adoption' },
    channels: ['linkedin', 'email'],
    created_by: IDS.user,
    created_at: T,
    updated_at: T,
    archived_at: null,
    removed_at: null,
    removed_by: null,
    ...overrides,
  }
}

export function variantRow(overrides: Partial<ContentVariantRow> = {}): ContentVariantRow {
  return {
    id: IDS.variant,
    item_id: IDS.item,
    channel: 'linkedin',
    style: 'default',
    current_revision_id: IDS.revision,
    conflict_of_revision_id: null,
    created_at: T,
    archived_at: null,
    ...overrides,
  }
}

export function revisionRow(overrides: Partial<ContentVariantRevisionRow> = {}): ContentVariantRevisionRow {
  return {
    id: IDS.revision,
    variant_id: IDS.variant,
    revision_number: 1,
    parent_revision_id: null,
    origin: 'generated',
    body: 'Hello world.',
    hashtags: ['AI4L'],
    call_to_action: 'Book now.',
    link_url: 'https://ai4l.example',
    fields: {},
    assets: [{ assetId: IDS.asset, alt: 'A photo', order: 0 }],
    facts: [],
    sources: [],
    violations: [],
    prompt_version: 'p1',
    job_id: null,
    idempotency_key: null,
    checksum: 'c'.repeat(64),
    created_by: IDS.user,
    created_at: T,
    ...overrides,
  }
}

export function reviewRow(overrides: Partial<ContentReviewRow> = {}): ContentReviewRow {
  return {
    id: '00000000-0000-4000-8000-000000000091',
    revision_id: IDS.revision,
    decision: 'approved',
    reason: null,
    actor_id: IDS.user,
    created_at: T,
    ...overrides,
  }
}

export function jobRow(overrides: Partial<ContentJobRow> = {}): ContentJobRow {
  return {
    id: IDS.job,
    kind: 'generate_text',
    status: 'running',
    idempotency_key: 'key-12345678',
    item_id: IDS.item,
    variant_id: null,
    base_revision_id: null,
    asset_id: null,
    publication_id: null,
    input: { itemId: IDS.item, channels: ['linkedin'], stylesPerChannel: 1, brief: { topic: 'AI adoption' } },
    attempts: 1,
    max_attempts: 3,
    next_attempt_at: T,
    claim_token: IDS.token,
    worker_id: 'w1',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    heartbeat_at: T,
    checkpoint: {},
    dispatch_started_at: null,
    cancel_requested_at: null,
    result: null,
    error_code: null,
    error_message: null,
    provider_request_id: null,
    usage: null,
    created_by: IDS.user,
    created_at: T,
    started_at: T,
    finished_at: null,
    resolved_by: null,
    resolution_note: null,
    ...overrides,
  }
}

export function assetRow(overrides: Partial<ContentAssetRow> = {}): ContentAssetRow {
  return {
    id: IDS.asset,
    brand_id: IDS.brand,
    item_id: IDS.item,
    origin: 'upload',
    ingest_status: 'ready',
    rejection_reason: null,
    quarantine_path: `uploads/${IDS.asset}/photo.png`,
    storage_path: `library/${IDS.asset}/original`,
    mime_type: 'image/png',
    byte_size: 1000,
    width: 800,
    height: 600,
    checksum: 'a'.repeat(64),
    renditions: {
      social: {
        path: `library/${IDS.asset}/social`,
        mimeType: 'image/jpeg',
        byteSize: 500,
        width: 800,
        height: 600,
        checksum: 'b'.repeat(64),
      },
    },
    alt_text: 'A photo',
    original_filename: 'photo.png',
    generation_prompt: null,
    job_id: null,
    created_by: IDS.user,
    created_at: T,
    archived_at: null,
    removed_at: null,
    removed_by: null,
    ...overrides,
  }
}

export function publishedAssetRow(overrides: Partial<ContentPublishedAssetRow> = {}): ContentPublishedAssetRow {
  return {
    id: IDS.published,
    asset_id: IDS.asset,
    purpose: 'social',
    storage_path: `p/${IDS.published}/${'b'.repeat(64)}.jpg`,
    public_url: `https://cdn.example/p/${IDS.published}.jpg`,
    checksum: 'b'.repeat(64),
    mime_type: 'image/jpeg',
    byte_size: 500,
    width: 800,
    height: 600,
    created_by: IDS.user,
    created_at: T,
    ...overrides,
  }
}

export function accountRow(overrides: Partial<SocialAccountRow> = {}): SocialAccountRow {
  return {
    id: IDS.account,
    brand_id: IDS.brand,
    platform: 'linkedin',
    provider: 'linkedin',
    external_id: 'urn:li:organization:1',
    display_name: 'AI4L',
    author_kind: 'organization',
    scopes: ['w_organization_social'],
    status: 'connected',
    last_error: null,
    health_checked_at: null,
    connected_by: IDS.user,
    created_at: T,
    updated_at: T,
    ...overrides,
  }
}

export function publicationRow(overrides: Partial<SocialPublicationRow> = {}): SocialPublicationRow {
  return {
    id: IDS.publication,
    revision_id: IDS.revision,
    variant_id: IDS.variant,
    account_id: IDS.account,
    job_id: IDS.job,
    status: 'queued',
    idempotency_key: 'pub-12345678',
    published_asset_ids: [IDS.published],
    checkpoint: {},
    external_id: null,
    permalink: null,
    error_code: null,
    error_message: null,
    requested_by: IDS.user,
    created_at: T,
    dispatch_started_at: null,
    finished_at: null,
    resolved_by: null,
    resolution_note: null,
    ...overrides,
  }
}

export const SESSION = { userId: IDS.user, email: 'op@example.com', role: 'operator' as const }

type StorageResult = { data: unknown; error: { message: string } | null }

/** A Storage double: `storage.from(bucket)` returns one recorded API per bucket. */
export function storageMock(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const buckets = new Map<string, Record<string, jest.Mock>>()
  const api = (bucket: string) => {
    if (!buckets.has(bucket)) {
      buckets.set(bucket, {
        createSignedUploadUrl: jest.fn(async (path: string) => ({
          data: { signedUrl: `https://storage.example/upload/${bucket}/${path}?token=t`, token: 't', path },
          error: null,
        })),
        createSignedUrls: jest.fn(async (paths: string[]) => ({
          data: paths.map((path) => ({ path, signedUrl: `https://storage.example/sign/${bucket}/${path}`, error: null })),
          error: null,
        })),
        createSignedUrl: jest.fn(async (path: string) => ({ data: { signedUrl: `https://storage.example/sign/${bucket}/${path}` }, error: null })),
        copy: jest.fn(async (_from: string, to: string) => ({ data: { path: to }, error: null })),
        getPublicUrl: jest.fn((path: string) => ({ data: { publicUrl: `https://storage.example/public/${bucket}/${path}` } })),
        ...overrides,
      })
    }
    return buckets.get(bucket) as Record<string, jest.Mock>
  }

  return {
    storage: {
      from: jest.fn(api),
      getBucket: jest.fn(async (): Promise<StorageResult> => ({ data: { id: 'b' }, error: null })),
      createBucket: jest.fn(async (): Promise<StorageResult> => ({ data: { name: 'b' }, error: null })),
    },
    bucket: api,
  }
}
