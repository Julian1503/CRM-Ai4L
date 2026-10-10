/**
 * Database types for campaign test sends (20261008010000_campaign_test_sends.sql).
 * Wired into `Database` in src/lib/db/types.ts.
 */

export type CampaignTestSendOutcome = 'pending' | 'sent' | 'failed' | 'uncertain'

export type CampaignTestSendRow = {
  id: string
  campaign_id: string
  /** Stamped by the database from the campaign; an insert naming another revision is refused. */
  revision: number
  content_snapshot_id: string | null
  content_hash: string | null
  cta_mode: 'booking' | 'external_url' | 'none'
  provider_automation_id: string | null
  /** Lowercased; always one of CAMPAIGN_TEST_RECIPIENTS when written by the API. */
  recipient: string
  outcome: CampaignTestSendOutcome
  provider_reference: string | null
  error: string | null
  actor_id: string | null
  created_at: string
  completed_at: string | null
}

type Table<Row, Insert> = { Row: Row; Insert: Insert; Update: Partial<Row>; Relationships: [] }

export type CampaignTestSendTables = {
  campaign_test_sends: Table<
    CampaignTestSendRow,
    Pick<CampaignTestSendRow, 'campaign_id' | 'revision' | 'recipient'> & Partial<CampaignTestSendRow>
  >
}
