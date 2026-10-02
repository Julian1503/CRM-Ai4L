import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContentAssetRow, ContentVariantRevisionRow, Database } from '@/lib/db/types'
import { getAdminClient } from '@/lib/supabase/admin'

import { CONTENT_BUCKETS, displayPath, signDownloads } from './assets'
import { ContentHttpError, throwIfDbError } from './errors'
import { toRevision } from './mappers'
import { composePostText } from './postText'
import type { VariantExport } from './types'

/**
 * What an operator needs to post a variant by hand: the exact text the publisher would
 * post (composePostText) and short-lived download links for its images, in order.
 * Reads go through the member's client; only the URL signing uses the service role.
 */

type Db = SupabaseClient<Database>

async function readCurrentRevision(db: Db, variantId: string): Promise<{ channel: VariantExport['channel']; revision: ContentVariantRevisionRow }> {
  const { data: variant, error } = await db
    .from('content_variants')
    .select('id, channel, current_revision_id')
    .eq('id', variantId)
    .maybeSingle()
  throwIfDbError(error)
  if (!variant) throw new ContentHttpError(404, 'Variant not found.')
  if (!variant.current_revision_id) throw new ContentHttpError(409, 'This variant has no content yet.')

  const { data: revision, error: revisionError } = await db
    .from('content_variant_revisions')
    .select('*')
    .eq('id', variant.current_revision_id)
    .maybeSingle()
  throwIfDbError(revisionError)
  if (!revision) throw new ContentHttpError(404, 'Variant not found.')

  return { channel: variant.channel, revision }
}

export async function exportVariant(db: Db, variantId: string, admin: Db = getAdminClient()): Promise<VariantExport> {
  const { channel, revision } = await readCurrentRevision(db, variantId)
  const refs = [...toRevision(revision, null).assets].sort((a, b) => a.order - b.order)

  const rows: ContentAssetRow[] = []
  if (refs.length > 0) {
    const { data, error } = await db.from('content_assets').select('*').in('id', refs.map((ref) => ref.assetId))
    throwIfDbError(error)
    rows.push(...(data ?? []))
  }

  const pathById = new Map(rows.map((row) => [row.id, displayPath(row)]))
  const paths = [...pathById.values()].filter((path): path is string => path !== null)
  const urls = await signDownloads(admin, CONTENT_BUCKETS.library, paths)

  const assets = refs.flatMap((ref) => {
    const url = urls.get(pathById.get(ref.assetId) ?? '')
    return url ? [{ assetId: ref.assetId, alt: ref.alt, downloadUrl: url }] : []
  })

  return {
    channel,
    revisionId: revision.id,
    text: composePostText(revision.body, revision.call_to_action, revision.hashtags ?? []),
    assets,
  }
}
