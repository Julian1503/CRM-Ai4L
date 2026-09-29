/**
 * @jest-environment node
 */
import { MAX_SUMMARY_BATCH, readCampaignSendSummaries, readCampaignSendSummary } from './sendStatus'

function row(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: 'camp-1',
    run: 2,
    pending: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    uncertain: 0,
    failure_reason: null,
    stall_reason: null,
    ...overrides,
  }
}

function db(rows: unknown[] | null, error: { message: string } | null = null) {
  return { rpc: jest.fn(async () => ({ data: rows, error })) }
}

describe('readCampaignSendSummaries', () => {
  it('reads a whole page of campaigns in one call (audit A2)', async () => {
    const client = db([row(), row({ campaign_id: 'camp-2', sent: 3 })])

    const summaries = await readCampaignSendSummaries(client as never, ['camp-1', 'camp-2', 'camp-1'])

    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('campaign_send_summaries', { p_campaign_ids: ['camp-1', 'camp-2'] })
    expect(summaries.get('camp-2')?.sent).toBe(3)
  })

  it('makes no call for an empty page', async () => {
    const client = db([])
    expect((await readCampaignSendSummaries(client as never, [])).size).toBe(0)
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('refuses an unbounded batch', async () => {
    const ids = Array.from({ length: MAX_SUMMARY_BATCH + 1 }, (_, index) => `c${index}`)
    await expect(readCampaignSendSummaries(db([]) as never, ids)).rejects.toThrow(/At most/)
  })

  it('surfaces a read failure', async () => {
    await expect(readCampaignSendSummaries(db(null, { message: 'boom' }) as never, ['camp-1'])).rejects.toThrow(/boom/)
  })
})

describe('readCampaignSendSummary', () => {
  it('counts claimed recipients as still pending and keeps skipped and uncertain separate', async () => {
    const summary = await readCampaignSendSummary(
      db([row({ pending: 2, processing: 1, sent: 5, failed: 1, skipped: 4, uncertain: 2 })]) as never,
      'camp-1'
    )

    expect(summary).toMatchObject({
      run: 2,
      pending: 3,
      processing: 1,
      sent: 5,
      failed: 1,
      skipped: 4,
      uncertain: 2,
      total: 15,
    })
  })

  it('reports a failure reason only when something failed', async () => {
    const withFailure = await readCampaignSendSummary(
      db([row({ failed: 1, failure_reason: 'Automation not found.' })]) as never,
      'camp-1'
    )
    const withoutFailure = await readCampaignSendSummary(
      db([row({ sent: 1, failure_reason: 'stale' })]) as never,
      'camp-1'
    )

    expect(withFailure.failureReason).toBe('Automation not found.')
    expect(withoutFailure.failureReason).toBeNull()
  })

  it('explains why work is stalled or uncertain', async () => {
    const summary = await readCampaignSendSummary(
      db([row({ uncertain: 1, stall_reason: 'No reply from EmailOctopus' })]) as never,
      'camp-1'
    )

    expect(summary.stallReason).toBe('No reply from EmailOctopus')
  })

  it('says when the campaign does not exist', async () => {
    await expect(readCampaignSendSummary(db([]) as never, 'nope')).rejects.toThrow('Campaign not found.')
  })
})
