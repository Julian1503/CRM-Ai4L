import type { SupabaseClient } from '@supabase/supabase-js'

import { providerContactFields, providerStatus } from '@/lib/contacts/providerSync'
import type { Database } from '@/lib/db/types'
import { syncContactToEmailOctopus } from '@/lib/emailOctopus'
import type { EmailOctopusCredentials } from '@/lib/marketing/providers/credentials'

/**
 * Consent outbox worker (audit H5).
 *
 * Entries are written by a contacts trigger in the same transaction as the consent
 * change (20261003010000_consent_outbox.sql), so nothing committed can be lost. This
 * drains them: for each claimed contact it pushes the contact's CURRENT state and
 * settles every entry at or below that state's version. A delayed or replayed entry
 * therefore cannot re-subscribe somebody who has since withdrawn.
 *
 * Runs inline after a consent change (best effort, for immediacy) and from the
 * scheduled worker (the guarantee). Both are safe at once: claims are atomic and one
 * contact is only ever in flight once.
 */

export type ConsentSyncResult = {
  claimed: number
  synced: number
  failed: number
  /** True when EmailOctopus is not configured; entries stay queued, nothing is lost. */
  notConfigured?: boolean
}

type ClaimedConsentSync = {
  outbox_id: string
  claim_token: string
  contact_id: string
  state_version: number
  email: string | null
  first_name: string | null
  last_name: string | null
  newsletter: boolean
  programs: boolean
}

type Push = (state: ClaimedConsentSync) => Promise<void>

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{
  data: unknown
  error: { message: string } | null
}>

export async function processConsentOutbox(
  db: SupabaseClient<Database>,
  options: {
    credentials: EmailOctopusCredentials | null
    /** Origin for preference links, or null when they cannot be signed. */
    origin: string | null
    limit?: number
    /** Only this contact's entries — used inline right after a change. */
    contactId?: string
    /** Injected in tests. */
    push?: Push
  }
): Promise<ConsentSyncResult> {
  if (!options.credentials && !options.push) {
    return { claimed: 0, synced: 0, failed: 0, notConfigured: true }
  }

  const rpc = db.rpc.bind(db) as unknown as Rpc
  const { data, error } = await rpc('claim_consent_sync', {
    p_limit: options.limit ?? 50,
    p_contact_id: options.contactId ?? null,
  })
  if (error) throw new Error(`Could not claim consent changes: ${error.message}`)

  const credentials = options.credentials
  const push: Push =
    options.push ??
    (async (state) => {
      if (!credentials || !state.email) return
      const contact = {
        id: state.contact_id,
        email: state.email,
        firstName: state.first_name ?? '',
        lastName: state.last_name ?? '',
        subscribedToNewsletter: state.newsletter,
        subscribedToPrograms: state.programs,
      }
      await syncContactToEmailOctopus(
        credentials.apiKey,
        credentials.listId,
        contact.email,
        contact.firstName,
        contact.lastName,
        providerStatus(contact),
        { fields: providerContactFields(contact, options.origin) }
      )
    })

  const claimed = (data ?? []) as ClaimedConsentSync[]
  const result: ConsentSyncResult = { claimed: claimed.length, synced: 0, failed: 0 }

  for (const state of claimed) {
    let pushError: string | null = null
    try {
      await push(state)
    } catch (caught) {
      pushError = caught instanceof Error ? caught.message : 'Provider request failed.'
    }

    const { error: completeError } = await rpc('complete_consent_sync', {
      p_outbox_id: state.outbox_id,
      p_token: state.claim_token,
      p_state_version: state.state_version,
      p_ok: pushError === null,
      p_error: pushError,
    })
    // Not fatal to the batch: the entry stays claimed until its lease expires and is
    // then retried, and pushing current state again is harmless.
    if (completeError) console.error('Could not settle a consent sync entry:', completeError.message)

    if (pushError === null) result.synced += 1
    else result.failed += 1
  }

  return result
}
