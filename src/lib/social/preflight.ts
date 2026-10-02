import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { ContentHttpError, throwIfDbError } from '@/lib/content-studio/errors'
import { isSocialPlatformEnabled } from '@/lib/content-studio/flags'
import { composePostText, formatHashtag, PLATFORM_LIMITS } from '@/lib/content-studio/postText'
import type { PreflightIssue, PublishPreflight, PublishRequest } from '@/lib/content-studio/types'
import type {
  ContentAssetRow,
  ContentVariantRevisionRow,
  ContentVariantRow,
  Database,
  SocialAccountRow,
} from '@/lib/db/types'

import { loadAccountTokens, type SocialTokens } from './credentials'
import { evaluateContentRules, type RuleImage } from './preflightRules'

/**
 * Server-authoritative publish preflight. The dialog shows its result; the POST route
 * runs it again and refuses anything blocking. Content rules come from preflightRules.ts
 * (shared with the engine); the rest needs the database: current + approved revision,
 * a connected account on the right platform, the platform flag, a usable token, and
 * ready, unarchived images.
 */

type Db = SupabaseClient<Database>

export const TOKEN_EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000

type RevisionAssetRef = { assetId: string; alt: string; order: number }

export type TokenState = { kind: 'present'; tokens: SocialTokens } | { kind: 'missing' } | { kind: 'unreadable' }

export type PreflightFacts = {
  revision: ContentVariantRevisionRow
  variant: ContentVariantRow
  account: SocialAccountRow
  approved: boolean
  /** One entry per revision asset ref, in stored order; null when the asset row is gone. */
  assets: (ContentAssetRow | null)[]
  token: TokenState
  now: Date
}

const blocking = (code: string, message: string): PreflightIssue => ({ code, message, blocking: true })
const warning = (code: string, message: string): PreflightIssue => ({ code, message, blocking: false })

export function revisionAssetRefs(revision: ContentVariantRevisionRow): RevisionAssetRef[] {
  const raw: unknown = revision.assets
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (ref): ref is RevisionAssetRef => typeof ref === 'object' && ref !== null && typeof (ref as RevisionAssetRef).assetId === 'string'
  )
}

/** Width/height/format of what will be posted: the social rendition, else the original. */
export function socialImage(asset: ContentAssetRow): RuleImage {
  const rendition = asset.renditions?.social
  if (rendition) return { mimeType: rendition.mimeType, width: rendition.width, height: rendition.height }
  return { mimeType: asset.mime_type ?? '', width: asset.width ?? 0, height: asset.height ?? 0 }
}

function authorisationIssues({ revision, variant, account, approved }: PreflightFacts): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  if (variant.current_revision_id !== revision.id) {
    issues.push(blocking('stale_revision', 'A newer revision of this post exists. Review that one instead.'))
  } else if (!approved) {
    issues.push(blocking('not_approved', 'Only an approved revision can be published.'))
  }
  if (account.status !== 'connected') {
    issues.push(blocking('account_not_connected', `${account.display_name} needs to be reconnected in Settings.`))
  }
  if (variant.channel !== account.platform) {
    issues.push(blocking('channel_mismatch', `This post is for ${variant.channel}, not ${account.platform}.`))
  }
  if (!isSocialPlatformEnabled(account.platform)) {
    issues.push(blocking('platform_disabled', `Publishing to ${account.platform} is not enabled.`))
  }
  return issues
}

function tokenIssues({ token, now }: PreflightFacts): PreflightIssue[] {
  if (token.kind === 'missing') return [blocking('token_missing', 'The account has no stored credentials. Reconnect it in Settings.')]
  if (token.kind === 'unreadable') return [blocking('token_unreadable', 'The stored credentials cannot be read. Reconnect the account in Settings.')]
  const expiresAt = token.tokens.expiresAt ? Date.parse(token.tokens.expiresAt) : Number.NaN
  if (Number.isNaN(expiresAt)) return []
  if (expiresAt <= now.getTime()) return [blocking('token_expired', 'The connection has expired. Reconnect it in Settings.')]
  if (expiresAt - now.getTime() < TOKEN_EXPIRY_WARNING_MS) {
    return [warning('token_expiring', 'The connection expires within three days. Reconnect it soon.')]
  }
  return []
}

function assetIssues(facts: PreflightFacts): { issues: PreflightIssue[]; images: RuleImage[] } {
  const issues: PreflightIssue[] = []
  const images: RuleImage[] = []
  facts.assets.forEach((asset, index) => {
    const label = `Image ${index + 1}`
    if (!asset || asset.removed_at) issues.push(blocking('asset_missing', `${label} no longer exists.`))
    else if (asset.archived_at) issues.push(blocking('asset_archived', `${label} is archived. Restore it or choose another.`))
    else if (asset.ingest_status !== 'ready') issues.push(blocking('asset_not_ready', `${label} is not ready yet.`))
    else images.push(socialImage(asset))
  })
  return { issues, images }
}

export function composedTextOf(revision: ContentVariantRevisionRow): string {
  return composePostText(revision.body, revision.call_to_action, revision.hashtags ?? [])
}

/** Pure: every issue for these facts, blocking first. */
export function evaluatePreflight(facts: PreflightFacts): PublishPreflight {
  const platform = facts.account.platform
  const composedText = composedTextOf(facts.revision)
  const hashtagCount = (facts.revision.hashtags ?? []).map(formatHashtag).filter((tag) => tag !== '').length
  const { issues: imageIssues, images } = assetIssues(facts)
  const contentIssues = evaluateContentRules({ platform, text: composedText, hashtagCount, images })

  const extra: PreflightIssue[] = []
  if (facts.revision.link_url && (platform !== 'facebook' || images.length > 0)) {
    extra.push(warning('link_not_posted', `The link is not attached on ${platform}${platform === 'facebook' ? ' when the post has images' : ''}; include it in the text if it matters.`))
  }

  const all = [...authorisationIssues(facts), ...tokenIssues(facts), ...imageIssues, ...contentIssues, ...extra]
  const issues = [...all.filter((issue) => issue.blocking), ...all.filter((issue) => !issue.blocking)]
  return {
    ok: !issues.some((issue) => issue.blocking),
    platform,
    composedText,
    limits: PLATFORM_LIMITS[platform],
    issues,
  }
}

async function readToken(accountId: string, admin: Db): Promise<TokenState> {
  try {
    const tokens = await loadAccountTokens(accountId, admin)
    return tokens ? { kind: 'present', tokens } : { kind: 'missing' }
  } catch {
    // A key rotation or a tampered envelope: never surface the reason.
    return { kind: 'unreadable' }
  }
}

async function readAssets(db: Db, refs: RevisionAssetRef[]): Promise<(ContentAssetRow | null)[]> {
  if (refs.length === 0) return []
  const { data, error } = await db.from('content_assets').select('*').in('id', refs.map((ref) => ref.assetId))
  throwIfDbError(error)
  const byId = new Map(((data ?? []) as ContentAssetRow[]).map((row) => [row.id, row]))
  return refs.map((ref) => byId.get(ref.assetId) ?? null)
}

/** Reads every fact a preflight needs. 404 when the revision or the account does not exist. */
export async function loadPreflightFacts(db: Db, admin: Db, request: Pick<PublishRequest, 'revisionId' | 'accountId'>): Promise<PreflightFacts> {
  const { data: revision, error: revisionError } = await db
    .from('content_variant_revisions').select('*').eq('id', request.revisionId).maybeSingle()
  throwIfDbError(revisionError)
  if (!revision) throw new ContentHttpError(404, 'Revision not found.')

  const [variantResult, accountResult, approvedResult] = await Promise.all([
    db.from('content_variants').select('*').eq('id', revision.variant_id).maybeSingle(),
    db.from('social_accounts').select('*').eq('id', request.accountId).maybeSingle(),
    db.rpc('content_revision_is_approved', { p_revision_id: request.revisionId }),
  ])
  throwIfDbError(variantResult.error)
  throwIfDbError(accountResult.error)
  throwIfDbError(approvedResult.error)
  if (!variantResult.data) throw new ContentHttpError(404, 'Revision not found.')
  if (!accountResult.data) throw new ContentHttpError(404, 'Account not found.')

  const [assets, token] = await Promise.all([
    readAssets(db, revisionAssetRefs(revision as ContentVariantRevisionRow)),
    readToken(request.accountId, admin),
  ])
  return {
    revision: revision as ContentVariantRevisionRow,
    variant: variantResult.data as ContentVariantRow,
    account: accountResult.data as SocialAccountRow,
    approved: approvedResult.data === true,
    assets,
    token,
    now: new Date(),
  }
}

export async function runPreflight(db: Db, admin: Db, request: Pick<PublishRequest, 'revisionId' | 'accountId'>): Promise<{ preflight: PublishPreflight; facts: PreflightFacts }> {
  const facts = await loadPreflightFacts(db, admin, request)
  return { preflight: evaluatePreflight(facts), facts }
}
