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
const mockApplyCalendly = jest.fn()
jest.mock('@/lib/booking/calendly', () => ({
  ...jest.requireActual('@/lib/booking/calendly'),
  applyCalendlyEvent: (...args: unknown[]) => mockApplyCalendly(...args),
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

function setup(sending: Array<{ id: string; content_snapshot_id?: string | null }> = []) {
  const campaigns = createQueryBuilderMock({ data: sending, error: null })
  // Parked Calendly events: none, so step 3 reads and moves on.
  const reconciliation = createQueryBuilderMock({ data: [], error: null })
  const db = createDbMock((table: string) => (table === 'campaigns' ? campaigns : reconciliation))
  return { db: db as never, campaigns }
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

  it('recovers expired Content Studio leases once per run, after the other priorities', async () => {
    const { db } = setup()
    const rpc = (db as unknown as { rpc: jest.Mock }).rpc
    rpc.mockImplementation(async (name: string) => (name === 'recover_content_jobs' ? { data: 2, error: null } : { data: null, error: null }))

    const report = await runJobs({ db, credentials, baseUrl: 'https://crm', preferencesOrigin: null, budgetMs: 60_000 })

    expect(rpc.mock.calls.filter(([name]) => name === 'recover_content_jobs')).toHaveLength(1)
    expect(report.content).toEqual({ recovered: 2 })
  })

  it('surfaces a failed content lease recovery instead of swallowing it', async () => {
    const { db } = setup()
    const rpc = (db as unknown as { rpc: jest.Mock }).rpc
    rpc.mockImplementation(async (name: string) =>
      name === 'recover_content_jobs' ? { data: null, error: { message: 'boom' } } : { data: null, error: null },
    )

    await expect(runJobs({ db, credentials, baseUrl: 'https://crm', preferencesOrigin: null, budgetMs: 60_000 })).rejects.toThrow(
      'Could not recover content jobs: boom',
    )
  })

  it('replays a parked reschedule cancellation as a reschedule, not as a cancellation', async () => {
    mockApplyCalendly.mockResolvedValue('applied')
    const parked = createQueryBuilderMock({
      data: [
        {
          event_type: 'invitee.canceled', invitee_uri: 'inv-old', event_uri: null, email: 'a@b.test',
          scheduled_at: null, tracking_booking_id: null, old_invitee_uri: null, rescheduled: true,
        },
        {
          event_type: 'invitee.canceled', invitee_uri: 'inv-2', event_uri: null, email: 'c@d.test',
          scheduled_at: null, tracking_booking_id: null, old_invitee_uri: null, rescheduled: null,
        },
      ],
      error: null,
    })
    const campaigns = createQueryBuilderMock({ data: [], error: null })
    const db = createDbMock((table: string) => (table === 'campaigns' ? campaigns : parked)) as never

    const report = await runJobs({ db, credentials: null, baseUrl: 'https://crm', preferencesOrigin: null, budgetMs: 60_000 })

    expect(parked.argsFor('select')?.[0]).toContain('rescheduled')
    expect(mockApplyCalendly.mock.calls[0][1]).toMatchObject({ inviteeUri: 'inv-old', rescheduled: true })
    expect(mockApplyCalendly.mock.calls[1][1]).toMatchObject({ inviteeUri: 'inv-2', rescheduled: false })
    expect(report.reconciliation).toMatchObject({ retried: 2, resolved: 2 })
  })

  it('does not attempt sends without provider credentials', async () => {
    const { db, campaigns } = setup([{ id: 'camp-1' }])

    await runJobs({ db, credentials: null, baseUrl: 'https://crm', preferencesOrigin: null, budgetMs: 60_000 })

    expect(campaigns.calls).toHaveLength(0)
    expect(mockAdvance).not.toHaveBeenCalled()
  })

  it('without an app origin, sends only Studio campaigns (their CTA may not book)', async () => {
    mockAdvance.mockResolvedValue(progress(0))
    const { db } = setup([{ id: 'legacy-1', content_snapshot_id: null }, { id: 'studio-1', content_snapshot_id: 'snap-1' }])

    await runJobs({ db, credentials, baseUrl: null, preferencesOrigin: null, budgetMs: 60_000 })

    expect(mockAdvance).toHaveBeenCalledTimes(1)
    expect(mockAdvance).toHaveBeenCalledWith(expect.anything(), 'studio-1', expect.objectContaining({ baseUrl: null }))
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
