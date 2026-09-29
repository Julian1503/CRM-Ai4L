/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { runJobs } from './runJobs'

const mockOutbox = jest.fn()
const mockAdvance = jest.fn()

jest.mock('@/lib/consent/outbox', () => ({
  processConsentOutbox: (...args: unknown[]) => mockOutbox(...args),
}))
jest.mock('@/lib/marketing/dispatch', () => ({
  advanceCampaignSend: (...args: unknown[]) => mockAdvance(...args),
}))

const credentials = { apiKey: 'k', listId: 'l' }

function progress(pending: number, claimed = 10) {
  return {
    kind: 'progress',
    status: pending > 0 ? 'sending' : 'sent',
    progress: { total: claimed },
    summary: { sent: 10, pending },
  }
}

function setup(sending: Array<{ id: string }> = []) {
  const campaigns = createQueryBuilderMock({ data: sending, error: null })
  return { db: createDbMock(campaigns) as never, campaigns }
}

describe('runJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockOutbox.mockResolvedValue({ claimed: 0, synced: 0, failed: 0 })
  })

  it('drains the consent outbox in batches until it is empty', async () => {
    mockOutbox
      .mockResolvedValueOnce({ claimed: 100, synced: 100, failed: 0 })
      .mockResolvedValueOnce({ claimed: 7, synced: 6, failed: 1 })

    const report = await runJobs({ ...setup(), credentials, baseUrl: 'https://crm', preferencesOrigin: null, budgetMs: 60_000 })

    expect(mockOutbox).toHaveBeenCalledTimes(2)
    expect(report.consent).toMatchObject({ claimed: 107, synced: 106, failed: 1, batches: 2 })
  })

  it('resumes every campaign left sending until it has nothing pending', async () => {
    mockAdvance.mockResolvedValueOnce(progress(5)).mockResolvedValueOnce(progress(0))

    const report = await runJobs({ ...setup([{ id: 'camp-1' }]), credentials, baseUrl: 'https://crm', preferencesOrigin: null, budgetMs: 60_000 })

    expect(mockAdvance).toHaveBeenCalledTimes(2)
    expect(mockAdvance).toHaveBeenCalledWith(expect.anything(), 'camp-1', expect.objectContaining({ baseUrl: 'https://crm' }))
    expect(report.campaigns).toEqual([{ id: 'camp-1', outcome: 'sent', sent: 10, pending: 0 }])
  })

  it('stops looping on a campaign whose chunk claimed nothing (leases or reconciliation pending)', async () => {
    mockAdvance.mockResolvedValue(progress(3, 0))

    await runJobs({ ...setup([{ id: 'camp-1' }]), credentials, baseUrl: 'https://crm', preferencesOrigin: null, budgetMs: 60_000 })

    expect(mockAdvance).toHaveBeenCalledTimes(1)
  })

  it('does not attempt sends without provider credentials or an app origin', async () => {
    const { db, campaigns } = setup([{ id: 'camp-1' }])

    await runJobs({ db, credentials: null, baseUrl: null, preferencesOrigin: null, budgetMs: 60_000 })

    expect(campaigns.calls).toHaveLength(0)
    expect(mockAdvance).not.toHaveBeenCalled()
  })

  it('returns when the budget is spent and says so', async () => {
    let clock = 0
    mockAdvance.mockImplementation(async () => {
      clock += 30_000
      return progress(100)
    })

    const report = await runJobs({
      ...setup([{ id: 'camp-1' }]),
      credentials,
      baseUrl: 'https://crm',
      preferencesOrigin: null,
      budgetMs: 60_000,
      now: () => clock,
    })

    expect(mockAdvance).toHaveBeenCalledTimes(2)
    expect(report.stoppedForBudget).toBe(true)
  })
})
