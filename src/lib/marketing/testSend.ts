import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignTestSendRow, CampaignTestSendTables } from '@/lib/db/campaignTestSendTypes'
import type { CampaignRow, Database } from '@/lib/db/types'

import { assessContent, ContentResolutionError, resolveSendContent } from './campaignContent'
import { BOOKING_URL_MERGE_FIELD } from './mergeFields'
import type { CampaignProvider, SendOutcome } from './providers/types'
import { stripReservedFields, type CtaMode } from './templateContracts'

/**
 * Test sends (UX plan P0.2): a campaign's CURRENT content, through its automation, to one
 * allowlisted test recipient.
 *
 * Not a delivery. It never reads or writes campaign_runs, campaign_sends or bookings,
 * never changes the campaign's status or approval, and is recorded only in
 * campaign_test_sends (rate limited to 5 per campaign per hour by the database).
 *
 *   recipient   only an address in CAMPAIGN_TEST_RECIPIENTS — never one typed in the
 *               browser. Only that address's provider contact is written.
 *   fields      the content fields only (legacy merge fields or the Studio snapshot's),
 *               reserved fields stripped. Consent fields (PrefsUrl, Newsletter, Courses)
 *               and the list status are never sent, so no real contact's consent changes.
 *   booking     no booking is ever created. A booking email gets BookingUrl pointing at
 *               `/book/test-send-preview`, which matches no booking and shows the
 *               "link not valid" page: clearly a test, never bookable.
 *   bracket     the record is written 'pending' before the provider is contacted and
 *               settled after, exactly once.
 */

export const TEST_BOOKING_TOKEN = 'test-send-preview'
const MAX_RECIPIENTS = 20
const EMAIL = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/

type Db = SupabaseClient<Database>

/** Just enough of a Database for the new table until it is wired into `Database`. */
type TestSendDatabase = {
  public: {
    Tables: CampaignTestSendTables
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

function testSends(db: Db) {
  return (db as unknown as SupabaseClient<TestSendDatabase>).from('campaign_test_sends')
}

/** The allowlist from CAMPAIGN_TEST_RECIPIENTS: valid, lowercased, de-duplicated. Empty = feature off. */
export function readTestRecipients(env: Record<string, string | undefined> = process.env): string[] {
  const seen = new Set<string>()
  for (const entry of (env.CAMPAIGN_TEST_RECIPIENTS ?? '').split(',')) {
    const email = entry.trim().toLowerCase()
    if (EMAIL.test(email) && email.length <= 254) seen.add(email)
  }
  return [...seen].slice(0, MAX_RECIPIENTS)
}

export type TestSendSummary = Pick<
  CampaignTestSendRow,
  'id' | 'revision' | 'content_hash' | 'cta_mode' | 'recipient' | 'outcome' | 'error' | 'created_at' | 'completed_at'
>

const SUMMARY_COLUMNS = 'id, revision, content_hash, cta_mode, recipient, outcome, error, created_at, completed_at'

export async function listTestSends(db: Db, campaignId: string, limit = 10): Promise<TestSendSummary[]> {
  const { data, error } = await testSends(db)
    .select(SUMMARY_COLUMNS)
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`Could not read test sends: ${error.message}`)
  return Array.isArray(data) ? (data as TestSendSummary[]) : []
}

export type TestStatus = {
  /** The latest test that reached the provider, whatever revision it was. */
  lastSuccessful: TestSendSummary | null
  /** Whether that test is of the campaign's current revision (and snapshot hash). */
  currentRevisionTested: boolean
}

/** Informational: has the content as it is now been test-sent successfully? */
export async function readTestStatus(
  db: Db,
  campaign: Pick<CampaignRow, 'id' | 'revision'>,
  currentHash: string | null = null
): Promise<TestStatus> {
  const { data, error } = await testSends(db)
    .select(SUMMARY_COLUMNS)
    .eq('campaign_id', campaign.id)
    .eq('outcome', 'sent')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Could not read test sends: ${error.message}`)

  const row = data && typeof (data as TestSendSummary).revision === 'number' ? (data as TestSendSummary) : null
  const tested = row !== null && row.revision === campaign.revision && (row.content_hash ?? null) === currentHash
  return { lastSuccessful: row, currentRevisionTested: tested }
}

export type TestSendOutcome =
  | { kind: 'done'; testSend: TestSendSummary; note: string | null }
  | { kind: 'bad_request' | 'not_found' | 'conflict' | 'rate_limited'; message: string }

type TestSendOptions = {
  recipient: string
  /** The revision the operator is looking at; the database refuses if it moved on. */
  revision: number
  allowlist: readonly string[]
  provider: CampaignProvider
  /** Origin for the test booking link; without it a booking email's link is omitted. */
  baseUrl: string | null
}

function describeFailure(outcome: Extract<SendOutcome, { ok: false }>): { outcome: 'failed' | 'uncertain'; error: string } {
  if (outcome.ambiguous) return { outcome: 'uncertain', error: outcome.error }
  return { outcome: 'failed', error: outcome.retryable ? `${outcome.error} Try again in a moment.` : outcome.error }
}

async function settle(db: Db, id: string, patch: { outcome: 'sent' | 'failed' | 'uncertain'; error?: string | null; provider_reference?: string | null }) {
  const { data, error } = await testSends(db)
    .update({ outcome: patch.outcome, error: patch.error?.slice(0, 1000) ?? null, provider_reference: patch.provider_reference ?? null })
    .eq('id', id)
    .eq('outcome', 'pending')
    .select(SUMMARY_COLUMNS)
    .single()
  if (error) throw new Error(`Could not record the test send outcome: ${error.message}`)
  return data as TestSendSummary
}

function testFields(fields: Record<string, string>, ctaMode: CtaMode, baseUrl: string | null): { fields: Record<string, string>; note: string | null } {
  const content = stripReservedFields(fields)
  if (ctaMode !== 'booking') return { fields: content, note: null }
  if (!baseUrl) {
    return { fields: content, note: 'The booking button has no link in this test: set NEXT_PUBLIC_APP_URL to include a test link.' }
  }
  return {
    fields: { ...content, [BOOKING_URL_MERGE_FIELD]: `${baseUrl.replace(/\/$/, '')}/book/${TEST_BOOKING_TOKEN}` },
    note: 'The booking button opens a test link that cannot book; recipients get their own link in a real send.',
  }
}

export async function sendCampaignTest(db: Db, campaignId: string, options: TestSendOptions): Promise<TestSendOutcome> {
  const recipient = options.recipient.trim().toLowerCase()
  if (!options.allowlist.includes(recipient)) {
    return { kind: 'bad_request', message: 'Choose one of the configured test recipients.' }
  }

  const { data, error } = await db
    .from('campaigns')
    .select('id, revision, provider_automation_id, merge_fields, content_snapshot_id, archived_at, removed_at')
    .eq('id', campaignId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const campaign = data as (Pick<CampaignRow, 'id' | 'revision' | 'provider_automation_id' | 'merge_fields' | 'archived_at' | 'removed_at'> & { content_snapshot_id: string | null }) | null
  if (!campaign || campaign.removed_at) return { kind: 'not_found', message: 'Campaign not found.' }
  if (campaign.archived_at) return { kind: 'conflict', message: 'This campaign is archived. Restore it before testing it.' }
  if (!campaign.provider_automation_id?.trim()) return { kind: 'conflict', message: 'Connect an EmailOctopus template before sending a test.' }
  if (campaign.revision !== options.revision) {
    return { kind: 'conflict', message: 'This campaign changed since you opened it. Reload and test the current version.' }
  }

  let content
  try {
    content = await resolveSendContent(db, campaign)
  } catch (resolveError) {
    if (resolveError instanceof ContentResolutionError) return { kind: 'conflict', message: resolveError.message }
    throw resolveError
  }
  // Content must be valid to be worth testing. The dynamic-fields flag is not applied:
  // testing to an allowlisted address is how that mode gets validated (provider matrix).
  const problems = assessContent(content, { dynamicEnabled: true })
  if (problems.length > 0) return { kind: 'conflict', message: problems.join(' ') }

  const { fields, note } = testFields(content.fields, content.ctaMode, options.baseUrl)

  const { data: inserted, error: insertError } = await testSends(db)
    .insert({ campaign_id: campaign.id, revision: options.revision, recipient })
    .select('id')
    .single()
  if (insertError?.code === 'CRM09') return { kind: 'rate_limited', message: insertError.message }
  if (insertError?.code === 'CRM06') return { kind: 'conflict', message: insertError.message }
  if (insertError) throw new Error(`Could not record the test send: ${insertError.message}`)
  const id = (inserted as { id: string }).id

  if (Object.keys(fields).length > 0) {
    const written = await options.provider.setContactFields(recipient, fields)
    if (!written.ok) {
      const failure = describeFailure(written)
      // A field write that may have landed has still not queued anything: failed.
      return { kind: 'done', testSend: await settle(db, id, { outcome: 'failed', error: failure.error }), note }
    }
  }

  const queued = await options.provider.triggerSend({ campaignHandle: campaign.provider_automation_id, email: recipient, firstName: '', lastName: '' })
  const testSend = queued.ok
    ? await settle(db, id, { outcome: 'sent', provider_reference: queued.reference })
    : await settle(db, id, describeFailure(queued))

  return { kind: 'done', testSend, note }
}
