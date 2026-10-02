import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

import { assessContent, type ResolvedContent } from './campaignContent'
import type { EmailOctopusCredentials } from './providers/credentials'
import { listMergeTags } from './providers/emailOctopus'
import { findMissingContractFields, templateChecklist } from './templateContracts'

/**
 * Preflight for a Content Studio campaign, on top of the audience checks every campaign
 * gets: the snapshot against its contract, its images against the revision it came
 * from, the provider list's fields against the contract, and the manual checklist for
 * what the EmailOctopus API cannot show (Automation HTML is not readable, EO-7).
 */

type Db = SupabaseClient<Database>

export type StudioPreflight = {
  snapshotId: string
  sourceRevisionId: string
  contract: string
  contractVersion: number
  ctaMode: ResolvedContent['ctaMode']
  contentHash: string | null
  /** Blocking: the campaign cannot send while any remain. */
  problems: string[]
  /** Provider fields the contract needs and the list lacks; null when it could not be read. */
  missingFields: string[] | null
  /** Checks a person must make in EmailOctopus. */
  checklist: string[]
}

type Deps = {
  dynamicEnabled: boolean
  credentials: EmailOctopusCredentials | null
  listTags?: typeof listMergeTags
}

async function imageProblems(db: Db, content: ResolvedContent): Promise<string[]> {
  const snapshot = content.snapshot
  if (!snapshot || (snapshot.assets ?? []).length === 0) return []

  const { data, error } = await db
    .from('content_variant_revisions')
    .select('id, assets')
    .eq('id', snapshot.source_revision_id)
    .maybeSingle()
  if (error) throw new Error(`Could not read the source revision: ${error.message}`)
  if (!data) return ['The Content Studio revision this email came from no longer exists.']

  const allowed = new Set((data.assets ?? []).map((ref) => String(ref.assetId)))
  const problems = snapshot.assets
    .filter((asset) => !allowed.has(asset.assetId))
    .map((asset) => `Image ${asset.assetId} is not one of the source revision's images.`)

  const imageSlot = content.contract.slots.find((slot) => slot.role === 'image')
  const heroUrl = imageSlot ? snapshot.fields?.[imageSlot.tag] : undefined
  if (heroUrl && !snapshot.assets.some((asset) => asset.url === heroUrl)) {
    problems.push('The hero image is not one of the published images recorded with this email.')
  }

  return problems
}

export async function studioPreflight(db: Db, content: ResolvedContent, deps: Deps): Promise<StudioPreflight | null> {
  const snapshot = content.snapshot
  if (!snapshot) return null

  const problems = [...assessContent(content, { dynamicEnabled: deps.dynamicEnabled }), ...(await imageProblems(db, content))]

  let missingFields: string[] | null = null
  if (deps.credentials) {
    const tags = await (deps.listTags ?? listMergeTags)(deps.credentials)
    if (tags.ok) {
      missingFields = findMissingContractFields(content.contract, tags.tags, content.ctaMode)
      if (missingFields.length > 0) {
        problems.push(`The EmailOctopus list is missing these fields: ${missingFields.join(', ')}.`)
      }
    } else {
      problems.push(`Could not read the EmailOctopus list fields: ${tags.error}`)
    }
  }

  return {
    snapshotId: snapshot.id,
    sourceRevisionId: snapshot.source_revision_id,
    contract: content.contract.id,
    contractVersion: content.contract.version,
    ctaMode: content.ctaMode,
    contentHash: content.contentHash,
    problems,
    missingFields,
    checklist: templateChecklist(content.contract, content.ctaMode),
  }
}
