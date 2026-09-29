/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

import { advanceCampaignSend } from './dispatch'
import { AudienceTooLargeError } from './runs'

const mockPrepare = jest.fn()
const mockExecute = jest.fn()
const mockSummary = jest.fn()

jest.mock('./runs', () => {
  const actual = jest.requireActual('./runs')
  return { ...actual, prepareCampaignRun: (...args: unknown[]) => mockPrepare(...args) }
})
jest.mock('./send', () => ({ executeCampaignSends: (...args: unknown[]) => mockExecute(...args) }))
jest.mock('./sendStatus', () => ({ readCampaignSendSummary: (...args: unknown[]) => mockSummary(...args) }))

const approved = {
  id: 'camp-1',
  status: 'approved',
  segment_id: 'seg-1',
  provider_automation_id: 'auto-1',
  revision: 4,
  approved_revision: 4,
  send_run: 1,
  archived_at: null,
  removed_at: null,
  merge_fields: {},
  consent_stream: 'newsletter',
}

const options = { credentials: { apiKey: 'k', listId: 'l' }, baseUrl: 'https://crm', chunkSize: 50, provider: {} as never }
const progress = { total: 2, sent: 2, failed: 0, skipped: 0, uncertain: 0, remaining: 0, lost: 0 }

function summary(overrides: Record<string, number> = {}) {
  return { run: 1, total: 2, sent: 2, failed: 0, pending: 0, processing: 0, skipped: 0, uncertain: 0, failureReason: null, stallReason: null, ...overrides }
}

function setup(campaign: unknown, transitions: unknown[] = [{ data: { id: 'camp-1' }, error: null }]) {
  const campaigns = createQueryBuilderMock([{ data: campaign, error: null }, ...transitions, { data: null, error: null }])
  const sends = createQueryBuilderMock({ data: null, error: null })
  const db = createDbMock((table: string) => (table === 'campaigns' ? campaigns : sends))
  return { db: db as never, campaigns, sends }
}

function updates(builder: QueryBuilderMock) {
  return builder.allFor('update').map((call) => call.args[0])
}

describe('advanceCampaignSend', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrepare.mockResolvedValue({ audience_status: 'prepared' })
    mockExecute.mockResolvedValue(progress)
    mockSummary.mockResolvedValue(summary())
  })

  it.each([
    ['a missing campaign', null, 'not_found'],
    ['a removed campaign', { ...approved, removed_at: 'x' }, 'not_found'],
    ['an archived campaign', { ...approved, archived_at: 'x' }, 'conflict'],
    ['a draft', { ...approved, status: 'draft' }, 'conflict'],
    ['a campaign with no segment', { ...approved, segment_id: null }, 'conflict'],
    ['a campaign with no automation', { ...approved, provider_automation_id: ' ' }, 'conflict'],
    ['content changed after approval (H6)', { ...approved, revision: 5 }, 'conflict'],
  ])('refuses %s', async (_label, campaign, kind) => {
    const { db } = setup(campaign)

    expect((await advanceCampaignSend(db, 'camp-1', options)).kind).toBe(kind)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('prepares the run, requeues failed rows, then claims approved -> sending on the same revision', async () => {
    const { db, campaigns, sends } = setup(approved)

    const outcome = await advanceCampaignSend(db, 'camp-1', options)

    expect(mockPrepare).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'camp-1', revision: 4 }))
    expect(updates(sends)[0]).toMatchObject({ status: 'pending', provider_attempted_at: null })
    expect(sends.allFor('eq')).toContainEqual({ method: 'eq', args: ['status', 'failed'] })
    expect(updates(campaigns)[0]).toMatchObject({ status: 'sending' })
    expect(campaigns.allFor('eq')).toContainEqual({ method: 'eq', args: ['revision', 4] })
    expect(outcome).toMatchObject({ kind: 'progress', status: 'sent' })
  })

  it('retries a failed campaign under its original approval', async () => {
    const { db, campaigns } = setup({ ...approved, status: 'failed' }, [
      { data: { id: 'camp-1' }, error: null },
      { data: { id: 'camp-1' }, error: null },
    ])

    await advanceCampaignSend(db, 'camp-1', options)

    expect(updates(campaigns).slice(0, 2)).toEqual([
      expect.objectContaining({ status: 'approved' }),
      expect.objectContaining({ status: 'sending' }),
    ])
  })

  it('reports a lost race for the retry claim as a conflict', async () => {
    const { db } = setup({ ...approved, status: 'failed' }, [{ data: null, error: null }])

    expect(await advanceCampaignSend(db, 'camp-1', options)).toMatchObject({ kind: 'conflict' })
  })

  it('treats the database refusing a changed revision as a conflict', async () => {
    const { db } = setup(approved, [{ data: null, error: { code: 'CRM04', message: 'changed' } }])

    expect(await advanceCampaignSend(db, 'camp-1', options)).toMatchObject({ kind: 'conflict' })
  })

  it('explains an oversized audience instead of sending to part of it (H7)', async () => {
    mockPrepare.mockRejectedValue(new AudienceTooLargeError(12_000))
    const { db } = setup(approved)

    const outcome = await advanceCampaignSend(db, 'camp-1', options)

    expect(outcome).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/12,000/) })
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('explains an empty audience', async () => {
    mockPrepare.mockRejectedValue(new Error('This segment currently matches no subscribed contacts.'))
    const { db } = setup(approved)

    expect(await advanceCampaignSend(db, 'camp-1', options)).toMatchObject({ kind: 'conflict' })
  })

  it('rethrows an unexpected preparation failure', async () => {
    mockPrepare.mockRejectedValue(new Error('connection lost'))
    const { db } = setup(approved)

    await expect(advanceCampaignSend(db, 'camp-1', options)).rejects.toThrow('connection lost')
  })

  it('continues a sending campaign without preparing again', async () => {
    mockSummary.mockResolvedValue(summary({ pending: 5 }))
    const { db } = setup({ ...approved, status: 'sending' })

    const outcome = await advanceCampaignSend(db, 'camp-1', options)

    expect(mockPrepare).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'progress', status: 'sending' })
  })

  it.each([
    ['failures', { failed: 1 }],
    ['uncertain recipients', { uncertain: 1 }],
  ])('finishes failed, not sent, when %s remain', async (_label, counts) => {
    mockSummary.mockResolvedValue(summary(counts))
    const { db } = setup({ ...approved, status: 'sending' })

    expect(await advanceCampaignSend(db, 'camp-1', options)).toMatchObject({ status: 'failed' })
  })

  it('surfaces a load failure', async () => {
    const campaigns = createQueryBuilderMock({ data: null, error: { message: 'boom' } })
    await expect(advanceCampaignSend(createDbMock(campaigns) as never, 'camp-1', options)).rejects.toThrow('boom')
  })
})
