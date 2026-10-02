import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContentBrandProfileRow, Database } from '@/lib/db/types'

import { throwIfDbError } from './errors'
import { toBrandProfile } from './mappers'
import { DEFAULT_BRAND_SLUG, getDefaultBrand } from './repository'
import type { BrandProfile } from './types'
import type { BrandProfileUpdate } from './validation'

/**
 * The AI4L brand profile: voice, approved facts, per-channel CTA rules, hashtag seeds,
 * image direction and the link origins a generated CTA may point at. Every member reads
 * it (the generator is grounded in it); only an administrator changes it, which
 * update_content_brand_profile enforces with is_crm_admin() — so the update must run
 * with the member's own client, never the service role. Omitted keys keep their value.
 */

type Db = SupabaseClient<Database>

export async function getBrandProfile(db: Db): Promise<BrandProfile> {
  return toBrandProfile(await getDefaultBrand(db))
}

export async function updateBrandProfile(db: Db, update: BrandProfileUpdate): Promise<BrandProfile> {
  const { data, error } = await db.rpc('update_content_brand_profile', { p_slug: DEFAULT_BRAND_SLUG, p_profile: update })
  throwIfDbError(error)
  return toBrandProfile(data as unknown as ContentBrandProfileRow)
}
