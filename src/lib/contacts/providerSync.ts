import type { SubscriptionStatus } from '@/lib/emailOctopus'
import { CONSENT_STATE_MERGE_FIELDS, PREFERENCES_URL_MERGE_FIELD } from '@/lib/marketing/mergeFields'
import { preferencesUrl } from '@/lib/preferences/token'

/**
 * What the CRM tells EmailOctopus about one contact. Shared by the manual full sync and
 * the consent outbox worker, so both push exactly the same shape.
 */

export type ProviderContactState = {
  /** Needed to sign the preference link. */
  id?: string
  email: string
  firstName?: string
  lastName?: string
  subscribedToNewsletter?: boolean
  subscribedToPrograms?: boolean
}

const [NEWSLETTER_FIELD, COURSES_FIELD] = CONSENT_STATE_MERGE_FIELDS

/**
 * The provider list status answers the broader question — may we email this person at
 * all? A contact who takes courses but not the newsletter must stay SUBSCRIBED, or
 * EmailOctopus refuses to queue the course automation for them. The two consents are
 * told apart on our side, where the campaign's own stream gates the audience.
 */
export function providerStatus(contact: ProviderContactState): SubscriptionStatus {
  return contact.subscribedToNewsletter || contact.subscribedToPrograms ? 'SUBSCRIBED' : 'UNSUBSCRIBED'
}

/**
 * The custom fields written with every contact.
 *
 * `Newsletter` / `Courses` record which consent the contact holds, so a newsletter sent
 * from the EmailOctopus dashboard can be segmented on it. `PrefsUrl` is their permanent
 * preference-centre link, so any template can carry a working unsubscribe. The link is
 * omitted rather than faked when it cannot be signed.
 */
export function providerContactFields(
  contact: ProviderContactState,
  origin: string | null
): Record<string, string> {
  const fields: Record<string, string> = {
    [NEWSLETTER_FIELD]: contact.subscribedToNewsletter ? 'yes' : 'no',
    [COURSES_FIELD]: contact.subscribedToPrograms ? 'yes' : 'no',
  }

  if (contact.id && origin) {
    fields[PREFERENCES_URL_MERGE_FIELD] = preferencesUrl(origin, contact.id)
  }

  return fields
}

/**
 * Where preference links should point, or null when they cannot be signed.
 *
 * A missing PREFERENCES_SECRET is a deployment fault: logged, and the field skipped
 * rather than aborting a sync that is otherwise correct.
 */
export function preferencesOrigin(fallbackOrigin: string | null): string | null {
  try {
    // Signing a throwaway id is the cheapest way to ask "is the secret configured".
    preferencesUrl('https://example.invalid', '00000000-0000-4000-8000-000000000000')
  } catch (error) {
    console.error('Preference links are not configured, syncing without them:', error)
    return null
  }

  return process.env.NEXT_PUBLIC_APP_URL?.trim() || fallbackOrigin
}
