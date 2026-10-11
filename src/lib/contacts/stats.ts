import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * The dashboard counters, counted by the database over active (not archived) contacts.
 *
 * Definitions (UX plan P3.1):
 *   total       every active contact
 *   leads       status = lead      (not yet qualified)
 *   prospects   status = prospect  (qualified, not yet a customer)
 *   customers   status = customer
 *   newsletter  consent to the newsletter stream
 *   programs    consent to courses and training (overlaps the newsletter figure)
 *
 * Each status is counted rather than derived: "prospects = total − customers" counted
 * every lead as a prospect. The customer share shown on the dashboard is customers / total.
 *
 * Any failed count rejects the whole result (audit M2): a dashboard that cannot count
 * must say so, never show a zero it did not measure.
 */

export type ContactStats = {
  total: number
  leads: number
  prospects: number
  customers: number
  newsletter: number
  programs: number
}

type CountResult = { count: number | null; error: { message: string } | null }

function counted(result: CountResult, label: string): number {
  if (result.error) throw new Error(`Could not count ${label}: ${result.error.message}`)
  if (typeof result.count !== 'number') throw new Error(`Could not count ${label}: no count returned.`)
  return result.count
}

export async function fetchContactStats(db: SupabaseClient<Database>): Promise<ContactStats> {
  const head = { count: 'exact' as const, head: true }
  const base = () => db.from('active_contacts').select('id', head)

  const [total, leads, prospects, customers, newsletter, programs] = await Promise.all([
    base(),
    base().eq('status', 'lead'),
    base().eq('status', 'prospect'),
    base().eq('status', 'customer'),
    base().eq('subscribed_to_newsletter', true),
    base().eq('subscribed_to_programs', true),
  ])

  return {
    total: counted(total, 'contacts'),
    leads: counted(leads, 'leads'),
    prospects: counted(prospects, 'prospects'),
    customers: counted(customers, 'customers'),
    newsletter: counted(newsletter, 'newsletter subscribers'),
    programs: counted(programs, 'course subscribers'),
  }
}

/** customers / total as a whole percentage; 0 for an empty database. */
export function customerShare(stats: Pick<ContactStats, 'total' | 'customers'>): number {
  return stats.total > 0 ? Math.round((stats.customers / stats.total) * 100) : 0
}
