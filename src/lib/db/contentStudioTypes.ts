/**
 * Row and RPC types for supabase/migrations/20261007000000_content_studio.sql.
 *
 * Hand-written like src/lib/db/types.ts (which composes these into `Database`). Kept in
 * their own module so the database contract of the Content Studio can be read — and
 * reviewed against its migration — in one place. Domain/API shapes (camelCase) live in
 * src/lib/content-studio/types.ts; these are the snake_case database rows.
 */
import type {
  AssetOrigin,
  ContentChannel,
  IngestStatus,
  JobKind,
  JobStatus,
  PublicationStatus,
  RenditionPurpose,
  RevisionOrigin,
  ReviewDecision,
  SocialAccountStatus,
  SocialAuthorKind,
  SocialPlatform,
  SocialProvider,
} from '@/lib/content-studio/types'

type Json = unknown

export type ContentBrandProfileRow = {
  id: string
  slug: string
  name: string
  tone: string
  audience: string
  region: string
  approved_facts: Json
  channel_rules: Json
  hashtag_seeds: string[]
  image_direction: string
  allowed_link_origins: string[]
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type ContentItemRow = {
  id: string
  brand_id: string
  title: string
  brief: Json
  channels: ContentChannel[]
  created_by: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  removed_at: string | null
  removed_by: string | null
}

export type ContentVariantRow = {
  id: string
  item_id: string
  channel: ContentChannel
  style: string
  current_revision_id: string | null
  conflict_of_revision_id: string | null
  created_at: string
  archived_at: string | null
}

export type ContentVariantRevisionRow = {
  id: string
  variant_id: string
  revision_number: number
  parent_revision_id: string | null
  origin: RevisionOrigin
  body: string
  hashtags: string[]
  call_to_action: string | null
  link_url: string | null
  fields: Record<string, string>
  assets: Array<{ assetId: string; alt: string; order: number }>
  facts: Json
  sources: Json
  violations: Json
  prompt_version: string | null
  job_id: string | null
  idempotency_key: string | null
  checksum: string
  created_by: string | null
  created_at: string
}

export type ContentReviewRow = {
  id: string
  revision_id: string
  decision: ReviewDecision
  reason: string | null
  actor_id: string | null
  created_at: string
}

export type ContentAssetFileRow = {
  path: string
  mimeType: string
  byteSize: number
  width: number
  height: number
  checksum: string
}

export type ContentAssetRow = {
  id: string
  brand_id: string
  item_id: string | null
  origin: AssetOrigin
  ingest_status: IngestStatus
  rejection_reason: string | null
  quarantine_path: string | null
  storage_path: string | null
  mime_type: string | null
  byte_size: number | null
  width: number | null
  height: number | null
  checksum: string | null
  renditions: Partial<Record<RenditionPurpose, ContentAssetFileRow>>
  alt_text: string
  original_filename: string | null
  generation_prompt: string | null
  job_id: string | null
  created_by: string | null
  created_at: string
  archived_at: string | null
  removed_at: string | null
  removed_by: string | null
}

export type ContentPublishedAssetRow = {
  id: string
  asset_id: string
  purpose: RenditionPurpose
  storage_path: string
  public_url: string
  checksum: string
  mime_type: string
  byte_size: number
  width: number
  height: number
  created_by: string | null
  created_at: string
}

export type SocialAccountRow = {
  id: string
  brand_id: string
  platform: SocialPlatform
  provider: SocialProvider
  external_id: string
  display_name: string
  author_kind: SocialAuthorKind
  scopes: string[]
  status: SocialAccountStatus
  last_error: string | null
  health_checked_at: string | null
  connected_by: string | null
  created_at: string
  updated_at: string
}

/** Service role only. Values are secretBox envelopes, never plaintext. */
export type SocialAccountSecretRow = {
  account_id: string
  access_token: string
  refresh_token: string | null
  key_version: number
  expires_at: string | null
  updated_at: string
}

/** Service role only. */
export type SocialOauthStateRow = {
  state_hash: string
  provider: SocialProvider
  actor_id: string
  brand_id: string
  options: Json
  created_at: string
  expires_at: string
  consumed_at: string | null
}

export type SocialPublicationRow = {
  id: string
  revision_id: string
  variant_id: string
  account_id: string
  job_id: string | null
  status: PublicationStatus
  idempotency_key: string
  published_asset_ids: string[]
  checkpoint: Json
  external_id: string | null
  permalink: string | null
  error_code: string | null
  error_message: string | null
  requested_by: string | null
  created_at: string
  dispatch_started_at: string | null
  finished_at: string | null
  resolved_by: string | null
  resolution_note: string | null
}

export type ContentJobRow = {
  id: string
  kind: JobKind
  status: JobStatus
  idempotency_key: string
  item_id: string | null
  variant_id: string | null
  base_revision_id: string | null
  asset_id: string | null
  publication_id: string | null
  input: Json
  attempts: number
  max_attempts: number
  next_attempt_at: string
  claim_token: string | null
  worker_id: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  checkpoint: Json
  dispatch_started_at: string | null
  cancel_requested_at: string | null
  result: Json | null
  error_code: string | null
  error_message: string | null
  provider_request_id: string | null
  usage: Json | null
  created_by: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  resolved_by: string | null
  resolution_note: string | null
}

export type ContentAuditEventRow = {
  id: string
  actor_id: string | null
  action: string
  subject_type: string
  subject_id: string | null
  details: Json
  created_at: string
}

export type EmailCtaMode = 'booking' | 'external_url' | 'none'

/** 20261007010000_campaign_content_snapshots.sql — immutable. */
export type CampaignContentSnapshotRow = {
  id: string
  purpose: 'campaign' | 'export'
  source_revision_id: string
  template_id: string | null
  contract_id: string
  contract_version: number
  cta_mode: EmailCtaMode
  cta_url: string | null
  subject: string | null
  fields: Record<string, string>
  assets: Array<{ assetId: string; publishedAssetId: string; url: string; checksum: string; alt: string; order: number }>
  rendered_html: string | null
  rendered_text: string | null
  content_hash: string
  idempotency_key: string
  created_by: string | null
  created_at: string
}

type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] }

export type ContentStudioTables = {
  content_brand_profiles: Table<ContentBrandProfileRow>
  content_items: Table<ContentItemRow>
  content_variants: Table<ContentVariantRow>
  content_variant_revisions: Table<ContentVariantRevisionRow>
  content_reviews: Table<ContentReviewRow>
  content_assets: Table<ContentAssetRow>
  content_published_assets: Table<ContentPublishedAssetRow>
  social_accounts: Table<SocialAccountRow>
  social_account_secrets: Table<SocialAccountSecretRow>
  social_oauth_states: Table<SocialOauthStateRow>
  social_publications: Table<SocialPublicationRow>
  content_jobs: Table<ContentJobRow>
  content_audit_events: Table<ContentAuditEventRow>
  campaign_content_snapshots: Table<CampaignContentSnapshotRow>
}

export type ClaimedContentJobRow = {
  job_id: string
  kind: JobKind
  claim_token: string
  attempt: number
  input: Json
  checkpoint: Json
}

export type ContentStudioFunctions = {
  create_content_revision: {
    Args: { p_variant_id: string; p_expected_revision_id: string | null; p_content: Json; p_idempotency_key: string }
    Returns: ContentVariantRevisionRow
  }
  duplicate_content_variant: {
    Args: { p_variant_id: string; p_idempotency_key: string }
    Returns: ContentVariantRow
  }
  review_content_revision: {
    Args: { p_revision_id: string; p_decision: ReviewDecision; p_reason?: string | null }
    Returns: ContentReviewRow
  }
  content_revision_is_approved: { Args: { p_revision_id: string }; Returns: boolean }
  update_content_brand_profile: {
    Args: { p_slug: string; p_profile: Json }
    Returns: ContentBrandProfileRow
  }
  record_content_audit: {
    Args: { p_action: string; p_subject_type: string; p_subject_id: string; p_details?: Json }
    Returns: undefined
  }
  enqueue_content_job: {
    Args: {
      p_kind: Exclude<JobKind, 'publish_social'>
      p_idempotency_key: string
      p_item_id?: string | null
      p_variant_id?: string | null
      p_base_revision_id?: string | null
      p_asset_id?: string | null
      p_input?: Json
    }
    Returns: ContentJobRow
  }
  cancel_content_job: { Args: { p_job_id: string }; Returns: ContentJobRow }
  request_social_publication: {
    Args: { p_revision_id: string; p_account_id: string; p_published_asset_ids: string[]; p_idempotency_key: string }
    Returns: SocialPublicationRow
  }
  resolve_uncertain_content_job: {
    Args: {
      p_job_id: string
      p_resolution: 'succeeded' | 'failed'
      p_note: string
      p_external_id?: string | null
      p_permalink?: string | null
    }
    Returns: ContentJobRow
  }
  recover_content_jobs: { Args: Record<string, never>; Returns: number }
  claim_content_jobs: {
    Args: { p_worker_id: string; p_kinds: JobKind[] | null; p_limit: number; p_lease_seconds?: number }
    Returns: ClaimedContentJobRow[]
  }
  heartbeat_content_job: {
    Args: { p_job_id: string; p_token: string; p_lease_seconds?: number }
    Returns: 'ok' | 'cancel_requested' | 'lost'
  }
  checkpoint_content_job: { Args: { p_job_id: string; p_token: string; p_checkpoint: Json }; Returns: boolean }
  begin_content_dispatch: { Args: { p_job_id: string; p_token: string }; Returns: 'go' | 'lost' | 'refused' }
  complete_content_job: { Args: { p_job_id: string; p_token: string; p_result: Json }; Returns: boolean }
  fail_content_job: {
    Args: {
      p_job_id: string
      p_token: string
      p_outcome: 'retry' | 'failed' | 'uncertain'
      p_error_code: string
      p_message: string
      p_provider_request_id?: string | null
    }
    Returns: boolean
  }
  create_content_email_snapshot: {
    Args: {
      p_purpose: 'campaign' | 'export'
      p_idempotency_key: string
      p_source_revision_id: string
      p_template_id: string | null
      p_cta_mode: EmailCtaMode
      p_cta_url: string | null
      p_subject: string | null
      p_fields: Record<string, string>
      p_assets: Json
      p_rendered_html: string | null
      p_rendered_text: string | null
      p_campaign_name?: string | null
      p_segment_id?: string | null
      p_notes?: string | null
      /** Required: the function is service-role only, so the member acting is passed explicitly. */
      p_actor: string
    }
    Returns: { snapshotId: string; campaignId: string | null; created: boolean; contentHash: string }
  }
}
