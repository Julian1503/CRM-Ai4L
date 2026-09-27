import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Why a template cannot carry a newsletter schedule, or null when it can.
 *
 * The database trigger refuses a non-newsletter template too; checking first turns
 * that into a sentence an operator can act on instead of a raised exception.
 */
export async function newsletterTemplateProblem(
  db: SupabaseClient<Database>,
  templateId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('campaign_templates')
    .select('consent_stream, archived_at, provider_automation_id')
    .eq('id', templateId)
    .maybeSingle()

  if (error) throw new Error(error.message)

  if (!data || data.archived_at) return 'That template does not exist or has been archived.'
  if (data.consent_stream !== 'newsletter') {
    return 'Recurring emails are for the newsletter only. Choose a newsletter template.'
  }
  if (!data.provider_automation_id?.trim()) {
    return 'That template has no EmailOctopus automation, so it could never send.'
  }

  return null
}
